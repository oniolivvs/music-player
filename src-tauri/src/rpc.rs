//! Discord Rich Presence (optional). Connects to the local Discord IPC socket and
//! shows the current track. Requires a Discord Application (Client ID) the user
//! creates + the Discord client running — so every op is best-effort and never
//! panics: failures are returned as strings and the frontend just ignores them.

use discord_rich_presence::{activity, DiscordIpc, DiscordIpcClient};
use std::sync::Mutex;
use tauri::State;

/// Holds the connected client alongside the client-id it was opened with, so we
/// can reconnect when the id changes.
#[derive(Default)]
pub struct RpcState(pub Mutex<Option<(String, DiscordIpcClient)>>);

/// The discord-rich-presence crate only looks at $XDG_RUNTIME_DIR/discord-ipc-N
/// (or /tmp). Flatpak clients (Vesktop, Discord) expose their socket elsewhere,
/// and a stale symlink from a previously-used client breaks connects with
/// ENOENT. Repair the canonical path before every (re)connect.
/// Unix-only: on Windows the crate connects over a named pipe, no symlink needed.
#[cfg(not(unix))]
fn ensure_ipc_link() {}

#[cfg(unix)]
fn ensure_ipc_link() {
    let run = std::env::var("XDG_RUNTIME_DIR").unwrap_or_default();
    let run = if !run.is_empty() {
        run
    } else {
        // GUI launchers sometimes omit it — find the user runtime dir ourselves.
        let guess = std::fs::read_dir("/run/user")
            .ok()
            .and_then(|mut d| d.next())
            .and_then(|e| e.ok())
            .map(|e| e.path().to_string_lossy().into_owned());
        match guess {
            Some(g) => {
                std::env::set_var("XDG_RUNTIME_DIR", &g); // so the crate finds it too
                g
            }
            None => return,
        }
    };
    let base = format!("{run}/discord-ipc-0");
    // metadata() follows symlinks: Err = missing OR dangling link.
    if std::fs::metadata(&base).is_ok() {
        return;
    }
    let candidates = [
        format!("{run}/.flatpak/dev.vencord.Vesktop/xdg-run/discord-ipc-0"),
        format!("{run}/app/dev.vencord.Vesktop/discord-ipc-0"),
        format!("{run}/.flatpak/com.discordapp.Discord/xdg-run/discord-ipc-0"),
        format!("{run}/app/com.discordapp.Discord/discord-ipc-0"),
        format!("{run}/snap.discord/discord-ipc-0"),
    ];
    for c in candidates {
        if std::fs::metadata(&c).is_ok() {
            let _ = std::fs::remove_file(&base); // drop any stale symlink
            let _ = std::os::unix::fs::symlink(&c, &base);
            return;
        }
    }
}

#[tauri::command]
pub fn rpc_update(
    state: State<RpcState>,
    client_id: String,
    title: String,
    artist: String,
    playing: bool,
    art: Option<String>,
    duration_secs: Option<f64>,
    position_secs: Option<f64>,
) -> Result<(), String> {
    if client_id.trim().is_empty() {
        return Err("no client id".into());
    }
    let mut guard = state.0.lock().map_err(|_| "rpc lock")?;

    let reconnect = match &*guard {
        Some((id, _)) => id != &client_id,
        None => true,
    };
    if reconnect {
        if let Some((_, mut old)) = guard.take() {
            let _ = old.close();
        }
        ensure_ipc_link();
        let mut client = DiscordIpcClient::new(&client_id).map_err(|e| e.to_string())?;
        client.connect().map_err(|e| e.to_string())?;
        *guard = Some((client_id.clone(), client));
    }

    if let Some((_, client)) = guard.as_mut() {
        let details = if title.is_empty() { "Idle".to_string() } else { title };
        // Paused: make the state unambiguous — Discord has no native "paused"
        // rendering, and with no timestamps attached the elapsed counter stops.
        let base_state = if artist.is_empty() { "—".to_string() } else { artist };
        let state_line = if playing { base_state } else { format!("⏸ Paused — {base_state}") };
        let status = if playing { "Playing" } else { "Paused" };
        // "Listening to …" with the track's artwork — the http(s) thumbnail URL
        // is accepted directly as an asset by modern Discord clients / arRPC.
        let art = art.unwrap_or_default();
        let mut assets = activity::Assets::new().large_text(status);
        if art.starts_with("http") {
            assets = assets.large_image(&art);
        }
        let mut act = activity::Activity::new()
            .activity_type(activity::ActivityType::Listening)
            .details(&details)
            .state(&state_line)
            .assets(assets);
        // Progress bar: start/end timestamps derived from position + duration.
        let dur = duration_secs.unwrap_or(0.0);
        let pos = position_secs.unwrap_or(0.0).clamp(0.0, dur.max(0.0));
        if playing && dur > 0.0 {
            let now_ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);
            let start = now_ms - (pos * 1000.0) as i64;
            act = act.timestamps(
                activity::Timestamps::new()
                    .start(start)
                    .end(start + (dur * 1000.0) as i64),
            );
        }
        if let Err(e) = client.set_activity(act) {
            // Connection died (Discord/Vesktop restarted): drop it so the next
            // update reconnects from scratch.
            if let Some((_, mut dead)) = guard.take() {
                let _ = dead.close();
            }
            return Err(e.to_string());
        }
    }
    Ok(())
}

#[tauri::command]
pub fn rpc_clear(state: State<RpcState>) {
    if let Ok(mut guard) = state.0.lock() {
        // Keep the connection alive: closing the socket right after the clear
        // frame can race the client (arRPC/Vesktop) into keeping the presence
        // visible, and the next update would needlessly re-handshake anyway.
        if let Some((_, client)) = guard.as_mut() {
            if client.clear_activity().is_ok() {
                return;
            }
        }
        // Clear failed → connection is dead; drop it so the next update reconnects.
        if let Some((_, mut dead)) = guard.take() {
            let _ = dead.close();
        }
    }
}
