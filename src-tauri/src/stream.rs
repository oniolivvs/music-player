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
pub type CancelCheck = Arc<dyn Fn() -> bool + Send + Sync>;

// Bounded read-ahead, independent of track length. Fetch in small HTTP blocks
// rather than requesting the entire media body (which googlevideo can stall).
const CAP: usize = 1024 * 1024;
// A queued online track only needs a short head start. At the 96 kbps stream
// cap this is about 30–40 seconds, enough to bridge a hand-off without pulling
// several minutes of every item in a long playlist.
const PRELOAD_CAP: usize = 512 * 1024;
const BACK: u64 = 256 * 1024; // actual retention is also capped to one quarter of the window
const CHUNK: usize = 64 * 1024; // network read size
const HTTP_CHUNK: u64 = 512 * 1024;
#[cfg(not(test))]
const STALL: Duration = Duration::from_secs(120); // reader gives up after this
#[cfg(test)]
const STALL: Duration = Duration::from_secs(15);
const RETRIES: u32 = 8;
/// End-of-file zone served from a dedicated one-shot buffer. YouTube m4a puts
/// the moov atom at the END: the decoder probe seeks there and back, and
/// dragging the streaming window along cost two full reconnects before any
/// sound came out (the click-to-audio latency on phones and Windows).
const TAIL_SZ: u64 = 512 * 1024;

/// Bytes buffered ahead of the reader, total across the current stream's shared
/// window. The audio thread publishes this so the frontend render a real progress
/// pill ("Loading… N%") instead of faking it from elapsed time.
#[derive(Clone)]
pub struct Progress(Arc<(std::sync::atomic::AtomicU64, u64, std::sync::atomic::AtomicBool)>);
static ACTIVE_PROGRESS: Mutex<Option<Progress>> = Mutex::new(None);
impl Progress {
    fn new(len: u64) -> Self { Self(Arc::new((std::sync::atomic::AtomicU64::new(0), len, std::sync::atomic::AtomicBool::new(false)))) }
    pub fn activate(&self) {
        self.0.2.store(true, std::sync::atomic::Ordering::Relaxed);
        *ACTIVE_PROGRESS.lock().unwrap_or_else(|e| e.into_inner()) = Some(self.clone());
    }
    fn fetched(&self, end: u64) { self.0.0.store(end, std::sync::atomic::Ordering::Relaxed); }
}
pub(crate) fn note_total(_len: u64) {
    *ACTIVE_PROGRESS.lock().unwrap_or_else(|e| e.into_inner()) = None;
}
pub fn last_fetch_head() -> (u64, u64) {
    ACTIVE_PROGRESS.lock().unwrap_or_else(|e| e.into_inner()).as_ref()
        .map(|p| (p.0.0.load(std::sync::atomic::Ordering::Relaxed), p.0.1)).unwrap_or((0, 0))
}

struct Shared {
    start: u64, // absolute offset of buf[0]
    buf: VecDeque<u8>,
    target: u64, // reader position the fetcher must serve
    err: Option<String>,
    dead: bool, // reader dropped — fetcher exits
    cancel: Option<CancelCheck>,
}
impl Shared {
    fn cancelled(&self) -> bool { self.dead || self.cancel.as_ref().is_some_and(|check| check()) }
}

pub struct HttpStream {
    len: u64,
    pos: u64,
    shared: Arc<(Mutex<Shared>, Condvar)>,
    url: String,
    rr: Option<ReResolve>,
    tail: Option<Vec<u8>>, // lazily fetched last TAIL_SZ bytes (moov probe)
    progress: Progress,
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
    media_agent_with_timeouts(url, 10, 30)
}
fn media_agent_with_timeouts(url: &str, connect: u64, read: u64) -> ureq::Agent {
    let b = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(connect))
        .timeout_read(Duration::from_secs(read));
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
    let host = format!("{}:{:?}", url.split('/').nth(2).unwrap_or(""), url_wants_ipv6(url));
    STREAM_AGENT.with(|c| {
        let mut c = c.borrow_mut();
        if let Some((h, a)) = c.as_ref() {
            if *h == host {
                return a.clone();
            }
        }
        // Short, retryable operations bound an obsolete probe's socket wait.
        let a = media_agent_with_timeouts(url, 3, 3);
        *c = Some((host, a.clone()));
        a
    })
}

fn googlevideo(url: &str) -> bool {
    reqwest::Url::parse(url).ok().and_then(|u| u.host_str().map(str::to_owned))
        .is_some_and(|h| h == "googlevideo.com" || h.ends_with(".googlevideo.com"))
}
fn connection_end(url: &str, pos: u64, len: u64) -> u64 {
    if googlevideo(url) { pos.saturating_add(HTTP_CHUNK).min(len) } else { len }
}

fn connect(url: &str, pos: u64, len: u64) -> Result<(Box<dyn Read + Send>, Option<u64>), String> {
    // googlevideo 403s an HTTP `Range` header it didn't issue — this is exactly
    // why streaming failed while the native DOWNLOADER (a plain GET) worked. So
    // use googlevideo's own `&range=` QUERY parameter, including at offset 0.
    // Ordinary media servers (e.g. LAN shares) instead require HTTP Range.
    if len > 0 && pos >= len {
        // EOF: a stale `len` or a fetch-at-end retry would build the invalid
        // range `pos-(len-1)` (start > end), which googlevideo rejects — the
        // caller would see an error instead of a clean end-of-stream.
        return Ok((Box::new(io::empty()), Some(len)));
    }
    let googlevideo = googlevideo(url);
    let known_len = if len > 0 { Some(len) } else if googlevideo {
        reqwest::Url::parse(url).ok().and_then(|u| u.query_pairs().find(|(k, _)| k == "clen").and_then(|(_, v)| v.parse::<u64>().ok()))
    } else { None };
    let ranged;
    let target = if !googlevideo {
        url
    } else {
        let end = pos.saturating_add(HTTP_CHUNK).min(known_len.unwrap_or(u64::MAX)).saturating_sub(1);
        ranged = with_query(url, &format!("range={pos}-{end}"));
        &ranged
    };
    let mut request = agent_for(url)
        .get(target)
        .set("User-Agent", YT_UA);
    if pos > 0 && !googlevideo { request = request.set("Range", &format!("bytes={pos}-")); }
    let resp = request.call()
        .map_err(|e| e.to_string())?;
    let range_start = resp.header("Content-Range").and_then(|cr| cr.strip_prefix("bytes "))
        .and_then(|r| r.split('-').next()).and_then(|s| s.parse::<u64>().ok());
    if (pos > 0 && !googlevideo && (resp.status() != 206 || range_start != Some(pos)))
        || range_start.is_some_and(|start| start != pos) {
        return Err("server did not honor the requested byte range".into());
    }
    let total = resp
        .header("Content-Range")
        .and_then(|cr| cr.rsplit('/').next())
        .and_then(|t| t.trim().parse::<u64>().ok())
        .or(if googlevideo { known_len } else { None })
        .or_else(|| {
            resp.header("Content-Length")
                .and_then(|l| l.parse::<u64>().ok())
                .map(|l| l.saturating_add(pos))
        });
    if len > 0 && total != Some(len) { return Err("stream length changed during playback".into()); }
    Ok((Box::new(resp.into_reader()), total))
}

/// Downloads into the shared window, following the reader's position.
fn fetcher(mut url: String, len: u64, cap: usize, shared: Arc<(Mutex<Shared>, Condvar)>, initial: Box<dyn Read + Send>, rr: Option<ReResolve>, progress: Progress) {
    let (lock, cv) = &*shared;
    let mut conn: Option<(Box<dyn Read + Send>, u64, u64)> = Some((initial, 0, connection_end(&url, 0, len)));
    let mut tmp = vec![0u8; CHUNK];

    loop {
        // Decide the next fetch offset under the lock (or wait).
        let (from, room) = {
            let mut g = lock.lock().unwrap_or_else(|e| e.into_inner());
            loop {
                if g.cancelled() {
                    return;
                }
                // Reposition the window when the reader jumped outside it.
                let end = g.start + g.buf.len() as u64;
                if g.target < g.start || g.target > end {
                    g.start = g.target;
                    g.buf.clear();
                }
                // Trim consumed bytes (keep BACK behind the reader).
                let keep_from = g.target.saturating_sub(BACK.min((cap / 4) as u64));
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
                if end >= len || g.buf.len() >= cap {
                    // Fully buffered (to EOF or capacity) — sleep until poked.
                    cv.notify_all();
                    g = cv.wait(g).unwrap_or_else(|e| e.into_inner());
                    continue;
                }
                break (end, cap - g.buf.len());
            }
        };

        // Ensure a connection positioned at `from` (with retries), then read.
        let mut read_n: Option<usize> = None;
        for attempt in 0..=RETRIES {
            if lock.lock().unwrap_or_else(|e| e.into_inner()).cancelled() { return; }
            if conn.as_ref().map(|(_, p, end)| (*p, *end > *p)) != Some((from, true)) {
                conn = None;
            }
            if conn.is_none() {
                // During decoder preparation a refusal goes back to the UI's
                // retry path. A slow re-resolver must not pin obsolete probes.
                let resolver = if progress.0.2.load(std::sync::atomic::Ordering::Relaxed) { rr.clone() } else { None };
                match connect_rr(&mut url, from, len, &resolver) {
                    Ok((r, _)) => conn = Some((r, from, connection_end(&url, from, len))),
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
                        let g = lock.lock().unwrap_or_else(|e| e.into_inner());
                        let (g, _) = cv.wait_timeout(g, Duration::from_millis((300u64 << attempt).min(5000))).unwrap_or_else(|e| e.into_inner());
                        if g.cancelled() { return; }
                        continue;
                    }
                }
            }
            let want = tmp.len().min((len - from) as usize).min(room);
            let chunk = conn.as_mut().unwrap().0.read(&mut tmp[..want]);
            match chunk {
                Ok(0) | Err(_) => {
                    conn = None; // early EOF or error — reconnect
                    if attempt == RETRIES {
                        let mut g = lock.lock().unwrap_or_else(|e| e.into_inner());
                        g.err = Some("stream connection lost".into());
                        cv.notify_all();
                        return;
                    }
                    let g = lock.lock().unwrap_or_else(|e| e.into_inner());
                    let (g, _) = cv.wait_timeout(g, Duration::from_millis((300u64 << attempt).min(5000))).unwrap_or_else(|e| e.into_inner());
                    if g.cancelled() { return; }
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
                progress.fetched(g.start + g.buf.len() as u64);
            }
            cv.notify_all();
        }
    }
}

impl HttpStream {
    pub fn progress(&self) -> Progress { self.progress.clone() }
    /// Total size in bytes, from Content-Range/Content-Length. The decoder needs
    /// it (DecoderBuilder::with_byte_len) to probe moov-after-mdat mp4 files.
    pub fn byte_len(&self) -> u64 {
        self.len
    }

    #[allow(dead_code)] // used by the standalone stream_test example
    pub fn open(url: String, rr: Option<ReResolve>) -> Result<Self, String> {
        Self::open_capped(url, rr, CAP, None)
    }

    /// Open a bounded read-ahead window for the next-track preloader. The
    /// normal player keeps the larger window for stall safety.
    #[cfg(test)]
    pub fn open_preload(url: String, rr: Option<ReResolve>) -> Result<Self, String> {
        Self::open_capped(url, rr, PRELOAD_CAP, None)
    }

    pub fn open_cancellable(url: String, rr: Option<ReResolve>, preload: bool, cancel: CancelCheck) -> Result<Self, String> {
        Self::open_capped(url, rr, if preload { PRELOAD_CAP } else { CAP }, Some(cancel))
    }

    fn open_capped(url: String, rr: Option<ReResolve>, cap: usize, cancel: Option<CancelCheck>) -> Result<Self, String> {
        let cancelled = || cancel.as_ref().is_some_and(|check| check());
        if cancelled() { return Err("stream cancelled".into()); }
        let (reader, total) = connect(&url, 0, 0)?;
        if cancelled() { return Err("stream cancelled".into()); }
        let len = total.ok_or("server did not report a stream length")?;
        let progress = Progress::new(len);
        let shared = Arc::new((
            Mutex::new(Shared {
                start: 0,
                // Grow on demand instead of reserving the whole window: most
                // tracks never need it, and the allocation was pure resident
                // memory from the first byte.
                buf: VecDeque::with_capacity(cap.min(CHUNK * 64)),
                target: 0,
                err: None,
                dead: false,
                cancel,
            }),
            Condvar::new(),
        ));
        let sh = shared.clone();
        let url_for_tail = url.clone();
        let rr_for_tail = rr.clone();
        let fetch_progress = progress.clone();
        thread::spawn(move || fetcher(url, len, cap, sh, reader, rr, fetch_progress));
        Ok(HttpStream { len, pos: 0, shared, url: url_for_tail, rr: rr_for_tail, tail: None, progress })
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
        if self.shared.0.lock().unwrap_or_else(|e| e.into_inner()).cancelled() {
            return Err(io::Error::new(io::ErrorKind::ConnectionAborted, "stream cancelled"));
        }
        if out.is_empty() || self.pos >= self.len {
            return Ok(0);
        }
        // Tail-zone reads come from a dedicated buffer so the streaming window
        // stays parked at the front of the file (see TAIL_SZ).
        let tail_start = self.len.saturating_sub(TAIL_SZ);
        if self.len > TAIL_SZ && self.pos >= tail_start {
            if self.tail.is_none() {
                let mut u = self.url.clone();
                let resolver = if self.progress.0.2.load(std::sync::atomic::Ordering::Relaxed) { self.rr.clone() } else { None };
                let (mut r, _) = connect_rr(&mut u, tail_start, self.len, &resolver)
                    .map_err(|e| io::Error::new(io::ErrorKind::Other, e))?;
                let mut v = Vec::with_capacity(TAIL_SZ as usize);
                let mut part = [0u8; CHUNK];
                while v.len() < TAIL_SZ as usize {
                    if self.shared.0.lock().unwrap_or_else(|e| e.into_inner()).cancelled() {
                        return Err(io::Error::new(io::ErrorKind::ConnectionAborted, "stream cancelled"));
                    }
                    let remaining = (TAIL_SZ as usize - v.len()).min(part.len());
                    let n = r.read(&mut part[..remaining])?;
                    if n == 0 { break; }
                    v.extend_from_slice(&part[..n]);
                }
                if v.len() != TAIL_SZ as usize { return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "incomplete stream tail")); }
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
            if g.cancelled() { return Err(io::Error::new(io::ErrorKind::ConnectionAborted, "stream cancelled")); }
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
            let (ng, _) = cv.wait_timeout(g, remaining.min(Duration::from_millis(100))).unwrap_or_else(|e| e.into_inner());
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    struct Server { url: String, done: Arc<AtomicBool>, thread: Option<thread::JoinHandle<()>> }
    impl Server {
        fn new(data: Vec<u8>, honor_range: bool) -> Self {
            let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
            let url = format!("http://{}/audio", server.server_addr());
            let done = Arc::new(AtomicBool::new(false));
            let stop = done.clone();
            let thread = thread::spawn(move || {
                while !stop.load(Ordering::Relaxed) {
                    if let Ok(Some(request)) = server.recv_timeout(Duration::from_millis(50)) {
                        let start = request.headers().iter().find(|h| h.field.equiv("Range"))
                            .and_then(|h| h.value.as_str().strip_prefix("bytes="))
                            .and_then(|s| s.split('-').next()).and_then(|s| s.parse::<usize>().ok());
                        let response = if let Some(start) = start.filter(|_| honor_range) {
                            tiny_http::Response::from_data(data[start..].to_vec()).with_status_code(206)
                                .with_header(tiny_http::Header::from_bytes("Content-Range", format!("bytes {}-{}/{}", start, data.len()-1, data.len())).unwrap())
                        } else { tiny_http::Response::from_data(data.clone()) };
                        thread::spawn(move || { let _ = request.respond(response.with_chunked_threshold(usize::MAX)); });
                    }
                }
            });
            Self { url, done, thread: Some(thread) }
        }
    }
    impl Drop for Server {
        fn drop(&mut self) { self.done.store(true, Ordering::Relaxed); self.thread.take().unwrap().join().unwrap(); }
    }
    fn bytes(len: usize) -> Vec<u8> { (0..len).map(|i| ((i*7+i/251)%256) as u8).collect() }

    #[test]
    fn preload_continues_past_its_window() {
        let data = bytes(3*1024*1024);
        let server = Server::new(data.clone(), true);
        let mut stream = HttpStream::open_preload(server.url.clone(), None).unwrap();
        let mut read = vec![0; PRELOAD_CAP*3];
        stream.read_exact(&mut read).expect("preload must release consumed bytes and continue fetching");
        assert_eq!(read, data[..read.len()]);
        assert!(stream.shared.0.lock().unwrap().buf.len() <= PRELOAD_CAP, "read-ahead must stay bounded");
        stream.seek(SeekFrom::Current(-100_000)).unwrap();
        let mut again = vec![0; 100_000]; stream.read_exact(&mut again).unwrap();
        assert_eq!(again, read[read.len()-100_000..]);
    }

    #[test]
    fn lan_seek_and_tail_return_the_requested_bytes() {
        let data = bytes(2*1024*1024);
        let server = Server::new(data.clone(), true);
        let mut stream = HttpStream::open_preload(server.url.clone(), None).unwrap();
        stream.seek(SeekFrom::End(-1200)).unwrap();
        let mut tail = vec![0;1200]; stream.read_exact(&mut tail).unwrap();
        assert_eq!(tail, data[data.len()-1200..]);
        stream.seek(SeekFrom::Start(100)).unwrap();
        let mut head = vec![0;400]; stream.read_exact(&mut head).unwrap();
        assert_eq!(head,data[100..500]);
    }

    #[test]
    fn ignored_range_is_an_error_instead_of_wrong_audio() {
        let server = Server::new(bytes(800_000), false);
        assert!(connect(&server.url, 600_000, 800_000).is_err());
    }

    #[test]
    fn preparing_the_next_track_does_not_reset_active_progress() {
        let active = Progress::new(3_000_000);
        active.fetched(100_000); active.activate();
        let server = Server::new(bytes(800_000), true);
        let next = HttpStream::open_preload(server.url.clone(), None).unwrap();
        assert_eq!(last_fetch_head(), (100_000, 3_000_000));
        next.progress().activate();
        assert_eq!(last_fetch_head().1, 800_000);
        note_total(0);
    }

    #[test]
    fn cancellation_releases_a_decoder_waiting_for_a_stalled_server() {
        use std::io::Write;
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/stalled", listener.local_addr().unwrap());
        let cancelled = Arc::new(AtomicBool::new(false));
        let (close_tx, close_rx) = std::sync::mpsc::channel();
        let server = thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2000000\r\nConnection: close\r\n\r\n").unwrap();
            let _ = close_rx.recv_timeout(Duration::from_secs(5));
        });
        let check = cancelled.clone();
        let mut stream = HttpStream::open_cancellable(url, None, false, Arc::new(move || check.load(Ordering::SeqCst))).unwrap();
        let (result_tx, result_rx) = std::sync::mpsc::channel();
        let reader = thread::spawn(move || {
            let result = stream.read_exact(&mut [0; 32]);
            let _ = result_tx.send(result);
        });
        cancelled.store(true, Ordering::SeqCst);
        let result = result_rx.recv_timeout(Duration::from_secs(1));
        let _ = close_tx.send(()); server.join().unwrap(); reader.join().unwrap();
        assert_eq!(result.expect("obsolete decoder must not occupy a worker until HTTP timeout").unwrap_err().kind(), io::ErrorKind::ConnectionAborted);
    }
}
