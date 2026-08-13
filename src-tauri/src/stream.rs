//! Buffered streaming HTTP source (`Read + Seek` over a remote URL).
//!
//! A dedicated fetcher thread downloads ahead of the reader through range
//! requests into an in-memory window. The audio pipeline therefore never does
//! blocking network I/O on the decode path (which caused audible dropouts),
//! and brief network hiccups are absorbed by the read-ahead buffer plus
//! automatic reconnects with backoff.

use std::collections::VecDeque;
use std::io::{self, Read, Seek, SeekFrom};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};

/// User-Agent for fetching the media. Stream URLs are resolved with the
/// ANDROID_VR (Oculus Quest) YouTube client — the only client that still yields
/// directly fetchable URLs (no JS runtime, no signature descrambling, no PO
/// token). googlevideo binds the URL to that client's UA, so the fetch MUST use
/// the same one or it's a 403. Must match ytnative::VR_UA.
pub const YT_UA: &str = "com.google.android.apps.youtube.vr.oculus/1.62.27 (Linux; U; Android 12L; en_US; Quest 3 Build/SQ3A.220605.009.A1) gzip";

/// Fetches a FRESH stream URL for the same track — called when a connection is
/// rejected (403/302), which on Android happens constantly because googlevideo
/// URLs are bound to the IP that resolved them and the phone's IPv6 privacy
/// address rotates. Re-resolving gets a URL valid for the current address.
pub type ReResolve = Arc<dyn Fn() -> Result<String, String> + Send + Sync>;

// Read-ahead window. 8 Mo is still >10 min of audio at the 96 kbps playback cap,
// which is far more than any stall this needs to ride out. It used to be 64 Mo,
// and `VecDeque::with_capacity(CAP)` reserved the whole thing UP FRONT — with a
// preloaded next track that was 128 Mo of resident memory for two audio streams,
// which Android simply kills the app for.
const CAP: usize = 8 * 1024 * 1024;
const BACK: u64 = 1 * 1024 * 1024; // 1 Mo kept behind the reader for small back-seeks (symphonia's moov probes)
const CHUNK: usize = 64 * 1024; // network read size
const STALL: Duration = Duration::from_secs(120); // reader gives up after this
const RETRIES: u32 = 8;
/// End-of-file zone served from a dedicated one-shot buffer. YouTube m4a puts
/// the moov atom at the END: the decoder probe seeks there and back, and
/// dragging the streaming window along cost two full reconnects before any
/// sound came out (the click-to-audio latency on phones and Windows).
const TAIL_SZ: u64 = 512 * 1024;

/// Bytes buffered ahead of the reader, total across the current stream's shared
/// window. The audio thread publishes this so the frontend render a real progress
/// pill ("Loading… N%") instead of faking it from elapsed time.
static LAST_FETCHED: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static LAST_TOTAL: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
pub(crate) fn note_fetched(new_total: u64) {
    LAST_FETCHED.store(new_total, std::sync::atomic::Ordering::Relaxed);
}
pub(crate) fn note_total(len: u64) {
    LAST_TOTAL.store(len, std::sync::atomic::Ordering::Relaxed);
    LAST_FETCHED.store(0, std::sync::atomic::Ordering::Relaxed);
}
pub fn last_fetch_head() -> (u64, u64) {
    (
        LAST_FETCHED.load(std::sync::atomic::Ordering::Relaxed),
        LAST_TOTAL.load(std::sync::atomic::Ordering::Relaxed),
    )
}

struct Shared {
    start: u64, // absolute offset of buf[0]
    buf: VecDeque<u8>,
    target: u64, // reader position the fetcher must serve
    err: Option<String>,
    dead: bool, // reader dropped — fetcher exits
}

pub struct HttpStream {
    len: u64,
    pos: u64,
    shared: Arc<(Mutex<Shared>, Condvar)>,
    url: String,
    rr: Option<ReResolve>,
    tail: Option<Vec<u8>>, // lazily fetched last TAIL_SZ bytes (moov probe)
}

/// googlevideo stream URLs are bound to the IP that resolved them (`ip=` query
/// param). Fetching a v6-bound URL over IPv4 — or vice versa — returns 403/302,
/// and std's resolver ordering means ureq may pick either family. So: pin DNS
/// answers to the same address family as the URL's own `ip=` parameter.
fn url_wants_ipv6(url: &str) -> Option<bool> {
    let q = url.split_once('?')?.1;
    for kv in q.split('&') {
        if let Some(v) = kv.strip_prefix("ip=") {
            return Some(v.contains(':') || v.contains("%3A") || v.contains("%3a"));
        }
    }
    None
}

/// HTTP agent for fetching a media URL — family-pinned when the URL demands it.
/// Also used by the native downloader (ytnative.rs).
pub(crate) fn media_agent(url: &str) -> ureq::Agent {
    let b = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(10))
        .timeout_read(Duration::from_secs(30));
    // On Android we force the whole chain to IPv4 (see ytnative::rp), so fetch
    // the media over IPv4 too — matching the IPv4 the URL was resolved with.
    // Elsewhere, just pin to the family the URL's ip= demands.
    let want_v6 = if cfg!(target_os = "android") { Some(false) } else { url_wants_ipv6(url) };
    let b = match want_v6 {
        Some(want_v6) => b.resolver(move |netloc: &str| -> io::Result<Vec<std::net::SocketAddr>> {
            use std::net::ToSocketAddrs;
            let all: Vec<_> = netloc.to_socket_addrs()?.collect();
            let picked: Vec<_> = all.iter().copied().filter(|a| a.is_ipv6() == want_v6).collect();
            Ok(if picked.is_empty() { all } else { picked })
        }),
        None => b,
    };
    b.build()
}

/// Connect at `pos`; on failure (typically a 403 from a rotated IP) ask the
/// re-resolver for a fresh URL and try once more, updating `url` in place so all
/// later reads use the working link.
fn connect_rr(
    url: &mut String,
    pos: u64,
    len: u64,
    rr: &Option<ReResolve>,
) -> Result<(Box<dyn Read + Send>, Option<u64>), String> {
    match connect(url, pos, len) {
        Ok(x) => Ok(x),
        Err(e) => {
            if let Some(rr) = rr {
                if let Ok(fresh) = rr() {
                    if fresh != *url {
                        *url = fresh;
                    }
                    return connect(url, pos, len);
                }
            }
            Err(e)
        }
    }
}

/// Append a query parameter (googlevideo takes byte ranges this way).
fn with_query(url: &str, extra: &str) -> String {
    if url.contains('?') { format!("{url}&{extra}") } else { format!("{url}?{extra}") }
}

// One agent per stream: keep-alive/TLS-session reuse makes the moov-probe tail
// fetch and mid-play reconnects noticeably faster than a fresh handshake each
// time (part of the click-to-audio latency on phones/Windows).
thread_local! {
    static STREAM_AGENT: std::cell::RefCell<Option<(String, ureq::Agent)>> = const { std::cell::RefCell::new(None) };
}
fn agent_for(url: &str) -> ureq::Agent {
    let host = url.split('/').nth(2).unwrap_or("").to_string();
    STREAM_AGENT.with(|c| {
        let mut c = c.borrow_mut();
        if let Some((h, a)) = c.as_ref() {
            if *h == host {
                return a.clone();
            }
        }
        let a = media_agent(url);
        *c = Some((host, a.clone()));
        a
    })
}

fn connect(url: &str, pos: u64, len: u64) -> Result<(Box<dyn Read + Send>, Option<u64>), String> {
    // googlevideo 403s an HTTP `Range` header it didn't issue — this is exactly
    // why streaming failed while the native DOWNLOADER (a plain GET) worked. So
    // fetch the whole stream with a plain GET at pos 0, and for seeks use
    // googlevideo's own `&range=` QUERY parameter instead of the header.
    if len > 0 && pos >= len {
        // EOF: a stale `len` or a fetch-at-end retry would build the invalid
        // range `pos-(len-1)` (start > end), which googlevideo rejects — the
        // caller would see an error instead of a clean end-of-stream.
        return Ok((Box::new(io::empty()), Some(len)));
    }
    let ranged;
    let target = if pos == 0 {
        url
    } else {
        let end = if len > 0 { len - 1 } else { pos + 10_000_000 };
        ranged = with_query(url, &format!("range={pos}-{end}"));
        &ranged
    };
    let resp = agent_for(url)
        .get(target)
        .set("User-Agent", YT_UA)
        .call()
        .map_err(|e| e.to_string())?;
    let total = resp
        .header("Content-Range")
        .and_then(|cr| cr.rsplit('/').next())
        .and_then(|t| t.trim().parse::<u64>().ok())
        .or_else(|| {
            resp.header("Content-Length")
                .and_then(|l| l.parse::<u64>().ok())
                .map(|l| l.saturating_add(pos))
        });
    Ok((Box::new(resp.into_reader()), total))
}

/// Downloads into the shared window, following the reader's position.
fn fetcher(mut url: String, len: u64, shared: Arc<(Mutex<Shared>, Condvar)>, initial: Box<dyn Read + Send>, rr: Option<ReResolve>) {
    let (lock, cv) = &*shared;
    let mut conn: Option<(Box<dyn Read + Send>, u64)> = Some((initial, 0)); // reader, absolute pos
    let mut tmp = vec![0u8; CHUNK];

    loop {
        // Decide the next fetch offset under the lock (or wait).
        let from = {
            let mut g = lock.lock().unwrap_or_else(|e| e.into_inner());
            loop {
                if g.dead {
                    return;
                }
                // Reposition the window when the reader jumped outside it.
                let end = g.start + g.buf.len() as u64;
                if g.target < g.start || g.target > end {
                    g.start = g.target;
                    g.buf.clear();
                }
                // Trim consumed bytes (keep BACK behind the reader).
                let keep_from = g.target.saturating_sub(BACK);
                if keep_from > g.start {
                    let drop = (keep_from - g.start) as usize;
                    g.buf.drain(..drop);
                    g.start = keep_from;
                    // Wake a possibly-waiting reader: `start` just moved, so a
                    // reader parked in cv.wait must re-evaluate its window NOW
                    // — otherwise it can sleep out the whole stall budget even
                    // though its bytes are buffered — the audible "coupure".
                    cv.notify_all();
                }
                let end = g.start + g.buf.len() as u64;
                if end >= len || g.buf.len() >= CAP {
                    // Fully buffered (to EOF or capacity) — sleep until poked.
                    cv.notify_all();
                    g = cv.wait(g).unwrap_or_else(|e| e.into_inner());
                    continue;
                }
                break end;
            }
        };

        // Ensure a connection positioned at `from` (with retries), then read.
        let mut read_n: Option<usize> = None;
        for attempt in 0..=RETRIES {
            if conn.as_ref().map(|(_, p)| *p) != Some(from) {
                conn = None;
            }
            if conn.is_none() {
                match connect_rr(&mut url, from, len, &rr) {
                    Ok((r, _)) => conn = Some((r, from)),
                    Err(e) => {
                        if attempt == RETRIES {
                            let mut g = lock.lock().unwrap_or_else(|e| e.into_inner());
                            g.err = Some(e);
                            cv.notify_all();
                            return;
                        }
                        // Exponential backoff up to 5s between attempts — the
                        // previous 300ms×n max (~5 s total) could not outlive a
                        // 30 s network drop, killing streams the reader-side
                        // 120 s stall budget would happily have waited out.
                        thread::sleep(Duration::from_millis((300u64 << attempt).min(5000)));
                        continue;
                    }
                }
            }
            let want = tmp.len().min((len - from) as usize);
            match conn.as_mut().unwrap().0.read(&mut tmp[..want]) {
                Ok(0) | Err(_) => {
                    conn = None; // early EOF or error — reconnect
                    if attempt == RETRIES {
                        let mut g = lock.lock().unwrap_or_else(|e| e.into_inner());
                        g.err = Some("stream connection lost".into());
                        cv.notify_all();
                        return;
                    }
                    thread::sleep(Duration::from_millis((300u64 << attempt).min(5000)));
                }
                Ok(n) => {
                    conn.as_mut().unwrap().1 = from + n as u64;
                    read_n = Some(n);
                    break;
                }
            }
        }

        if let Some(n) = read_n {
            let mut g = lock.lock().unwrap_or_else(|e| e.into_inner());
            // Only append if the window didn't move while we were reading.
            if g.start + g.buf.len() as u64 == from {
                g.buf.extend(&tmp[..n]);
                note_fetched(g.start + g.buf.len() as u64);
            }
            cv.notify_all();
        }
    }
}

impl HttpStream {
    /// Total size in bytes, from Content-Range/Content-Length. The decoder needs
    /// it (DecoderBuilder::with_byte_len) to probe moov-after-mdat mp4 files.
    pub fn byte_len(&self) -> u64 {
        self.len
    }

    pub fn open(url: String, rr: Option<ReResolve>) -> Result<Self, String> {
        let mut url = url;
        let (reader, total) = connect_rr(&mut url, 0, 0, &rr)?;
        let len = total.ok_or("server did not report a stream length")?;
        note_total(len);
        let shared = Arc::new((
            Mutex::new(Shared {
                start: 0,
                // Grow on demand instead of reserving the whole window: most
                // tracks never need it, and the allocation was pure resident
                // memory from the first byte.
                buf: VecDeque::with_capacity(CHUNK * 64),
                target: 0,
                err: None,
                dead: false,
            }),
            Condvar::new(),
        ));
        let sh = shared.clone();
        let url_for_tail = url.clone();
        let rr_for_tail = rr.clone();
        thread::spawn(move || fetcher(url, len, sh, reader, rr));
        Ok(HttpStream { len, pos: 0, shared, url: url_for_tail, rr: rr_for_tail, tail: None })
    }
}

impl Drop for HttpStream {
    fn drop(&mut self) {
        let (lock, cv) = &*self.shared;
        if let Ok(mut g) = lock.lock() {
            g.dead = true;
        }
        cv.notify_all();
    }
}

impl Read for HttpStream {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        if self.pos >= self.len {
            return Ok(0);
        }
        // Tail-zone reads come from a dedicated buffer so the streaming window
        // stays parked at the front of the file (see TAIL_SZ).
        let tail_start = self.len.saturating_sub(TAIL_SZ);
        if self.len > TAIL_SZ && self.pos >= tail_start {
            if self.tail.is_none() {
                let mut u = self.url.clone();
                let (r, _) = connect_rr(&mut u, tail_start, self.len, &self.rr)
                    .map_err(|e| io::Error::new(io::ErrorKind::Other, e))?;
                let mut v = Vec::with_capacity(TAIL_SZ as usize);
                r.take(TAIL_SZ)
                    .read_to_end(&mut v)
                    .map_err(|e| io::Error::new(io::ErrorKind::Other, e))?;
                self.tail = Some(v);
            }
            let t = self.tail.as_ref().unwrap();
            let off = (self.pos - tail_start) as usize;
            if off >= t.len() {
                return Ok(0);
            }
            let n = out.len().min(t.len() - off);
            out[..n].copy_from_slice(&t[off..off + n]);
            self.pos += n as u64;
            return Ok(n);
        }
        let (lock, cv) = &*self.shared;
        let mut g = lock.lock().unwrap_or_else(|e| e.into_inner());
        g.target = self.pos;
        cv.notify_all();
        let deadline = Instant::now() + STALL;
        loop {
            let end = g.start + g.buf.len() as u64;
            if self.pos >= g.start && self.pos < end {
                let off = (self.pos - g.start) as usize;
                let n = out.len().min(g.buf.len() - off);
                let (a, b) = g.buf.as_slices();
                let mut copied = 0;
                if off < a.len() {
                    let c = (a.len() - off).min(n);
                    out[..c].copy_from_slice(&a[off..off + c]);
                    copied = c;
                }
                if copied < n {
                    let boff = off.saturating_sub(a.len());
                    out[copied..n].copy_from_slice(&b[boff..boff + (n - copied)]);
                }
                self.pos += n as u64;
                g.target = self.pos;
                cv.notify_all();
                return Ok(n);
            }
            if let Some(e) = &g.err {
                return Err(io::Error::new(io::ErrorKind::Other, e.clone()));
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(io::Error::new(io::ErrorKind::TimedOut, "stream stalled"));
            }
            let (ng, _) = cv.wait_timeout(g, remaining).unwrap_or_else(|e| e.into_inner());
            g = ng;
        }
    }
}

impl Seek for HttpStream {
    fn seek(&mut self, from: SeekFrom) -> io::Result<u64> {
        let target = match from {
            SeekFrom::Start(p) => p as i128,
            SeekFrom::End(off) => self.len as i128 + off as i128,
            SeekFrom::Current(off) => self.pos as i128 + off as i128,
        };
        if target < 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "seek before start",
            ));
        }
        self.pos = (target as u64).min(self.len);
        // Seeks into the tail zone are served from the dedicated tail buffer —
        // don't drag the streaming window to the end of the file.
        if self.len > TAIL_SZ && self.pos >= self.len - TAIL_SZ {
            return Ok(self.pos);
        }
        // Poke the fetcher so it starts repositioning before the next read.
        let (lock, cv) = &*self.shared;
        if let Ok(mut g) = lock.lock() {
            g.target = self.pos;
        }
        cv.notify_all();
        Ok(self.pos)
    }
}