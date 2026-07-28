//! Desktop media integration — MPRIS over D-Bus on Linux (via souvlaki, pure-Rust
//! zbus backend, so no libdbus needed inside a container). This is what makes
//! KDE/GNOME media widgets, playerctl and media keys see the current track.
//! Commands push state from the frontend; widget/media-key actions come back as
//! "media" Tauri events the frontend listens to.

#![allow(unused_variables, dead_code, unused_imports)]

#[cfg(all(unix, not(target_os = "android")))]
use souvlaki::{
    MediaControlEvent, MediaControls, MediaMetadata, MediaPlayback, MediaPosition, PlatformConfig,
    SeekDirection,
};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

#[cfg(any(not(unix), target_os = "android"))]
pub struct MediaControls;

#[derive(Default)]
pub struct MediaState(pub Mutex<Option<MediaControls>>);

/// Called once at app setup so the player shows up in desktop media widgets
/// immediately; also serves as a lazy fallback from the commands below.
pub fn init(app: &AppHandle, state: &MediaState) -> Result<(), String> {
    ensure(app, state)
}

#[cfg(any(not(unix), target_os = "android"))]
fn ensure(_app: &AppHandle, _state: &MediaState) -> Result<(), String> {
    Ok(())
}

#[cfg(all(unix, not(target_os = "android")))]
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
    *guard = Some(controls);
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
    ensure(&app, &state)?;
    #[cfg(all(unix, not(target_os = "android")))]
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
    Ok(())
}

#[tauri::command]
pub fn media_playback(
    app: AppHandle,
    state: State<MediaState>,
    playing: bool,
    position_secs: f64,
) -> Result<(), String> {
    ensure(&app, &state)?;
    #[cfg(all(unix, not(target_os = "android")))]
    if let Some(c) = state.0.lock().map_err(|_| "media lock")?.as_mut() {
        let progress = Some(MediaPosition(Duration::from_secs_f64(position_secs.max(0.0))));
        let pb = if playing {
            MediaPlayback::Playing { progress }
        } else {
            MediaPlayback::Paused { progress }
        };
        c.set_playback(pb).map_err(|e| format!("{e:?}"))?;
    }
    Ok(())
}
