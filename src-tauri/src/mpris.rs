//! Windows SMTC integration for the media flyout, volume OSD and headset keys.
//!
//! Commands push state from the frontend; widget/media-key actions come back as
//! "media" Tauri events the frontend listens to.

#[cfg(not(target_os = "android"))]
use souvlaki::{
    MediaControlEvent, MediaControls, MediaMetadata, MediaPlayback, MediaPosition, PlatformConfig,
    SeekDirection,
};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

// Stub on Android (souvlaki's SMTC Windows backend needs HWND, MPRIS needs D-Bus
// — both are meaningless on Android, where Tauri routes via the webview anyway).
#[cfg(target_os = "android")]
pub struct MediaControls;

#[derive(Default)]
pub struct MediaState(pub Mutex<Option<MediaControls>>);

/// Called once at app setup so the player shows up in desktop media widgets
/// immediately; also serves as a lazy fallback from the commands below.
pub fn init(app: &AppHandle, state: &MediaState) -> Result<(), String> {
    // SMTC on Windows *requires* an HWND; on Linux it is unused and the MPRIS
    // name drives everything. Grab the window once at setup so Windows works.
    #[cfg(target_os = "windows")]
    ensure_with_hwnd(app, state)?;
    #[cfg(not(target_os = "windows"))]
    ensure(app, state)?;
    Ok(())
}

// Sous Android, Tauri 2 ne fournit ni plugin MediaSession (boutons casque,
// notification média) ni Service en avant-plan. La lecture tient tant que le
// process a la priorité CPU ; dès que l'écran s'éteint ou l'app tombe en
// arrière-plan, Android peut la tuer. Un vrai fix passerait par un Foreground
// Service Kotlin (PlayerService) + MediaSession branchés au JNI ; pour
// l'instant on déclare au moins les permissions associées dans android.yml.
#[cfg(target_os = "android")]
fn ensure(_app: &AppHandle, _state: &MediaState) -> Result<(), String> {
    Ok(())
}

#[cfg(all(not(target_os = "android"), not(target_os = "windows")))]
fn ensure(app: &AppHandle, state: &MediaState) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|_| "media lock poisoned")?;
    if guard.is_some() {
        return Ok(());
    }
    let config = PlatformConfig {
        dbus_name: "musicplayer", // → org.mpris.MediaPlayer2.musicplayer
        display_name: "Music Player",
        hwnd: None,
    };
    let mut controls = MediaControls::new(config).map_err(|e| format!("{e:?}"))?;
    attach(app, &mut controls)?;
    *guard = Some(controls);
    Ok(())
}

/// Windows path: souvlaki's SMTC backend dies inside `MediaControls::new` without
/// a window handle, so we must resolve the main Tauri WebviewWindow first. All of
/// this lives behind `cfg(target_os = "windows")` so the Linux/macOS build above
/// stays completely untouched.
#[cfg(target_os = "windows")]
fn ensure_with_hwnd(app: &AppHandle, state: &MediaState) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|_| "media lock poisoned")?;
    if guard.is_some() {
        return Ok(());
    }
    let hwnd = fetch_hwnd(app).ok_or("SMTC: could not resolve main window HWND")?;
    let config = PlatformConfig {
        dbus_name: "musicplayer",
        display_name: "Music Player",
        hwnd: Some(hwnd),
    };
    let mut controls = MediaControls::new(config).map_err(|e| format!("{e:?}"))?;
    attach(app, &mut controls)?;
    *guard = Some(controls);
    Ok(())
}

/// Resolve the Tauri window's real Win32 HWND for souvlaki's SMTC backend.
/// Returns the raw pointer souvlaki expects; `None` while the webview is still
/// starting (the lazy `ensure` below re-tries on the next track, so a cold start
/// that races the webview just delays SMTC by one metadata push).
#[cfg(target_os = "windows")]
fn fetch_hwnd(app: &AppHandle) -> Option<*mut std::ffi::c_void> {
    let win = app.get_webview_window("main")?;
    win.hwnd().ok().map(|h| h.0)
}

#[cfg(not(target_os = "android"))]
fn attach(app: &AppHandle, controls: &mut MediaControls) -> Result<(), String> {
    let handle = app.clone();
    controls
        .attach(move |event| {
            let msg = match event {
                MediaControlEvent::Play => "play".to_string(),
                MediaControlEvent::Pause => "pause".to_string(),
                MediaControlEvent::Toggle => "toggle".to_string(),
                MediaControlEvent::Next => "next".to_string(),
                MediaControlEvent::Previous => "previous".to_string(),
                MediaControlEvent::Stop => "pause".to_string(),
                MediaControlEvent::SetPosition(MediaPosition(d)) => {
                    format!("position:{}", d.as_secs_f64())
                }
                MediaControlEvent::SeekBy(dir, d) => {
                    let secs = d.as_secs_f64();
                    match dir {
                        SeekDirection::Forward => format!("seekby:{secs}"),
                        SeekDirection::Backward => format!("seekby:-{secs}"),
                    }
                }
                MediaControlEvent::Seek(dir) => match dir {
                    SeekDirection::Forward => "seekby:10".to_string(),
                    SeekDirection::Backward => "seekby:-10".to_string(),
                },
                _ => return,
            };
            let _ = handle.emit("media", msg);
        })
        .map_err(|e| format!("{e:?}"))?;
    Ok(())
}

/// Windows keeps the previous cover when given none, and never showed the ones
/// given as a URL: local tracks and streams alike had no cover, or the last one seen.
/// Every cover goes through a file instead. Two names in turn, so the file Windows
/// may still be reading is never rewritten under it.
static COVER_TURN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
const NO_COVER: &[u8] = include_bytes!("../icons/128x128.png");

fn cover_file(data: &[u8], mime: &str) -> Option<String> {
    let ext = if mime.contains("png") { "png" } else { "jpg" };
    let turn = COVER_TURN.fetch_xor(true, std::sync::atomic::Ordering::Relaxed);
    let dir = std::env::temp_dir().join("musicplayer-smtc");
    std::fs::create_dir_all(&dir).ok()?;
    let file = dir.join(format!("cover-{}.{ext}", u8::from(turn)));
    std::fs::write(&file, data).ok()?;
    Some(format!("file://{}", file.display()))
}

/// Newest update wins: covers are read off the UI thread, so a quick skip through
/// several tracks must not end on an older track's details.
static LATEST_UPDATE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

#[derive(Clone)]
struct TrackDetails {
    title: String,
    artist: String,
    album: String,
    duration_secs: f64,
}

/// What the flyout shows now. The frontend sends a track again once its duration is
/// known: the same cover must not flicker through the icon or be downloaded twice.
struct Shown {
    track: TrackDetails,
    source: String,
    cover: Option<String>,
}
static SHOWN: Mutex<Option<Shown>> = Mutex::new(None);

fn publish(state: &MediaState, track: &TrackDetails, cover: Option<&str>) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|_| "media lock")?;
    if let Some(controls) = guard.as_mut() {
        let metadata = |cover_url| MediaMetadata {
            title: Some(&track.title),
            artist: Some(&track.artist),
            album: Some(&track.album),
            cover_url,
            duration: (track.duration_secs > 0.0).then(|| Duration::from_secs_f64(track.duration_secs)),
        };
        // A cover that will not load must not cost the title: on failure the
        // display is never committed and keeps showing the previous track.
        controls
            .set_metadata(metadata(cover))
            .or_else(|_| controls.set_metadata(metadata(None)))
            .map_err(|e| format!("{e:?}"))?;
    }
    Ok(())
}

fn update_media(app: AppHandle, track: TrackDetails, art: String, path: Option<String>) -> Result<(), String> {
    use std::sync::atomic::Ordering;
    let update = LATEST_UPDATE.fetch_add(1, Ordering::SeqCst) + 1;
    let state = app.state::<MediaState>();
    init(&app, &state)?;
    let local = path.as_deref().filter(|p| !p.is_empty() && !p.starts_with("yt:"));
    let source = if art.is_empty() { local.unwrap_or_default().to_string() } else { art.clone() };
    {
        let mut shown = SHOWN.lock().map_err(|_| "media lock")?;
        if let Some(current) = shown.as_mut().filter(|current| current.source == source) {
            current.track = track.clone();
            return publish(&state, &track, current.cover.as_deref());
        }
    }
    let picture = local.and_then(crate::library::embedded_picture);
    let (data, mime) = picture.unwrap_or_else(|| (NO_COVER.to_vec(), "image/png".into()));
    let mut shown = SHOWN.lock().map_err(|_| "media lock")?;
    if LATEST_UPDATE.load(Ordering::SeqCst) != update {
        return Ok(());
    }
    let cover = cover_file(&data, &mime);
    publish(&state, &track, cover.as_deref())?;
    *shown = Some(Shown { track, source, cover });
    drop(shown);
    // The title shows at once; the thumbnail follows.
    if !art.is_empty() {
        let app = app.clone();
        std::thread::spawn(move || {
            let Ok((data, mime)) = crate::library::fetch_remote_image(&art) else { return };
            let Ok(mut shown) = SHOWN.lock() else { return };
            // Checked before writing: an older track must not take the file's turn.
            let Some(current) = shown.as_mut().filter(|current| current.source == art) else { return };
            current.cover = cover_file(&data, &mime);
            let _ = publish(&app.state::<MediaState>(), &current.track, current.cover.as_deref());
        });
    }
    Ok(())
}

// Off the UI thread: reads the track's tags, and Windows loads the file synchronously.
#[tauri::command]
pub async fn media_update(
    app: AppHandle,
    title: String,
    artist: String,
    album: String,
    art: String,
    duration_secs: f64,
    path: Option<String>,
) -> Result<(), String> {
    let track = TrackDetails { title, artist, album, duration_secs };
    tauri::async_runtime::spawn_blocking(move || update_media(app, track, art, path))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn media_playback(
    app: AppHandle,
    state: State<MediaState>,
    playing: bool,
    position_secs: f64,
) -> Result<(), String> {
    #[cfg(not(target_os = "android"))]
    {
        init(&app, &state)?;
        if let Some(c) = state.0.lock().map_err(|_| "media lock")?.as_mut() {
            let progress = Some(MediaPosition(Duration::from_secs_f64(position_secs.max(0.0))));
            let pb = if playing {
                MediaPlayback::Playing { progress }
            } else {
                MediaPlayback::Paused { progress }
            };
            c.set_playback(pb).map_err(|e| format!("{e:?}"))?;
        }
    }
    Ok(())
}
