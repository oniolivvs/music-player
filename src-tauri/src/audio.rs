//! Native audio engine — gapless queue + per-track gain + anti-click fade.
//!
//! `rodio`'s `OutputStream` is `!Send`, so the stream lives in a dedicated thread
//! that owns a single persistent `Sink`. Gapless playback is achieved the way
//! rodio is designed for: the NEXT track is `append`ed to the same sink before the
//! current one ends, so rodio transitions with no gap. Each appended source is
//! wrapped with a short `fade_in` (kills clicks) and `amplify(gain)` (per-track
//! ReplayGain — the sink's own volume stays the user's master control on top).
//!
//! Play/Preload/Clear need the (!Send) stream handle, so they go through the
//! channel. Pause/resume/seek/volume/status act on the shared `Sink` directly.

use crate::stream::{HttpStream, ReResolve};
use rodio::{Decoder, OutputStreamBuilder, Sink, Source};
use serde::Serialize;
use std::fs::File;
use std::io::BufReader;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

const FADE: Duration = Duration::from_millis(20);
// Automatic gain control: evens out perceived loudness across tracks (YouTube
// rips have no ReplayGain tags, so tag-based normalization can't help them).
// Deliberately gentle: a low max gain + slow attack prevents quiet intros from
// being boosted hard and then BLASTING when the track kicks in.
const AGC_TARGET: f32 = 0.75;
const AGC_ATTACK: f32 = 8.0; // slow ramp-up
const AGC_RELEASE: f32 = 0.004; // fast cut when it gets loud
const AGC_MAX_GAIN: f32 = 1.8;

enum AudioCmd {
    Play(String, f32, u64),    // path, linear gain, epoch — hard start (fresh sink)
    Preload(String, f32),      // path, linear gain — append for gapless continuation
    PlayUrl(String, f32, u64, Option<ReResolve>), // remote stream URL, epoch, re-resolver
    PreloadUrl(String, f32, Option<ReResolve>),   // remote stream URL, re-resolver
    Clear(u64),                // stop everything (empty sink)
}

#[derive(Serialize)]
pub struct PlaybackStatus {
    pub queued: u32,    // sources still in the sink (current + preloaded)
    pub finished: bool, // sink is empty
    pub position: f64,  // seconds into the current source (secondary; UI uses a wall clock)
    pub epoch: u64,     // which play/clear command this sink belongs to
    pub buffered: u64,  // bytes fetched ahead by the current stream (0 for local files)
    pub total_bytes: u64, // total stream size (0 for local files / unknown)
}

// The epoch tags each hard start: play() hands it to the frontend and status()
// reports the sink's epoch, so a status poll taken while a slow stream is still
// connecting (the previous sink still audible) can be recognized as stale and
// ignored instead of being misread as a gapless track transition.
pub struct AudioController {
    tx: Mutex<Sender<AudioCmd>>,
    sink: Arc<Mutex<(u64, Option<Arc<Sink>>)>>,
    next_epoch: AtomicU64,
    agc: Arc<AtomicBool>,
    // Master volume survives hard starts: every fresh Sink is created at 1.0 by
    // rodio, which silently reset playback to FULL volume on each track switch.
    vol: Arc<Mutex<f32>>,
    // Last "silent failure" (no audio device, a track/stream that couldn't
    // decode, or a runtime output error) so the frontend can actually tell the
    // user why there's no sound.
    last_err: Arc<Mutex<Option<String>>>,
    // Opened output-device config ("48000 Hz · 2 ch · F32") for diagnostics.
    info: Arc<Mutex<String>>,
}

fn append_source<S>(sink: &Sink, src: S, gain: f32, agc: bool)
where
    S: Source + Send + 'static,
{
    let base = src.fade_in(FADE).amplify(gain);
    if agc {
        sink.append(base.automatic_gain_control(AGC_TARGET, AGC_ATTACK, AGC_RELEASE, AGC_MAX_GAIN));
    } else {
        sink.append(base);
    }
}

fn append_track(sink: &Sink, path: &str, gain: f32, agc: bool, err: &Arc<Mutex<Option<String>>>) {
    // rodio 0.21 defaults to is_seekable=false; opt back in so Sink::try_seek works.
    match File::open(path).map_err(|e| e.to_string()).and_then(|f| {
        let len = f.metadata().map(|m| m.len()).ok();
        let mut b = Decoder::builder()
            .with_data(BufReader::new(f))
            .with_seekable(true);
        if let Some(l) = len {
            b = b.with_byte_len(l);
        }
        b.build().map_err(|e| e.to_string())
    }) {
        Ok(dec) => append_source(sink, dec, gain, agc),
        Err(e) => { let msg = format!("can't play this file: {e}"); eprintln!("[audio] {msg}"); *err.lock().unwrap_or_else(|e| e.into_inner()) = Some(msg); }
    }
}

fn append_url(sink: &Sink, url: &str, gain: f32, agc: bool, err: &Arc<Mutex<Option<String>>>, rr: Option<ReResolve>) {
    // byte_len is mandatory here: symphonia's isomp4 demuxer refuses to probe
    // YouTube's moov-after-mdat m4a files without knowing the total size.
    match HttpStream::open(url.to_string(), rr).and_then(|s| {
        let len = s.byte_len();
        Decoder::builder()
            .with_data(s)
            .with_byte_len(len)
            .with_seekable(true)
            .build()
            .map_err(|e| e.to_string())
    }) {
        Ok(dec) => append_source(sink, dec, gain, agc),
        Err(e) => {
            // Strip the (huge, noisy) URL from the error — ureq embeds the full
            // googlevideo link, which otherwise floods the UI toast.
            let clean = strip_url(&e.to_string());
            let msg = format!("can't play this stream: {clean}");
            eprintln!("[audio] {msg}");
            *err.lock().unwrap_or_else(|e| e.into_inner()) = Some(msg);
        }
    }
}

/// Remove any http(s) URL from a message so error toasts stay readable.
fn strip_url(s: &str) -> String {
    let mut out = String::new();
    let mut chars = s.char_indices().peekable();
    while let Some((i, c)) = chars.next() {
        if s[i..].starts_with("http://") || s[i..].starts_with("https://") {
            out.push_str("<stream>");
            // Skip to the next whitespace.
            while let Some(&(_, nc)) = chars.peek() {
                if nc.is_whitespace() { break; }
                chars.next();
            }
        } else {
            out.push(c);
        }
    }
    let t = out.trim().to_string();
    if t.chars().count() > 160 {
        format!("{}…", t.chars().take(160).collect::<String>())
    } else {
        t
    }
}

impl AudioController {
    pub fn new() -> Self {
        let (tx, rx) = channel::<AudioCmd>();
        let sink: Arc<Mutex<(u64, Option<Arc<Sink>>)>> = Arc::new(Mutex::new((0, None)));
        let sink_t = sink.clone();
        let agc = Arc::new(AtomicBool::new(true));
        let agc_t = agc.clone();
        let vol: Arc<Mutex<f32>> = Arc::new(Mutex::new(0.8));
        let vol_t = vol.clone();
        let last_err: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
        let err_t = last_err.clone();
        let info = Arc::new(Mutex::new(String::new()));
        let info_t = info.clone();

        thread::spawn(move || {
            // Mark that the thread reached here — if the diagnostic ever shows
            // this, the open code below never returned (hang), vs "" = thread
            // never spawned.
            *info_t.lock().unwrap_or_else(|e| e.into_inner()) = "opening…".to_string();
            // The OutputStream must stay alive for the whole thread. The audio
            // system can be briefly unavailable at cold start (esp. Android),
            // so retry a few times before giving up loudly. A custom error
            // callback records RUNTIME output errors (e.g. AAudio dropping the
            // stream mid-playback) so silent failures during playback surface too.
            let stream = {
                let mut got = None;
                // Keep trying for ~30s: on Android the device can't open until
                // setup() has bridged the Android context into ndk_context, and
                // this thread starts BEFORE setup runs.
                for attempt in 0..60 {
                    let cb_err = err_t.clone();
                    // cpal's AAudio backend can PANIC (unwraps on JNI results),
                    // not just return Err — catch it so the reason is visible
                    // instead of silently killing the audio thread.
                    let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        OutputStreamBuilder::from_default_device()
                            .and_then(|b| {
                                b.with_error_callback(move |e| {
                                    let m = format!("audio output error: {e}");
                                    eprintln!("[audio] {m}");
                                    *cb_err.lock().unwrap_or_else(|e| e.into_inner()) = Some(m);
                                })
                                .open_stream()
                            })
                            .or_else(|_| OutputStreamBuilder::open_default_stream())
                    }));
                    let res = match res {
                        Ok(r) => r,
                        Err(p) => {
                            let m = p.downcast_ref::<&str>().map(|s| s.to_string())
                                .or_else(|| p.downcast_ref::<String>().cloned())
                                .unwrap_or_else(|| "panic".into());
                            eprintln!("[audio] open panicked: {m} (attempt {attempt})");
                            *info_t.lock().unwrap_or_else(|e| e.into_inner()) = format!("open panicked: {m}");
                            *err_t.lock().unwrap_or_else(|e| e.into_inner()) = Some(format!("audio panic: {m}"));
                            thread::sleep(std::time::Duration::from_millis(500));
                            continue;
                        }
                    };
                    match res {
                        Ok(v) => { got = Some(v); break; }
                        Err(e) => {
                            let msg = format!("no audio output device: {e}");
                            if attempt % 4 == 0 { eprintln!("[audio] {msg} (attempt {attempt})"); }
                            *err_t.lock().unwrap_or_else(|e| e.into_inner()) = Some(msg.clone());
                            // Show the real reason live in the diagnostic even
                            // while retrying (not only after giving up).
                            *info_t.lock().unwrap_or_else(|e| e.into_inner()) = format!("open failed: {e}");
                            thread::sleep(std::time::Duration::from_millis(500));
                        }
                    }
                }
                match got {
                    Some(v) => {
                        let c = v.config();
                        *info_t.lock().unwrap_or_else(|e| e.into_inner()) = format!(
                            "{:?} · {} ch · {:?}",
                            c.sample_rate(), c.channel_count(), c.sample_format()
                        );
                        *err_t.lock().unwrap_or_else(|e| e.into_inner()) = None;
                        v
                    }
                    None => {
                        // Give up, but expose WHY (the real cpal/AAudio error) so
                        // the "Audio output" diagnostic shows the cause.
                        let why = err_t.lock().unwrap_or_else(|e| e.into_inner()).clone().unwrap_or_else(|| "unknown".into());
                        *info_t.lock().unwrap_or_else(|e| e.into_inner()) = format!("open failed: {why}");
                        return;
                    }
                }
            };
            *sink_t.lock().unwrap_or_else(|e| e.into_inner()) = (0, Some(Arc::new(Sink::connect_new(stream.mixer()))));

            while let Ok(cmd) = rx.recv() {
                let agc_on = agc_t.load(Ordering::Relaxed);
                let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    match cmd {
                        AudioCmd::Play(path, gain, epoch) => {
                            let new_sink = Arc::new(Sink::connect_new(stream.mixer()));
                            new_sink.set_volume(*vol_t.lock().unwrap_or_else(|e| e.into_inner()));
                            append_track(&new_sink, &path, gain, agc_on, &err_t);
                            new_sink.play();
                            // Drop the OLD sink (decoder + its streaming fetcher
                            // thread) OUTSIDE the mutex — its Drop joins the
                            // fetcher, and doing it under the lock stalls every
                            // sync IPC (status/seek/volume) for the duration.
                            let old = std::mem::replace(&mut *sink_t.lock().unwrap_or_else(|e| e.into_inner()), (epoch, Some(new_sink)));
                            drop(old);
                        }
                        AudioCmd::Preload(path, gain) => {
                            let s = sink_t.lock().unwrap_or_else(|e| e.into_inner()).1.clone();
                            if let Some(s) = s {
                                append_track(&s, &path, gain, agc_on, &err_t);
                            }
                        }
                        AudioCmd::PlayUrl(url, gain, epoch, rr) => {
                            let new_sink = Arc::new(Sink::connect_new(stream.mixer()));
                            new_sink.set_volume(*vol_t.lock().unwrap_or_else(|e| e.into_inner()));
                            append_url(&new_sink, &url, gain, agc_on, &err_t, rr.clone());
                            // A failed append leaves the sink EMPTY → silence with a
                            // "playing" UI (the pause-then-resume bug). Retry once
                            // with a FRESH URL: skips land on cached stream links
                            // that googlevideo sometimes rejects transiently.
                            if new_sink.empty() {
                                if let Some(rr2) = rr.clone() {
                                    if let Ok(fresh) = rr2() {
                                        // Retry even if the resolver handed back the
                                        // same URL: the transient rejection may be
                                        // per-connection. Worse case = one wasted
                                        // reconnect, better than a silent track.
                                        eprintln!("[audio] stream append failed — retrying with a fresh URL");
                                        append_url(&new_sink, &fresh, gain, agc_on, &err_t, rr);
                                    }
                                }
                            }
                            new_sink.play();
                            let old = std::mem::replace(&mut *sink_t.lock().unwrap_or_else(|e| e.into_inner()), (epoch, Some(new_sink)));
                            drop(old);
                        }
                        AudioCmd::PreloadUrl(url, gain, rr) => {
                            let s = sink_t.lock().unwrap_or_else(|e| e.into_inner()).1.clone();
                            if let Some(s) = s {
                                append_url(&s, &url, gain, agc_on, &err_t, rr);
                            }
                        }
                        AudioCmd::Clear(epoch) => {
                            let s = Arc::new(Sink::connect_new(stream.mixer()));
                            s.set_volume(*vol_t.lock().unwrap_or_else(|e| e.into_inner()));
                            let old = std::mem::replace(&mut *sink_t.lock().unwrap_or_else(|e| e.into_inner()), (epoch, Some(s)));
                            drop(old);
                        }
                    }
                }));
                if let Err(p) = res {
                    let m = p.downcast_ref::<&str>().map(|s| s.to_string())
                        .or_else(|| p.downcast_ref::<String>().cloned())
                        .unwrap_or_else(|| "decoder panic".into());
                    eprintln!("[audio] command processing panicked: {m}");
                    *err_t.lock().unwrap_or_else(|e| e.into_inner()) = Some(format!("audio panic: {m}"));
                }
            }
        });

        AudioController {
            tx: Mutex::new(tx),
            sink,
            next_epoch: AtomicU64::new(0),
            agc,
            vol,
            last_err,
            info,
        }
    }

    /// The last silent playback failure (empty if none) — the frontend shows it
    /// so "no sound" isn't a mystery. Reading it clears it.
    pub fn take_error(&self) -> Option<String> {
        self.last_err.lock().unwrap_or_else(|e| e.into_inner()).take()
    }

    /// Opened audio-device config, or "" if none opened (device diagnostics).
    pub fn info(&self) -> String {
        self.info.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// Toggle automatic loudness normalization (applies to the NEXT queued
    /// sources — the currently playing one keeps its chain).
    pub fn set_agc(&self, on: bool) {
        self.agc.store(on, Ordering::Relaxed);
    }

    fn send(&self, cmd: AudioCmd) {
        if let Ok(tx) = self.tx.lock() {
            let _ = tx.send(cmd);
        }
    }
    fn bump_epoch(&self) -> u64 {
        self.next_epoch.fetch_add(1, Ordering::Relaxed) + 1
    }
    fn with_sink<R>(&self, f: impl FnOnce(&Sink) -> R) -> Option<R> {
        self.sink.lock().unwrap_or_else(|e| e.into_inner()).1.as_ref().map(|s| f(&**s))
    }

    pub fn play(&self, path: String, gain: f32) -> u64 {
        let e = self.bump_epoch();
        self.send(AudioCmd::Play(path, gain, e));
        e
    }
    pub fn preload(&self, path: String, gain: f32) {
        self.send(AudioCmd::Preload(path, gain));
    }
    pub fn play_url(&self, url: String, gain: f32, rr: Option<ReResolve>) -> u64 {
        let e = self.bump_epoch();
        self.send(AudioCmd::PlayUrl(url, gain, e, rr));
        e
    }
    pub fn preload_url(&self, url: String, gain: f32, rr: Option<ReResolve>) {
        self.send(AudioCmd::PreloadUrl(url, gain, rr));
    }
    pub fn stop(&self) -> u64 {
        let e = self.bump_epoch();
        self.send(AudioCmd::Clear(e));
        e
    }
    pub fn pause(&self) {
        self.with_sink(|s| s.pause());
    }
    pub fn resume(&self) {
        self.with_sink(|s| s.play());
    }
    pub fn set_volume(&self, level: f32) {
        let level = level.clamp(0.0, 2.0);
        *self.vol.lock().unwrap_or_else(|e| e.into_inner()) = level;
        self.with_sink(|s| s.set_volume(level));
    }
    pub fn seek(&self, secs: f64) {
        self.with_sink(|s| {
            let _ = s.try_seek(Duration::from_secs_f64(secs.max(0.0)));
        });
    }
    pub fn status(&self) -> PlaybackStatus {
        let guard = self.sink.lock().unwrap_or_else(|e| e.into_inner());
        let (buffered, total_bytes) = crate::stream::last_fetch_head();
        match &guard.1 {
            Some(s) => PlaybackStatus {
                queued: s.len() as u32,
                finished: s.empty(),
                position: s.get_pos().as_secs_f64(),
                epoch: guard.0,
                buffered,
                total_bytes,
            },
            None => PlaybackStatus {
                queued: 0,
                finished: true,
                position: 0.0,
                epoch: guard.0,
                buffered,
                total_bytes,
            },
        }
    }
}

impl Default for AudioController {
    fn default() -> Self {
        Self::new()
    }
}
