//! Desktop media integration.
//! - **Linux** : MPRIS over D-Bus (KDE/GNOME widgets, playerctl).
//! - **Windows** : SMTC — the OS media flyout, the volume OSD and, crucially,
//!   headset media keys (play/pause/skip sent over Bluetooth/USB) all go through
//!   it. Without this module being a no-op on Windows, Music Player never showed
//!   up and the headset buttons did nothing on it.
//! - **macOS** : MPNowPlayingInfoCenter (souvlaki's backend).
//! Commands push state from the frontend; widget/media-key actions come back as
//! "media" Tauri events the frontend listens to.
//!
//! souvlaki's MPRIS backend is only compiled on Linux (the `use_zbus` feature is
//! declared there); on Windows souvlaki is pulled with NO platform feature, so
//! it builds its native SMTC backend — exactly what the OS flyout and headsets
//! use. We never import the raw `souvlaki::platform` path from here; the whole
//! crate re-exports `MediaControls` at the root, which keeps this file portable
//! across all desktop OSes.

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
    win.hwnd().ok().map(|h| h.0 as *mut std::ffi::c_void)
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

#[tauri::command]
pub fn media_update(
    app: AppHandle,
    state: State<MediaState>,
    title: String,
    artist: String,
    album: String,
    art: String,
    duration_secs: f64,
) -> Result<(), String> {
    #[cfg(not(target_os = "android"))]
    {
        init(&app, &state)?;
        if let Some(c) = state.0.lock().map_err(|_| "media lock")?.as_mut() {
            c.set_metadata(MediaMetadata {
                title: Some(&title),
                artist: Some(&artist),
                album: Some(&album),
                cover_url: if art.is_empty() { None } else { Some(&art) },
                duration: (duration_secs > 0.0).then(|| Duration::from_secs_f64(duration_secs)),
            })
            .map_err(|e| format!("{e:?}"))?;
        }
    }
    Ok(())
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
