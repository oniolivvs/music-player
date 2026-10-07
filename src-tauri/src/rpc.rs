//! Discord Rich Presence (optional) over Discord's local IPC: the named pipe
//! `\\.\pipe\discord-ipc-N` on Windows, a Unix socket elsewhere. Needs a Discord
//! Application (its ID) and a running client — every op is best-effort and
//! returns errors as strings, never panics.
//!
//! Own client instead of the `discord-rich-presence` crate: the crate always
//! took the first pipe that opened. With Discord and Discord PTB running on two
//! accounts, the presence silently landed on whichever client owned pipe 0 —
//! never on the account the user was looking at. Here each pipe is identified
//! (stable / PTB / Canary + account) and the user picks the target.

use serde::Serialize;
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Manager};

const OP_HANDSHAKE: u32 = 0;
const OP_FRAME: u32 = 1;
const OP_CLOSE: u32 = 2;
const MAX_PIPES: u8 = 10;
/// Discord rejects the whole activity when a text field exceeds 128 characters
/// or is shorter than 2 — long video titles made presence fail without a trace.
const TEXT_MAX: usize = 128;

#[cfg(target_os = "windows")]
type Pipe = std::fs::File;
#[cfg(unix)]
type Pipe = std::os::unix::net::UnixStream;

#[cfg(target_os = "windows")]
fn open_pipe(n: u8) -> std::io::Result<Pipe> {
    std::fs::OpenOptions::new().read(true).write(true).open(format!(r"\\.\pipe\discord-ipc-{n}"))
}

#[cfg(unix)]
fn open_pipe(n: u8) -> std::io::Result<Pipe> {
    let dirs = ["XDG_RUNTIME_DIR", "TMPDIR", "TMP", "TEMP"]
        .iter()
        .filter_map(|k| std::env::var(k).ok())
        .chain(std::iter::once("/tmp".to_string()));
    let mut last = std::io::Error::from(std::io::ErrorKind::NotFound);
    for dir in dirs {
        for sub in ["", "app/com.discordapp.Discord/", ".flatpak/dev.vencord.Vesktop/xdg-run/", "snap.discord/"] {
            match Pipe::connect(format!("{dir}/{sub}discord-ipc-{n}")) {
                Ok(stream) => return Ok(stream),
                Err(e) => last = e,
            }
        }
    }
    Err(last)
}

fn write_frame(w: &mut impl Write, op: u32, payload: &Value) -> std::io::Result<()> {
    let body = serde_json::to_vec(payload)?;
    let mut buf = Vec::with_capacity(8 + body.len());
    buf.extend_from_slice(&op.to_le_bytes());
    buf.extend_from_slice(&(body.len() as u32).to_le_bytes());
    buf.extend_from_slice(&body);
    w.write_all(&buf)?;
    w.flush()
}

fn read_frame(r: &mut impl Read) -> std::io::Result<(u32, Value)> {
    let mut head = [0u8; 8];
    r.read_exact(&mut head)?;
    let op = u32::from_le_bytes([head[0], head[1], head[2], head[3]]);
    let len = u32::from_le_bytes([head[4], head[5], head[6], head[7]]) as usize;
    if len > 1 << 20 {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "oversized frame"));
    }
    let mut body = vec![0u8; len];
    r.read_exact(&mut body)?;
    let value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    Ok((op, value))
}

/// Which Discord build answered, from the API host it reports in READY.
fn client_kind(ready: &Value) -> &'static str {
    let api = ready["data"]["config"]["api_endpoint"].as_str().unwrap_or("");
    if api.contains("ptb.") {
        "ptb"
    } else if api.contains("canary.") {
        "canary"
    } else {
        "discord"
    }
}

#[derive(Clone, Serialize)]
pub struct RpcClientInfo {
    pub pipe: u8,
    pub kind: String,
    pub user: String,
}

/// One handshaken client. Commands are strict request → reply on a single
/// handle: a Windows pipe opened for synchronous I/O serializes reads and
/// writes, so a background reader blocked in ReadFile froze every write — the
/// first version hung on its very first SET_ACTIVITY.
struct Conn {
    info: RpcClientInfo,
    pipe: Arc<Mutex<Pipe>>,
    alive: Arc<AtomicBool>,
}

static NONCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

/// Sends one command and waits (4 s max) for Discord's reply carrying the same
/// nonce. A timeout or broken pipe marks the connection dead; Discord's own
/// ERROR replies come back as the message it gave.
fn command(conn: &Conn, cmd: &str, args: Value) -> Result<Value, String> {
    let nonce = format!("mp-{}", NONCE.fetch_add(1, Ordering::Relaxed));
    let frame = json!({ "cmd": cmd, "args": args, "nonce": nonce });
    let pipe = conn.pipe.clone();
    let alive = conn.alive.clone();
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let result = (|| -> Result<Value, String> {
            let mut stream = pipe.lock().map_err(|_| "pipe lock".to_string())?;
            write_frame(&mut *stream, OP_FRAME, &frame).map_err(|e| e.to_string())?;
            loop {
                let (op, reply) = read_frame(&mut *stream).map_err(|e| e.to_string())?;
                if op == OP_CLOSE {
                    return Err(reply["message"].as_str().unwrap_or("Discord closed the connection").to_string());
                }
                if reply["nonce"] == frame["nonce"] {
                    return Ok(reply);
                }
            }
        })();
        if result.is_err() {
            alive.store(false, Ordering::Relaxed);
        }
        let _ = tx.send(result);
    });
    let reply = rx.recv_timeout(Duration::from_secs(4)).unwrap_or_else(|_| {
        conn.alive.store(false, Ordering::Relaxed);
        Err("Discord did not answer".into())
    })?;
    if reply["evt"] == "ERROR" {
        return Err(reply["data"]["message"].as_str().unwrap_or("Discord refused the activity").to_string());
    }
    Ok(reply)
}

#[derive(Default)]
struct Inner {
    client_id: String,
    target: String,
    conns: Vec<Conn>,
}

#[derive(Default)]
pub struct RpcState(Mutex<Inner>);

/// Handshake on one pipe. Runs on its own thread with a timeout: a client that
/// accepts the pipe but never answers must not hang the caller. `Ok(None)`:
/// no client listens on this pipe number.
fn connect(pipe: u8, client_id: &str) -> Result<Option<Conn>, String> {
    let (tx, rx) = mpsc::channel();
    let id = client_id.to_string();
    std::thread::spawn(move || {
        let _ = tx.send(handshake(pipe, &id));
    });
    rx.recv_timeout(Duration::from_secs(4))
        .map_err(|_| format!("discord-ipc-{pipe} did not answer"))?
}

fn handshake(pipe: u8, client_id: &str) -> Result<Option<Conn>, String> {
    let mut stream = match open_pipe(pipe) {
        Ok(stream) => stream,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound
            || e.kind() == std::io::ErrorKind::ConnectionRefused => return Ok(None),
        Err(e) => return Err(format!("discord-ipc-{pipe}: {e}")),
    };
    write_frame(&mut stream, OP_HANDSHAKE, &json!({ "v": 1, "client_id": client_id }))
        .map_err(|e| e.to_string())?;
    let (op, ready) = read_frame(&mut stream).map_err(|e| e.to_string())?;
    if op == OP_CLOSE || ready["evt"] != "READY" {
        let why = ready["message"].as_str().unwrap_or("handshake refused");
        return Err(if why.to_lowercase().contains("client id") {
            "Discord rejected this Application ID".into()
        } else {
            why.to_string()
        });
    }
    let user = &ready["data"]["user"];
    let user = user["global_name"].as_str().filter(|s| !s.is_empty())
        .or_else(|| user["username"].as_str())
        .unwrap_or("")
        .to_string();
    let info = RpcClientInfo { pipe, kind: client_kind(&ready).into(), user };
    Ok(Some(Conn { info, pipe: Arc::new(Mutex::new(stream)), alive: Arc::new(AtomicBool::new(true)) }))
}

/// Every running client that accepts this Application ID.
fn discover(client_id: &str) -> (Vec<Conn>, Vec<String>) {
    let mut conns = Vec::new();
    let mut errors = Vec::new();
    for pipe in 0..MAX_PIPES {
        match connect(pipe, client_id) {
            Ok(Some(conn)) => conns.push(conn),
            Ok(None) => {}
            Err(e) => errors.push(e),
        }
    }
    (conns, errors)
}

/// The connections the user's target asks for. "auto" prefers the regular
/// Discord app, then whatever runs; "all" keeps every client.
fn select(mut conns: Vec<Conn>, target: &str) -> Vec<Conn> {
    match target {
        "all" => conns,
        "discord" | "ptb" | "canary" => conns.into_iter().filter(|c| c.info.kind == target).collect(),
        _ => {
            conns.sort_by_key(|c| (c.info.kind != "discord", c.info.pipe));
            conns.truncate(1);
            conns
        }
    }
}

fn kind_label(kind: &str) -> &'static str {
    match kind {
        "ptb" => "Discord PTB",
        "canary" => "Discord Canary",
        _ => "Discord",
    }
}

fn ensure_connected(inner: &mut Inner, client_id: &str, target: &str) -> Result<(), String> {
    let healthy = !inner.conns.is_empty() && inner.conns.iter().all(|c| c.alive.load(Ordering::Relaxed));
    if healthy && inner.client_id == client_id && inner.target == target {
        return Ok(());
    }
    inner.conns.clear();
    let (found, errors) = discover(client_id);
    if found.is_empty() {
        return Err(errors.into_iter().next().unwrap_or_else(|| "No Discord app is running on this PC".into()));
    }
    let chosen = select(found, target);
    if chosen.is_empty() {
        return Err(format!("{} is not running", kind_label(target)));
    }
    inner.client_id = client_id.to_string();
    inner.target = target.to_string();
    inner.conns = chosen;
    Ok(())
}

fn fit(text: &str, fallback: &str) -> String {
    let text = if text.trim().chars().count() < 2 { fallback } else { text.trim() };
    if text.chars().count() <= TEXT_MAX {
        return text.to_string();
    }
    let mut cut: String = text.chars().take(TEXT_MAX - 1).collect();
    cut.push('…');
    cut
}

fn activity(title: &str, artist: &str, playing: bool, art: &str, duration: f64, position: f64) -> Value {
    let details = fit(title, "Idle");
    let base = fit(artist, "Music Player");
    // Paused: Discord has no native paused state; without timestamps the
    // elapsed counter stops, and the state line says why.
    let state = if playing { base } else { fit(&format!("⏸ Paused — {base}"), "Paused") };
    let mut assets = json!({ "large_text": if playing { "Playing" } else { "Paused" } });
    if art.starts_with("http") && art.len() <= 256 {
        assets["large_image"] = json!(art);
    }
    let mut act = json!({ "type": 2, "details": details, "state": state, "assets": assets });
    let dur = duration.max(0.0);
    if playing && dur > 0.0 {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        let start = now - (position.clamp(0.0, dur) * 1000.0) as i64;
        act["timestamps"] = json!({ "start": start, "end": start + (dur * 1000.0) as i64 });
    }
    act
}

/// `activity: None` clears the presence.
fn send_activity(inner: &mut Inner, act: Option<&Value>) -> Result<Vec<RpcClientInfo>, String> {
    let mut sent = Vec::new();
    let mut last_err = None;
    let mut args = json!({ "pid": std::process::id() });
    if let Some(act) = act {
        args["activity"] = act.clone();
    }
    for conn in inner.conns.iter() {
        match command(conn, "SET_ACTIVITY", args.clone()) {
            Ok(_) => sent.push(conn.info.clone()),
            Err(e) => last_err = Some(e),
        }
    }
    // A dead connection (Discord restarted) is rebuilt on the next update.
    inner.conns.retain(|c| c.alive.load(Ordering::Relaxed));
    if sent.is_empty() {
        return Err(last_err.unwrap_or_else(|| "Discord connection lost".into()));
    }
    Ok(sent)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn rpc_update(
    app: AppHandle,
    client_id: String,
    title: String,
    artist: String,
    playing: bool,
    art: Option<String>,
    duration_secs: Option<f64>,
    position_secs: Option<f64>,
    target: Option<String>,
) -> Result<Vec<RpcClientInfo>, String> {
    let client_id = client_id.trim().to_string();
    if client_id.is_empty() || !client_id.chars().all(|c| c.is_ascii_digit()) {
        return Err("no valid Application ID".into());
    }
    let target = target.unwrap_or_else(|| "auto".into());
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<RpcState>();
        let mut inner = state.0.lock().map_err(|_| "rpc lock")?;
        ensure_connected(&mut inner, &client_id, &target)?;
        let act = activity(&title, &artist, playing, &art.unwrap_or_default(),
            duration_secs.unwrap_or(0.0), position_secs.unwrap_or(0.0));
        match send_activity(&mut inner, Some(&act)) {
            Ok(sent) => Ok(sent),
            // Discord refused the activity itself: reconnecting changes nothing.
            Err(e) if !inner.conns.is_empty() => Err(e),
            // The pipe died since the last update (Discord restarted): one reconnect.
            Err(_) => {
                ensure_connected(&mut inner, &client_id, &target)?;
                send_activity(&mut inner, Some(&act))
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn rpc_clear(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<RpcState>();
        let mut inner = state.0.lock().map_err(|_| "rpc lock")?;
        // Keep the connections: closing right after the clear frame can race
        // the client into keeping the presence, and the next update would
        // handshake again for nothing.
        if !inner.conns.is_empty() {
            let _ = send_activity(&mut inner, None);
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Settings → Test: every running Discord client that accepts this ID, with
/// the account it is signed in to, so the user can see where presence goes.
#[tauri::command]
pub async fn rpc_clients(client_id: String) -> Result<Vec<RpcClientInfo>, String> {
    let client_id = client_id.trim().to_string();
    if client_id.is_empty() || !client_id.chars().all(|c| c.is_ascii_digit()) {
        return Err("no valid Application ID".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let (found, errors) = discover(&client_id);
        if found.is_empty() {
            return Err(errors.into_iter().next().unwrap_or_else(|| "No Discord app is running on this PC".into()));
        }
        Ok(found.into_iter().map(|c| c.info).collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::{activity, client_kind, discover, ensure_connected, fit, read_frame, send_activity, write_frame, Inner};
    use serde_json::json;

    /// Real round trip with the user's Discord apps and Application ID (read
    /// from the app's settings, never printed): presence for ~2 s, then cleared.
    #[test]
    #[ignore = "needs a running Discord and the app's saved Application ID"]
    fn real_discord_round_trip() {
        let settings = std::fs::read_to_string(
            std::path::Path::new(&std::env::var("APPDATA").unwrap()).join("com.oniolivvs.musicplayer/settings.json"),
        )
        .unwrap();
        let settings: serde_json::Value = serde_json::from_str(&settings).unwrap();
        let id = settings["rpcClientId"].as_str().unwrap().to_string();
        let target = settings["rpcTarget"].as_str().unwrap_or("auto").to_string();
        let (found, errors) = discover(&id);
        println!("running: {:?} errors: {errors:?}", found.iter().map(|c| (c.info.pipe, c.info.kind.clone())).collect::<Vec<_>>());
        drop(found);
        let mut inner = Inner::default();
        ensure_connected(&mut inner, &id, &target).unwrap();
        let act = activity("Music Player · test", "Claude check", true, "https://i.ytimg.com/vi/3iUgKH8c7p4/mqdefault.jpg", 180.0, 5.0);
        let sent = send_activity(&mut inner, Some(&act)).unwrap();
        println!("shown on: {:?}", sent.iter().map(|c| (c.pipe, c.kind.clone())).collect::<Vec<_>>());
        assert!(sent.iter().all(|c| target == "auto" || target == "all" || c.kind == target));
        std::thread::sleep(std::time::Duration::from_secs(2));
        send_activity(&mut inner, None).unwrap();
    }

    #[test]
    fn frames_round_trip() {
        let mut buf = Vec::new();
        write_frame(&mut buf, 1, &json!({ "cmd": "SET_ACTIVITY" })).unwrap();
        let (op, value) = read_frame(&mut buf.as_slice()).unwrap();
        assert_eq!(op, 1);
        assert_eq!(value["cmd"], "SET_ACTIVITY");
    }

    #[test]
    fn clients_are_told_apart_by_their_api_host() {
        assert_eq!(client_kind(&json!({ "data": { "config": { "api_endpoint": "//ptb.discord.com/api" } } })), "ptb");
        assert_eq!(client_kind(&json!({ "data": { "config": { "api_endpoint": "//canary.discord.com/api" } } })), "canary");
        assert_eq!(client_kind(&json!({ "data": { "config": { "api_endpoint": "//discord.com/api" } } })), "discord");
    }

    #[test]
    fn texts_stay_within_discord_limits() {
        let long = "あ".repeat(300);
        assert_eq!(fit(&long, "x").chars().count(), 128);
        assert_eq!(fit("a", "Idle"), "Idle");
        let act = activity(&long, "", false, "file:///c.jpg", 200.0, 10.0);
        assert!(act["details"].as_str().unwrap().chars().count() <= 128);
        assert!(act["state"].as_str().unwrap().starts_with("⏸ Paused"));
        assert!(act["assets"].get("large_image").is_none());
        assert!(act.get("timestamps").is_none());
        let playing = activity("Song", "Artist", true, "https://i.ytimg.com/vi/x/mqdefault.jpg", 200.0, 10.0);
        assert_eq!(playing["type"], 2);
        assert!(playing["timestamps"]["end"].as_i64().unwrap() - playing["timestamps"]["start"].as_i64().unwrap() == 200_000);
    }
}
