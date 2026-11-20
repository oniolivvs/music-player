//! Audio output that outlives any single Windows device.
//!
//! rodio ties its mixer to one `OutputStream`, and that stream to whichever device
//! was the default when it opened. On Windows that meant: switching to a headset
//! left the music on the old device, unplugging one killed the sound until the app
//! restarted (and `Sink::try_seek` then waited forever for samples nobody pulled),
//! and the stream stayed open from launch to exit, so the session read as active:
//! a wireless headset never slept and Windows could count the PC as busy.
//!
//! Here every sink plays into one permanent master mixer. A device is only a
//! consumer of that mix, opened when something is audible and swapped or closed at
//! will, so tracks, positions and the gapless queue survive any device change.

use rodio::cpal::traits::{DeviceTrait, HostTrait};
use rodio::mixer::{self, Mixer, MixerSource};
use rodio::{cpal, OutputStream, OutputStreamBuilder, Source};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

/// Format of the master mix when no device exists yet at launch.
const FALLBACK_FORMAT: (u16, u32) = (2, 48_000);
/// Samples moved from the mix per lock: about 3 ms, so a device swap loses
/// nothing audible and the audio callback does not lock once per sample.
const TAP_BLOCK_FRAMES: usize = 128;
/// Paused or silent for this long: release the device. Short pauses and track
/// changes must not reopen it, but a headset has to be able to go to sleep.
const IDLE_CLOSE: Duration = Duration::from_secs(20);
const TICK: Duration = Duration::from_millis(250);
const DEVICE_CHECK_EVERY: Duration = Duration::from_secs(1);
const OPEN_RETRY_EVERY: Duration = Duration::from_secs(1);
/// Audible but the device stopped asking for samples, without reporting an error.
/// Generous: a Bluetooth device can take seconds to start.
const STALL_AFTER: Duration = Duration::from_secs(8);
/// With no device open, what `Pump` drains from the mix: enough for a pending seek
/// or a stopped decoder to be handled (rodio checks both every 5 ms of audio).
const PUMP_MILLIS: u32 = 20;
const NO_DEVICE: &str = "no audio output device";

pub enum OutputEvent {
    /// Something may have become audible: re-evaluate now, not at the next tick.
    Wake,
    /// With no device open, run the mix briefly so seeks and stops still complete.
    Pump,
    /// The stream of this generation reported an error.
    Lost(u64, String),
}

/// How the device's pull is going, for telling a dead device from a slow decoder.
#[derive(Default)]
struct TapActivity {
    blocks: AtomicU64,
    in_mix: AtomicBool,
}

/// One device's view of the master mix. Never ends: an empty mixer yields `None`,
/// and rodio would remove a finished source from the device's own mixer.
struct MasterTap {
    mix: Arc<Mutex<MixerSource>>,
    activity: Arc<TapActivity>,
    channels: u16,
    rate: u32,
    block: Vec<f32>,
    pos: usize,
}

impl MasterTap {
    fn new(mix: Arc<Mutex<MixerSource>>, activity: Arc<TapActivity>, channels: u16, rate: u32) -> Self {
        let block = vec![0.0; TAP_BLOCK_FRAMES * channels as usize];
        let pos = block.len();
        Self { mix, activity, channels, rate, block, pos }
    }
}

impl Iterator for MasterTap {
    type Item = f32;

    #[inline]
    fn next(&mut self) -> Option<f32> {
        if self.pos == self.block.len() {
            // A stream decoder can wait for the network in here.
            self.activity.in_mix.store(true, Ordering::Relaxed);
            // Whole frames only: the next device must start on a left sample, or
            // the channels would come out swapped after a device change.
            let mut mix = self.mix.lock().unwrap_or_else(|e| e.into_inner());
            for slot in &mut self.block {
                *slot = mix.next().unwrap_or(0.0);
            }
            drop(mix);
            self.activity.in_mix.store(false, Ordering::Relaxed);
            self.activity.blocks.fetch_add(1, Ordering::Relaxed);
            self.pos = 0;
        }
        let sample = self.block[self.pos];
        self.pos += 1;
        Some(sample)
    }
}

impl Source for MasterTap {
    fn current_span_len(&self) -> Option<usize> {
        None
    }
    fn channels(&self) -> u16 {
        self.channels
    }
    fn sample_rate(&self) -> u32 {
        self.rate
    }
    fn total_duration(&self) -> Option<Duration> {
        None
    }
}

#[derive(Debug, PartialEq)]
enum Step {
    Stay,
    Open,
    Close,
    Reopen,
}

fn decide(open: bool, audible: bool, moved: bool, idle_for: Duration) -> Step {
    match (open, audible) {
        (false, true) => Step::Open,
        (false, false) => Step::Stay,
        (true, true) if moved => Step::Reopen,
        (true, true) => Step::Stay,
        // Paused: no reason to wake the new device, resume opens the right one.
        (true, false) if moved || idle_for >= IDLE_CLOSE => Step::Close,
        (true, false) => Step::Stay,
    }
}

/// The master mix lasts for the whole session, so it takes the launch device's format
/// only if that is a real music format: starting on a headset in hands-free mode
/// (mono, 16 kHz) must not keep all later output mono and telephone-quality.
fn mix_format(device: Option<(u16, u32)>) -> (u16, u32) {
    let (channels, rate) = device.unwrap_or(FALLBACK_FORMAT);
    (channels.max(FALLBACK_FORMAT.0), if rate >= 44_100 { rate } else { FALLBACK_FORMAT.1 })
}

fn default_device_name() -> Option<String> {
    cpal::default_host().default_output_device()?.name().ok()
}

fn default_format() -> Option<(u16, u32)> {
    let config = cpal::default_host().default_output_device()?.default_output_config().ok()?;
    Some((config.channels(), config.sample_rate().0))
}

fn open_default(
    on_error: impl FnMut(cpal::StreamError) + Clone + Send + 'static,
) -> Result<(OutputStream, String), String> {
    let device = cpal::default_host().default_output_device().ok_or("no default device")?;
    let name = device.name().unwrap_or_else(|_| "Default device".into());
    let mut stream = OutputStreamBuilder::from_device(device)
        .map_err(|e| e.to_string())?
        .with_error_callback(on_error)
        .open_stream_or_fallback()
        .map_err(|e| e.to_string())?;
    stream.log_on_drop(false);
    Ok((stream, name))
}

fn standby_text(device: Option<String>) -> String {
    device.map(|name| format!("{name} · standby")).unwrap_or_default()
}

fn pump_mix(mix: &Mutex<MixerSource>, samples: usize) {
    let mut mix = mix.lock().unwrap_or_else(|e| e.into_inner());
    for _ in 0..samples {
        let _ = mix.next();
    }
}

struct OutputRouter {
    mixer: Mixer,
    mix: Arc<Mutex<MixerSource>>,
    activity: Arc<TapActivity>,
    channels: u16,
    rate: u32,
    open: Option<(OutputStream, String)>,
    generation: u64,
    events: Sender<OutputEvent>,
    last_err: Arc<Mutex<Option<String>>>,
    info: Arc<Mutex<String>>,
    last_device: String,
    idle_since: Option<Instant>,
    retry_at: Option<Instant>,
    device_check_at: Instant,
    last_pulled: u64,
    last_progress: Instant,
}

impl OutputRouter {
    fn new(events: Sender<OutputEvent>, last_err: Arc<Mutex<Option<String>>>, info: Arc<Mutex<String>>) -> Self {
        let (channels, rate) = mix_format(default_format());
        let (mixer, source) = mixer::mixer(channels, rate);
        *info.lock().unwrap_or_else(|e| e.into_inner()) = standby_text(default_device_name());
        let now = Instant::now();
        Self {
            mixer,
            mix: Arc::new(Mutex::new(source)),
            activity: Arc::default(),
            channels,
            rate,
            open: None,
            generation: 0,
            events,
            last_err,
            info,
            last_device: String::new(),
            idle_since: None,
            retry_at: None,
            device_check_at: now,
            last_pulled: 0,
            last_progress: now,
        }
    }

    fn set_info(&self, text: String) {
        *self.info.lock().unwrap_or_else(|e| e.into_inner()) = text;
    }

    fn pump(&self) {
        if self.open.is_none() {
            let samples = (self.rate * PUMP_MILLIS / 1000) as usize * self.channels as usize;
            pump_mix(&self.mix, samples);
        }
    }

    fn lost(&mut self, generation: u64, why: &str) {
        if generation == self.generation && self.open.is_some() {
            let _ = crate::diagnostics::record("warn", "audio", "output_lost", why);
            self.close();
        }
    }

    fn close(&mut self) {
        self.open = None;
        self.idle_since = None;
        self.set_info(standby_text(default_device_name()));
    }

    fn try_open(&mut self, now: Instant) {
        self.generation += 1;
        let generation = self.generation;
        let events = self.events.clone();
        let on_error = move |e: cpal::StreamError| {
            let _ = events.send(OutputEvent::Lost(generation, e.to_string()));
        };
        // A driver failure must not take the whole output thread down with it.
        let opened = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| open_default(on_error)))
            .unwrap_or_else(|_| Err("the audio driver panicked".into()));
        let mut last_err = self.last_err.lock().unwrap_or_else(|e| e.into_inner());
        match opened {
            Ok((stream, device)) => {
                stream.mixer().add(MasterTap::new(self.mix.clone(), self.activity.clone(), self.channels, self.rate));
                let config = stream.config();
                let info = format!(
                    "{device} · {} Hz · {} ch · {:?}",
                    config.sample_rate(), config.channel_count(), config.sample_format()
                );
                if last_err.as_deref().is_some_and(|e| e.starts_with(NO_DEVICE)) {
                    *last_err = None;
                }
                drop(last_err);
                if device != self.last_device {
                    let _ = crate::diagnostics::record("info", "audio", "output_device", &info);
                    self.last_device = device.clone();
                }
                self.set_info(info);
                self.open = Some((stream, device));
                self.retry_at = None;
                self.idle_since = None;
                self.device_check_at = now + DEVICE_CHECK_EVERY;
                self.last_progress = now;
            }
            Err(why) => {
                *last_err = Some(format!("{NO_DEVICE}: {why}"));
                drop(last_err);
                self.set_info(String::new());
                self.retry_at = Some(now + OPEN_RETRY_EVERY);
            }
        }
    }

    /// The default device moved (Windows sound settings, headset plugged in).
    fn default_moved(&mut self, now: Instant) -> bool {
        if now < self.device_check_at {
            return false;
        }
        self.device_check_at = now + DEVICE_CHECK_EVERY;
        // No default at all is not a move: the stream's own error reports a removal.
        match (&self.open, default_device_name()) {
            (Some((_, current)), Some(name)) => *current != name,
            _ => false,
        }
    }

    fn stalled(&mut self, audible: bool, now: Instant) -> bool {
        let seen = self.activity.blocks.load(Ordering::Relaxed);
        let waiting_for_decoder = self.activity.in_mix.load(Ordering::Relaxed);
        if !audible || seen != self.last_pulled || waiting_for_decoder {
            self.last_pulled = seen;
            self.last_progress = now;
            return false;
        }
        now.duration_since(self.last_progress) >= STALL_AFTER
    }

    fn tick(&mut self, audible: bool) {
        let now = Instant::now();
        let open = self.open.is_some();
        if audible || !open {
            self.idle_since = None;
        } else if self.idle_since.is_none() {
            self.idle_since = Some(now);
        }
        let moved = open && self.default_moved(now);
        let stalled = open && self.stalled(audible, now);
        if stalled {
            let _ = crate::diagnostics::record("warn", "audio", "output_stalled", "device stopped pulling audio");
        }
        let idle_for = self.idle_since.map_or(Duration::ZERO, |since| now.duration_since(since));
        match decide(open, audible, moved || stalled, idle_for) {
            Step::Stay => {}
            Step::Close => self.close(),
            Step::Reopen => {
                // The old stream must stop pulling before the new one starts, or
                // both would take samples from the same mix.
                self.open = None;
                self.try_open(now);
            }
            Step::Open => {
                if self.retry_at.is_none_or(|at| now >= at) {
                    self.try_open(now);
                }
            }
        }
    }
}

/// Starts the output thread. The mixer arrives through the returned receiver: it
/// needs the device format, and that query must not run COM on the UI thread.
pub fn spawn(
    is_audible: impl Fn() -> bool + Send + 'static,
    last_err: Arc<Mutex<Option<String>>>,
    info: Arc<Mutex<String>>,
) -> (Sender<OutputEvent>, Receiver<Mixer>) {
    let (events, inbox) = channel();
    let (mixer_tx, mixer_rx) = channel();
    let router_events = events.clone();
    thread::spawn(move || {
        let mut router = OutputRouter::new(router_events, last_err, info);
        let _ = mixer_tx.send(router.mixer.clone());
        loop {
            // Nothing audible and no device open: sleep until told otherwise, so an
            // idle app does not wake up four times a second.
            let event = if router.open.is_some() || is_audible() {
                match inbox.recv_timeout(TICK) {
                    Ok(event) => Some(event),
                    Err(RecvTimeoutError::Timeout) => None,
                    Err(RecvTimeoutError::Disconnected) => return,
                }
            } else {
                match inbox.recv() {
                    Ok(event) => Some(event),
                    Err(_) => return,
                }
            };
            match event {
                Some(OutputEvent::Pump) => router.pump(),
                Some(OutputEvent::Lost(generation, why)) => router.lost(generation, &why),
                Some(OutputEvent::Wake) | None => {}
            }
            router.tick(is_audible());
        }
    });
    (events, mixer_rx)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rodio::buffer::SamplesBuffer;
    use rodio::Sink;

    const SECOND: Duration = Duration::from_secs(1);

    #[test]
    fn opens_only_when_audible_and_releases_the_device_when_idle() {
        assert_eq!(decide(false, false, false, Duration::ZERO), Step::Stay);
        assert_eq!(decide(false, true, false, Duration::ZERO), Step::Open);
        assert_eq!(decide(true, true, false, Duration::ZERO), Step::Stay);
        assert_eq!(decide(true, false, false, IDLE_CLOSE - SECOND), Step::Stay);
        assert_eq!(decide(true, false, false, IDLE_CLOSE), Step::Close);
    }

    #[test]
    fn follows_a_device_change_and_leaves_the_new_device_alone_while_paused() {
        assert_eq!(decide(true, true, true, Duration::ZERO), Step::Reopen);
        assert_eq!(decide(true, false, true, Duration::ZERO), Step::Close);
        assert_eq!(decide(false, false, true, Duration::ZERO), Step::Stay);
    }

    fn stereo_marker(frames: usize) -> SamplesBuffer {
        let samples: Vec<f32> = (0..frames).flat_map(|_| [0.5, -0.5]).collect();
        SamplesBuffer::new(2, 48_000, samples)
    }

    #[test]
    fn a_poor_launch_device_does_not_cap_the_session() {
        assert_eq!(mix_format(Some((1, 16_000))), (2, 48_000));
        assert_eq!(mix_format(Some((2, 44_100))), (2, 44_100));
        assert_eq!(mix_format(Some((8, 48_000))), (8, 48_000));
        assert_eq!(mix_format(Some((2, 96_000))), (2, 96_000));
        assert_eq!(mix_format(None), FALLBACK_FORMAT);
    }

    #[test]
    fn a_new_tap_keeps_left_and_right_after_a_device_swap() {
        let (mixer, source) = mixer::mixer(2, 48_000);
        mixer.add(stereo_marker(TAP_BLOCK_FRAMES * 4));
        let mix = Arc::new(Mutex::new(source));
        let pulled: Arc<TapActivity> = Arc::default();
        let mut first = MasterTap::new(mix.clone(), pulled.clone(), 2, 48_000);
        // The old device dies after an odd number of samples, mid-frame.
        for _ in 0..TAP_BLOCK_FRAMES + 1 {
            first.next();
        }
        drop(first);
        let mut second = MasterTap::new(mix, pulled.clone(), 2, 48_000);
        assert_eq!(second.next(), Some(0.5));
        assert_eq!(second.next(), Some(-0.5));
        assert!(pulled.blocks.load(Ordering::Relaxed) >= 2);
        assert!(!pulled.in_mix.load(Ordering::Relaxed));
    }

    #[test]
    fn the_tap_outlives_an_empty_mix() {
        let (_mixer, source) = mixer::mixer(2, 48_000);
        let mut tap = MasterTap::new(Arc::new(Mutex::new(source)), Arc::default(), 2, 48_000);
        for _ in 0..TAP_BLOCK_FRAMES * 8 {
            assert_eq!(tap.next(), Some(0.0));
        }
    }

    #[test]
    fn pumping_completes_a_seek_with_no_device_open() {
        let (mixer, source) = mixer::mixer(2, 48_000);
        let mix = Arc::new(Mutex::new(source));
        let sink = Arc::new(Sink::connect_new(&mixer));
        sink.pause();
        sink.append(stereo_marker(48_000 * 10));
        let (done_tx, done_rx) = channel();
        let seeking = sink.clone();
        thread::spawn(move || {
            let _ = seeking.try_seek(Duration::from_secs(4));
            let _ = done_tx.send(());
        });
        let mut done = false;
        for _ in 0..200 {
            pump_mix(&mix, 48_000 * 2 / 50);
            if done_rx.recv_timeout(Duration::from_millis(5)).is_ok() {
                done = true;
                break;
            }
        }
        assert!(done, "the seek never completed");
        assert_eq!(sink.get_pos(), Duration::from_secs(4));
    }

    #[test]
    fn pumping_a_paused_sink_does_not_consume_the_track() {
        let (mixer, source) = mixer::mixer(2, 48_000);
        let mix = Mutex::new(source);
        let sink = Sink::connect_new(&mixer);
        sink.pause();
        sink.append(stereo_marker(48_000));
        for _ in 0..50 {
            pump_mix(&mix, 48_000 * 2 / 50);
        }
        assert_eq!(sink.get_pos(), Duration::ZERO);
        assert_eq!(sink.len(), 1);
    }
}
