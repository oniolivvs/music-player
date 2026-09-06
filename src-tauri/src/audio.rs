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
    Play(String, f32, u64, u64), // path, linear gain, epoch, request
    Preload(String, f32, u64), // path, linear gain, request
    PlayUrl(String, f32, u64, Option<ReResolve>, u64), // URL, epoch, re-resolver, request token
    PreloadUrl(String, f32, Option<ReResolve>, u64),   // URL, re-resolver, request token
    PlayPrepared(Result<StreamSource, String>, f32, u64, Option<ReResolve>, u64),
    PreloadPrepared(Result<StreamSource, String>, f32, u64),
    Clear(u64, u64),           // epoch, request — stop everything
}

// A decoded stream is Send, so the slow HTTP open + mp4 probe can happen on a
// worker instead of blocking the audio command thread (pause/stop/seek remain
// responsive while YouTube is resolving or connecting).
type StreamSource = Box<dyn Source<Item = f32> + Send>;

type PreparationTask = Box<dyn FnOnce() + Send>;

// Fixed workers bound both thread count and concurrent HTTP/decoder probes.
// A queued task checks its play generation before opening a connection.
fn preparation_queue() -> Sender<PreparationTask> {
    let (tx, rx) = channel::<PreparationTask>();
    let shared = Arc::new(Mutex::new(rx));
    for _ in 0..3 {
        let receiver = shared.clone();
        thread::spawn(move || loop {
            let task = receiver.lock().unwrap_or_else(|e| e.into_inner()).recv();
            match task {
                Ok(task) => { let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(task)); }
                Err(_) => break,
            }
        });
    }
    tx
}

fn queue_preparation(
    queue: &Sender<PreparationTask>,
    current: Arc<AtomicU64>,
    request: u64,
    task: impl FnOnce() + Send + 'static,
) {
    let _ = queue.send(Box::new(move || {
        if current.load(Ordering::SeqCst) == request { task(); }
    }));
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
    stream_request: Arc<AtomicU64>,
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

fn open_track_source(path: &str) -> Result<StreamSource, String> {
    // rodio 0.21 defaults to is_seekable=false; opt back in so Sink::try_seek works.
    File::open(path).map_err(|e| e.to_string()).and_then(|f| {
        let len = f.metadata().map(|m| m.len()).ok();
        let mut b = Decoder::builder()
            .with_data(BufReader::new(f))
            .with_seekable(true);
        if let Some(l) = len {
            b = b.with_byte_len(l);
        }
        b.build().map_err(|e| e.to_string())
    }).map(|dec| Box::new(dec.periodic_access(Duration::from_millis(100), |_| crate::stream::note_total(0))) as StreamSource)
}

fn open_url_source(url: String, rr: Option<ReResolve>, preload: bool, cancel: crate::stream::CancelCheck) -> Result<StreamSource, String> {
    // byte_len is mandatory here: symphonia's isomp4 demuxer refuses to probe
    // YouTube's moov-after-mdat m4a files without knowing the total size.
    let s = HttpStream::open_cancellable(url, rr, preload, cancel)?;
    let len = s.byte_len();
    let progress = s.progress();
    Decoder::builder()
        .with_data(s)
        .with_byte_len(len)
        .with_seekable(true)
        .build()
        .map(|dec| Box::new(dec.periodic_access(Duration::from_millis(100), move |_| progress.activate())) as StreamSource)
        .map_err(|e| e.to_string())
}

// Cancellation and sink installation share the sink lock. An obsolete decoder
// cannot pass a check and then install itself after a newer stop/play decision.
fn replace_current_sink(
    shared: &Mutex<(u64, Option<Arc<Sink>>)>,
    current: &AtomicU64,
    request: u64,
    epoch: u64,
    sink: Arc<Sink>,
) -> bool {
    let old = {
        let mut guard = shared.lock().unwrap_or_else(|e| e.into_inner());
        if current.load(Ordering::SeqCst) != request {
            return false;
        }
        let old = std::mem::replace(&mut *guard, (epoch, Some(sink.clone())));
        if let Some(previous) = &old.1 { previous.stop(); }
        sink.play();
        old
    };
    drop(old);
    true
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
        let worker_tx = tx.clone();
        let prepare_tx = preparation_queue();
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
        let stream_request = Arc::new(AtomicU64::new(0));
        let stream_request_t = stream_request.clone();

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
                        AudioCmd::Play(path, gain, epoch, request) => {
                            if stream_request_t.load(Ordering::SeqCst) != request { return; }
                            let new_sink = Arc::new(Sink::connect_new(stream.mixer()));
                            new_sink.pause();
                            new_sink.set_volume(*vol_t.lock().unwrap_or_else(|e| e.into_inner()));
                            match open_track_source(&path) {
                                Ok(dec) => append_source(&new_sink, dec, gain, agc_on),
                                Err(e) => {
                                    let _guard = sink_t.lock().unwrap_or_else(|e| e.into_inner());
                                    if stream_request_t.load(Ordering::SeqCst) != request { return; }
                                    let msg = format!("can't play this file: {e}");
                                    eprintln!("[audio] {msg}");
                                    *err_t.lock().unwrap_or_else(|e| e.into_inner()) = Some(msg);
                                }
                            }
                            // Drop the OLD sink (decoder + its streaming fetcher
                            // thread) OUTSIDE the mutex — its Drop joins the
                            // fetcher, and doing it under the lock stalls every
                            // sync IPC (status/seek/volume) for the duration.
                            replace_current_sink(&sink_t, &stream_request_t, request, epoch, new_sink);
                        }
                        AudioCmd::Preload(path, gain, request) => {
                            if stream_request_t.load(Ordering::SeqCst) != request { return; }
                            let prepared = open_track_source(&path);
                            let guard = sink_t.lock().unwrap_or_else(|e| e.into_inner());
                            if stream_request_t.load(Ordering::SeqCst) != request { return; }
                            if let Some(s) = &guard.1 {
                                match prepared {
                                    Ok(dec) => append_source(s, dec, gain, agc_on),
                                    Err(e) => {
                                        let msg = format!("can't preload this file: {e}");
                                        eprintln!("[audio] {msg}");
                                        *err_t.lock().unwrap_or_else(|e| e.into_inner()) = Some(msg);
                                    }
                                }
                            }
                        }
                        AudioCmd::PlayUrl(url, gain, epoch, rr, request) => {
                            if stream_request_t.load(Ordering::SeqCst) != request { return; }
                            // HTTP connect + decoder probing can take seconds.
                            // Build the source off this command loop so pause,
                            // stop, and a newer click are never queued behind it.
                            let tx = worker_tx.clone();
                            let rr_for_open = rr.clone();
                            let current = stream_request_t.clone();
                            queue_preparation(&prepare_tx, current.clone(), request, move || {
                                let generation = current.clone();
                                let prepared = std::panic::catch_unwind(std::panic::AssertUnwindSafe(||
                                    open_url_source(url, rr_for_open, false, Arc::new(move || generation.load(Ordering::SeqCst) != request))
                                )).unwrap_or_else(|_| Err("stream decoder panicked".into()));
                                if current.load(Ordering::SeqCst) != request { return; }
                                let _ = tx.send(AudioCmd::PlayPrepared(prepared, gain, epoch, rr, request));
                            });
                        }
                        AudioCmd::PreloadUrl(url, gain, rr, request) => {
                            if stream_request_t.load(Ordering::SeqCst) != request { return; }
                            // Preload uses the current play token. If the user
                            // selects another track while this worker is opening,
                            // its result is discarded instead of appending stale
                            // audio to the new sink.
                            let tx = worker_tx.clone();
                            let rr_for_open = rr.clone();
                            let current = stream_request_t.clone();
                            queue_preparation(&prepare_tx, current.clone(), request, move || {
                                let generation = current.clone();
                                let prepared = std::panic::catch_unwind(std::panic::AssertUnwindSafe(||
                                    open_url_source(url, rr_for_open, true, Arc::new(move || generation.load(Ordering::SeqCst) != request))
                                )).unwrap_or_else(|_| Err("stream decoder panicked".into()));
                                if current.load(Ordering::SeqCst) != request { return; }
                                let _ = tx.send(AudioCmd::PreloadPrepared(prepared, gain, request));
                            });
                        }
                        AudioCmd::PlayPrepared(prepared, gain, epoch, _rr, request) => {
                            if stream_request_t.load(Ordering::Relaxed) == request {
                                let new_sink = Arc::new(Sink::connect_new(stream.mixer()));
                                new_sink.pause();
                                new_sink.set_volume(*vol_t.lock().unwrap_or_else(|e| e.into_inner()));
                                match prepared {
                                    Ok(dec) => append_source(&new_sink, dec, gain, agc_on),
                                    Err(e) => {
                                        let _guard = sink_t.lock().unwrap_or_else(|e| e.into_inner());
                                        if stream_request_t.load(Ordering::SeqCst) != request { return; }
                                        let clean = strip_url(&e);
                                        let msg = format!("can't play this stream: {clean}");
                                        eprintln!("[audio] {msg}");
                                        *err_t.lock().unwrap_or_else(|e| e.into_inner()) = Some(msg);
                                    }
                                }
                                // A stop/new play may have arrived while the
                                // worker was opening. Don't let this obsolete
                                // result take over the sink after cancellation.
                                replace_current_sink(&sink_t, &stream_request_t, request, epoch, new_sink);
                            }
                        }
                        AudioCmd::PreloadPrepared(prepared, gain, request) => {
                            let guard = sink_t.lock().unwrap_or_else(|e| e.into_inner());
                            if stream_request_t.load(Ordering::SeqCst) == request {
                                if let Some(s) = &guard.1 {
                                    match prepared {
                                        Ok(dec) => append_source(&s, dec, gain, agc_on),
                                        Err(e) => {
                                            let clean = strip_url(&e);
                                            let msg = format!("can't preload this stream: {clean}");
                                            eprintln!("[audio] {msg}");
                                            *err_t.lock().unwrap_or_else(|e| e.into_inner()) = Some(msg);
                                        }
                                    }
                                }
                            }
                        }
                        AudioCmd::Clear(epoch, request) => {
                            let s = Arc::new(Sink::connect_new(stream.mixer()));
                            s.set_volume(*vol_t.lock().unwrap_or_else(|e| e.into_inner()));
                            replace_current_sink(&sink_t, &stream_request_t, request, epoch, s);
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
            stream_request,
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
    /// Start a cancellable URL resolution. A newer play/stop invalidates the
    /// token so a slow resolver cannot enqueue audio for an obsolete click.
    pub fn begin_stream_request(&self) -> u64 {
        let guard = self.sink.lock().unwrap_or_else(|e| e.into_inner());
        // Old track/preload errors must not make waitForStreamReady reject the
        // next selection. Keep device startup failures when no sink exists.
        if let Some(sink) = &guard.1 {
            // Silence immediately, even when the command loop is still
            // opening an older local file or a queued Clear gets superseded.
            sink.stop();
            *self.last_err.lock().unwrap_or_else(|e| e.into_inner()) = None;
        }
        self.stream_request.fetch_add(1, Ordering::SeqCst) + 1
    }
    pub fn stream_request_current(&self, token: u64) -> bool {
        self.stream_request.load(Ordering::SeqCst) == token
    }
    pub fn current_stream_request(&self) -> u64 {
        self.stream_request.load(Ordering::SeqCst)
    }
    fn with_sink<R>(&self, f: impl FnOnce(&Sink) -> R) -> Option<R> {
        let sink = self.sink.lock().unwrap_or_else(|e| e.into_inner()).1.clone();
        sink.as_ref().map(|s| f(s))
    }

    pub fn play(&self, path: String, gain: f32) -> u64 {
        let request = self.begin_stream_request();
        let e = self.bump_epoch();
        self.send(AudioCmd::Play(path, gain, e, request));
        e
    }
    pub fn preload(&self, path: String, gain: f32) {
        self.send(AudioCmd::Preload(path, gain, self.current_stream_request()));
    }
    pub fn play_url(&self, url: String, gain: f32, rr: Option<ReResolve>) -> u64 {
        let request = self.begin_stream_request();
        self.play_url_current(url, gain, rr, request)
    }
    pub fn play_url_current(&self, url: String, gain: f32, rr: Option<ReResolve>, request: u64) -> u64 {
        let e = self.bump_epoch();
        self.send(AudioCmd::PlayUrl(url, gain, e, rr, request));
        e
    }
    pub fn preload_url(&self, url: String, gain: f32, rr: Option<ReResolve>) {
        let request = self.current_stream_request();
        self.preload_url_current(url, gain, rr, request);
    }
    pub fn preload_url_current(&self, url: String, gain: f32, rr: Option<ReResolve>, request: u64) {
        self.send(AudioCmd::PreloadUrl(url, gain, rr, request));
    }
    pub fn stop(&self) -> u64 {
        let request = self.begin_stream_request();
        let e = self.bump_epoch();
        self.send(AudioCmd::Clear(e, request));
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

#[cfg(test)]
mod tests {
    use super::*;

    fn controller_without_device() -> (AudioController, std::sync::mpsc::Receiver<AudioCmd>) {
        let (tx, rx) = channel();
        (AudioController {
            tx: Mutex::new(tx),
            sink: Arc::new(Mutex::new((0, None))),
            next_epoch: AtomicU64::new(0),
            stream_request: Arc::new(AtomicU64::new(0)),
            agc: Arc::new(AtomicBool::new(false)),
            vol: Arc::new(Mutex::new(0.8)),
            last_err: Arc::new(Mutex::new(None)),
            info: Arc::new(Mutex::new(String::new())),
        }, rx)
    }

    #[test]
    fn cancelled_resolution_cannot_adopt_the_new_request() {
        let (audio, rx) = controller_without_device();
        let original_request = audio.begin_stream_request();
        assert!(audio.stream_request_current(original_request));
        audio.stop(); // cancellation after resolver's check, before enqueue
        audio.play_url_current("http://127.0.0.1/unused".into(), 1.0, None, original_request);
        let _ = rx.recv().unwrap();
        match rx.recv().unwrap() {
            AudioCmd::PlayUrl(_, _, _, _, request) => assert_eq!(request, original_request),
            _ => panic!("expected stream play"),
        }
    }

    #[test]
    fn sink_operation_does_not_hold_the_controller_lock() {
        let (audio, _rx) = controller_without_device();
        let (sink, _output) = Sink::new();
        audio.sink.lock().unwrap().1 = Some(Arc::new(sink));
        audio.with_sink(|_| assert!(audio.sink.try_lock().is_ok(), "seek must not block stop/status"));
    }

    #[test]
    fn cancelled_prepared_sink_cannot_replace_the_active_sink() {
        let (audio, _rx) = controller_without_device();
        let request = audio.begin_stream_request();
        let (first, _first_output) = Sink::new();
        let first = Arc::new(first);
        assert!(replace_current_sink(&audio.sink, &audio.stream_request, request, 7, first.clone()));
        audio.stop();
        let (stale, _stale_output) = Sink::new();
        assert!(!replace_current_sink(&audio.sink, &audio.stream_request, request, 8, Arc::new(stale)));
        let guard = audio.sink.lock().unwrap();
        assert_eq!(guard.0, 7);
        assert!(Arc::ptr_eq(guard.1.as_ref().unwrap(), &first));
    }

    #[test]
    fn preparation_queue_bounds_concurrency_and_discards_obsolete_waiters() {
        let queue = preparation_queue();
        let current = Arc::new(AtomicU64::new(1));
        let gate = Arc::new((Mutex::new(false), std::sync::Condvar::new()));
        let (started_tx, started_rx) = channel();
        // Occupy the three workers, leaving all further work queued.
        for _ in 0..3 {
            let gate = gate.clone();
            let started = started_tx.clone();
            queue_preparation(&queue, current.clone(), 1, move || {
                started.send(()).unwrap();
                let (lock, cv) = &*gate;
                let mut released = lock.lock().unwrap();
                while !*released { released = cv.wait(released).unwrap(); }
            });
        }
        for _ in 0..3 { started_rx.recv_timeout(Duration::from_secs(2)).unwrap(); }
        let (opened_tx, opened_rx) = channel();
        queue_preparation(&queue, current.clone(), 1, move || { opened_tx.send(()).unwrap(); });
        let premature = opened_rx.recv_timeout(Duration::from_millis(50));
        current.store(2, Ordering::SeqCst);
        let (lock, cv) = &*gate;
        *lock.lock().unwrap() = true;
        cv.notify_all();
        assert!(matches!(premature, Err(std::sync::mpsc::RecvTimeoutError::Timeout)), "more than three probes ran concurrently");
        // Disconnection proves the obsolete task was discarded without running
        // its opening callback, rather than merely still waiting in the queue.
        assert!(matches!(opened_rx.recv_timeout(Duration::from_secs(2)), Err(std::sync::mpsc::RecvTimeoutError::Disconnected)));
        let (fresh_tx, fresh_rx) = channel();
        queue_preparation(&queue, current, 2, move || { fresh_tx.send(()).unwrap(); });
        fresh_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    }
    #[test]
    #[ignore = "explicit live YouTube network/decoder smoke test"]
    fn live_stream_starts_and_seeks_without_downloading_the_whole_track() {
        let id = std::env::var("MUSICPLAYER_TEST_VIDEO").unwrap_or_else(|_| "dQw4w9WgXcQ".into());
        let started = std::time::Instant::now();
        let url = tauri::async_runtime::block_on(crate::ytnative::stream_url(&id)).expect("live URL resolution");
        let resolved = started.elapsed();
        let mut source = open_url_source(url, None, false, Arc::new(|| false)).expect("HTTP decoder must open");
        let samples = source.sample_rate() as usize * source.channels() as usize;
        let head: Vec<_> = source.by_ref().take(samples).collect();
        assert_eq!(head.len(), samples);
        assert!(head.iter().all(|s| s.is_finite()));
        let initial = started.elapsed();
        source.try_seek(Duration::from_secs(45)).expect("seek to a later part");
        assert_eq!(source.by_ref().take(samples).count(), samples);
        // Exercise multiple HTTP blocks, not just the already buffered intro.
        assert_eq!(source.by_ref().take(samples * 100).count(), samples * 100);
        eprintln!("live stream: resolution={resolved:?}, first decoded second={initial:?}, seek decoded successfully");
    }
}
