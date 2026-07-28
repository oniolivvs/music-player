//! LAN device sharing — one device (host) serves its library + playlists + audio
//! files over the local network; another device (client) pairs with the host's
//! IP + a 6-digit code and can browse, stream and download. No cloud, no
//! account: everything stays on your WiFi. The client streams a track by
//! playing `http://<host>:<port>/file/<key>?code=<code>` through the same
//! range-request audio pipeline used for YouTube.
//!
//! Access is gated by the pairing code (constant-time compared) on every
//! request; the host only ever serves the exact files the frontend registered
//! (a key→path allow-list), never arbitrary paths.

use std::collections::HashMap;
use std::io::Read;
use std::sync::{Arc, Mutex};
use tiny_http::{Header, Method, Response, Server};

pub struct ShareState(pub Mutex<Option<Running>>);

impl Default for ShareState {
    fn default() -> Self {
        ShareState(Mutex::new(None))
    }
}

pub struct Running {
    pub port: u16,
    pub code: String,
    pub ip: String,
    stop: Arc<std::sync::atomic::AtomicBool>,
}

#[derive(Clone)]
struct Shared {
    code: String,
    library: String,   // library.json (tracks metadata, with `key` per track)
    playlists: String, // playlists.json
    files: HashMap<String, String>, // key → absolute path (allow-list)
    stop: Arc<std::sync::atomic::AtomicBool>,
}

#[derive(serde::Deserialize)]
pub struct ShareFile {
    pub key: String,
    pub path: String,
}

#[derive(serde::Serialize)]
pub struct ShareStatus {
    pub running: bool,
    pub ip: String,
    pub port: u16,
    pub code: String,
    pub files: usize,
}

fn gen_code() -> String {
    // 6 digits from the OS RNG — the code is the only thing gating the share
    // server, so it must not be derivable from clock/pid.
    let mut b = [0u8; 4];
    let n = if getrandom::fill(&mut b).is_ok() {
        u32::from_le_bytes(b)
    } else {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.subsec_nanos())
            .unwrap_or(0)
            ^ (std::process::id().wrapping_mul(2654435761))
    };
    format!("{:06}", n % 1_000_000)
}

fn ct_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    let mut d = 0u8;
    for i in 0..a.len() {
        d |= a[i] ^ b[i];
    }
    d == 0
}

fn query_code(url: &str) -> Option<String> {
    let q = url.split_once('?')?.1;
    q.split('&').find_map(|kv| kv.strip_prefix("code=").map(|v| v.to_string()))
}

fn json_resp(body: String) -> Response<std::io::Cursor<Vec<u8>>> {
    Response::from_string(body).with_header(
        Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap(),
    )
}

/// Start the LAN share server. Returns { ip, port, code } for the client.
#[tauri::command]
pub async fn share_start(
    state: tauri::State<'_, ShareState>,
    library: String,
    playlists: String,
    files: Vec<ShareFile>,
) -> Result<ShareStatus, String> {
    // Restart cleanly if already running.
    stop_inner(&state);

    let ip = local_ip_address::local_ip()
        .map(|a| a.to_string())
        .unwrap_or_else(|_| "127.0.0.1".to_string());
    let code = gen_code();
    let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let map: HashMap<String, String> = files.into_iter().map(|f| (f.key, f.path)).collect();
    let nfiles = map.len();
    let shared = Shared {
        code: code.clone(),
        library,
        playlists,
        files: map,
        stop: stop.clone(),
    };

    // Bind on all interfaces so phones on the same WiFi can reach it.
    let server = Server::http("0.0.0.0:0").map_err(|e| e.to_string())?;
    let port = server
        .server_addr()
        .to_ip()
        .map(|a| a.port())
        .ok_or("could not read server port")?;

    std::thread::spawn(move || serve(server, shared));

    *state.0.lock().map_err(|_| "share lock")? =
        Some(Running { port, code: code.clone(), ip: ip.clone(), stop });
    Ok(ShareStatus { running: true, ip, port, code, files: nfiles })
}

fn serve(server: Server, shared: Shared) {
    // Brute-force guard: the 6-digit code has 1M combinations, so throttle
    // wrong guesses hard (the loop is single-threaded — the sleep gates every
    // request) and lock the server outright past a count no legit user hits.
    let mut bad_codes: u32 = 0;
    const LOCK_AFTER: u32 = 1000;
    for request in server.incoming_requests() {
        if shared.stop.load(std::sync::atomic::Ordering::Relaxed) {
            break;
        }
        let url = request.url().to_string();
        let path = url.split('?').next().unwrap_or("").to_string();

        // /ping is unauthenticated (device discovery / validation).
        if path == "/ping" {
            let _ = request.respond(json_resp(
                format!("{{\"app\":\"MusicPlayer\",\"share\":1,\"files\":{}}}", shared.files.len()),
            ));
            continue;
        }

        // Everything else needs the pairing code.
        let ok = query_code(&url).map(|c| ct_eq(&c, &shared.code)).unwrap_or(false);
        if !ok || bad_codes >= LOCK_AFTER {
            if !ok {
                bad_codes = bad_codes.saturating_add(1);
                std::thread::sleep(std::time::Duration::from_millis(400));
            }
            let _ = request.respond(Response::from_string("forbidden").with_status_code(403));
            continue;
        }
        if request.method() != &Method::Get {
            let _ = request.respond(Response::from_string("method not allowed").with_status_code(405));
            continue;
        }

        if path == "/library" {
            let _ = request.respond(json_resp(shared.library.clone()));
            continue;
        }
        if path == "/playlists" {
            let _ = request.respond(json_resp(shared.playlists.clone()));
            continue;
        }
        if let Some(key) = path.strip_prefix("/file/") {
            match shared.files.get(key) {
                Some(fpath) => serve_file(request, fpath, &url),
                None => {
                    let _ = request.respond(Response::from_string("not found").with_status_code(404));
                }
            }
            continue;
        }
        let _ = request.respond(Response::from_string("not found").with_status_code(404));
    }
}

/// Serve a file with HTTP Range support so the client can stream + seek.
fn serve_file(request: tiny_http::Request, fpath: &str, url: &str) {
    let meta = match std::fs::metadata(fpath) {
        Ok(m) => m,
        Err(_) => {
            let _ = request.respond(Response::from_string("gone").with_status_code(410));
            return;
        }
    };
    let total = meta.len();
    let range = request
        .headers()
        .iter()
        .find(|h| h.field.equiv("Range"))
        .and_then(|h| parse_range(h.value.as_str(), total));

    let mut file = match std::fs::File::open(fpath) {
        Ok(f) => f,
        Err(e) => {
            let _ = request.respond(Response::from_string(format!("io: {e}")).with_status_code(500));
            return;
        }
    };
    let ctype = content_type(fpath);
    let _ = url; // reserved

    match range {
        Some((start, end)) => {
            use std::io::{Seek, SeekFrom};
            let len = end - start + 1;
            if file.seek(SeekFrom::Start(start)).is_err() {
                let _ = request.respond(Response::from_string("seek").with_status_code(500));
                return;
            }
            let reader = file.take(len);
            let resp = Response::new(
                tiny_http::StatusCode(206),
                vec![
                    Header::from_bytes(&b"Content-Type"[..], ctype.as_bytes()).unwrap(),
                    Header::from_bytes(&b"Accept-Ranges"[..], &b"bytes"[..]).unwrap(),
                    Header::from_bytes(
                        &b"Content-Range"[..],
                        format!("bytes {start}-{end}/{total}").as_bytes(),
                    )
                    .unwrap(),
                ],
                reader,
                Some(len as usize),
                None,
            );
            let _ = request.respond(resp);
        }
        None => {
            let resp = Response::new(
                tiny_http::StatusCode(200),
                vec![
                    Header::from_bytes(&b"Content-Type"[..], ctype.as_bytes()).unwrap(),
                    Header::from_bytes(&b"Accept-Ranges"[..], &b"bytes"[..]).unwrap(),
                ],
                file,
                Some(total as usize),
                None,
            );
            let _ = request.respond(resp);
        }
    }
}

fn parse_range(h: &str, total: u64) -> Option<(u64, u64)> {
    let r = h.trim().strip_prefix("bytes=")?;
    let (s, e) = r.split_once('-')?;
    let start: u64 = if s.is_empty() { 0 } else { s.parse().ok()? };
    let end: u64 = if e.is_empty() { total.saturating_sub(1) } else { e.parse().ok()? };
    if start > end || start >= total {
        return None;
    }
    Some((start, end.min(total.saturating_sub(1))))
}

fn content_type(path: &str) -> String {
    let ext = std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    match ext.as_str() {
        "mp3" => "audio/mpeg",
        "m4a" | "aac" => "audio/mp4",
        "flac" => "audio/flac",
        "wav" => "audio/wav",
        "ogg" | "opus" => "audio/ogg",
        _ => "application/octet-stream",
    }
    .to_string()
}

fn stop_inner(state: &tauri::State<'_, ShareState>) {
    if let Ok(mut g) = state.0.lock() {
        if let Some(r) = g.take() {
            r.stop.store(true, std::sync::atomic::Ordering::Relaxed);
            // Nudge the accept loop so it notices the stop flag.
            let _ = ureq::get(&format!("http://127.0.0.1:{}/ping", r.port)).timeout(std::time::Duration::from_millis(300)).call();
        }
    }
}

#[tauri::command]
pub async fn share_stop(state: tauri::State<'_, ShareState>) -> Result<(), String> {
    stop_inner(&state);
    Ok(())
}

#[tauri::command]
pub async fn share_status(state: tauri::State<'_, ShareState>) -> Result<ShareStatus, String> {
    let g = state.0.lock().map_err(|_| "share lock")?;
    Ok(match &*g {
        Some(r) => ShareStatus { running: true, ip: r.ip.clone(), port: r.port, code: r.code.clone(), files: 0 },
        None => ShareStatus { running: false, ip: String::new(), port: 0, code: String::new(), files: 0 },
    })
}

// ─── Client side ────────────────────────────────────────────────────────
#[derive(serde::Serialize)]
pub struct RemoteData {
    pub library: String,
    pub playlists: String,
    pub base: String, // http://host:port  (append /file/<key>?code=… to stream)
}

/// Connect to a host: validate the code and pull its library + playlists.
#[tauri::command]
pub async fn share_connect(host: String, port: u16, code: String) -> Result<RemoteData, String> {
    let base = format!("http://{}:{}", host.trim(), port);
    let agent = ureq::AgentBuilder::new()
        .timeout(std::time::Duration::from_secs(8))
        .build();
    // Validate the code against /library (403 if wrong).
    let lib = agent
        .get(&format!("{base}/library?code={code}"))
        .call()
        .map_err(|e| match e {
            ureq::Error::Status(403, _) => "wrong pairing code".to_string(),
            other => format!("could not reach the host: {other}"),
        })?
        .into_string()
        .map_err(|e| e.to_string())?;
    let pls = agent
        .get(&format!("{base}/playlists?code={code}"))
        .call()
        .map_err(|e| e.to_string())?
        .into_string()
        .unwrap_or_else(|_| "[]".to_string());
    Ok(RemoteData { library: lib, playlists: pls, base })
}

/// Download a remote shared file to `<dir>/<name>` (client → local save). The
/// filename should carry the "[videoId]" tag so the library links it like any
/// other download. Emits the same "dl" {id, pct} progress events.
#[tauri::command]
pub async fn share_download(
    app: tauri::AppHandle,
    url: String,
    dir: String,
    name: String,
    id: String,
) -> Result<String, String> {
    use tauri::Emitter;
    let dir = if dir.trim().is_empty() {
        let home = std::env::var("HOME")
            .or_else(|_| std::env::var("USERPROFILE"))
            .unwrap_or_else(|_| ".".into());
        if cfg!(target_os = "android") {
            "/storage/emulated/0/Music/MusicPlayer".to_string()
        } else {
            format!("{home}/Music/MusicPlayer")
        }
    } else {
        dir
    };
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create {dir}: {e}"))?;
    let safe: String = name.chars().map(|c| if "/\\:*?\"<>|".contains(c) { '_' } else { c }).collect();
    let path = format!("{dir}/{safe}");
    let part = format!("{path}.part");

    let resp = ureq::get(&url).call().map_err(|e| format!("fetch: {e}"))?;
    let total: u64 = resp.header("Content-Length").and_then(|s| s.parse().ok()).unwrap_or(0);
    let mut reader = resp.into_reader();
    let mut out = std::fs::File::create(&part).map_err(|e| e.to_string())?;
    let mut buf = [0u8; 64 * 1024];
    let mut done: u64 = 0;
    let mut last = -1i32;
    loop {
        let n = reader.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        std::io::Write::write_all(&mut out, &buf[..n]).map_err(|e| e.to_string())?;
        done += n as u64;
        if total > 0 {
            let pct = ((done * 100) / total) as i32;
            if pct != last {
                last = pct;
                let _ = app.emit("dl", serde_json::json!({ "id": id, "pct": pct }));
            }
        }
    }
    std::io::Write::flush(&mut out).map_err(|e| e.to_string())?;
    drop(out);
    std::fs::rename(&part, &path).map_err(|e| e.to_string())?;
    Ok(path)
}
