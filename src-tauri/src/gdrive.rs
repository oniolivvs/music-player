//! Google account sign-in + cloud sync through the user's own Google Drive.
//!
//! There is no server of ours: sync data lives in the private **appDataFolder**
//! of the signed-in user's Google Drive (a hidden per-app folder Google gives
//! every app for free). Sign in with the same Google account on another device
//! and it pulls the same bundle — so playlists / settings / blocked / follows
//! sync everywhere, not just on one WiFi.
//!
//! Auth is the standard OAuth 2.0 "installed app" flow with PKCE + a loopback
//! redirect (works on desktop and Android's in-device localhost). The user
//! supplies their own OAuth client id/secret (Desktop-app type) — documented in
//! the UI — because embedding shared credentials in a distributed app is wrong.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::Read;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

const SCOPE: &str = "https://www.googleapis.com/auth/drive.appdata";
const AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const SYNC_FILE: &str = "musicplayer-sync.json";

/// Tokens persisted by the frontend (in the encrypted store). refresh_token is
/// long-lived; access_token is refreshed on demand.
#[derive(Default, Serialize, Deserialize, Clone)]
pub struct Tokens {
    pub refresh_token: String,
    pub access_token: String,
    pub expires_at: u64, // unix seconds
    pub email: String,
}

#[derive(Default)]
pub struct GDriveState(pub Mutex<Tokens>);

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn pkce() -> (String, String) {
    // verifier: 64 url-safe chars from the OS RNG; challenge = base64url(sha256(v)).
    let mut b = [0u8; 48];
    if getrandom::fill(&mut b).is_err() {
        // OS RNG unavailable (should never happen) — fall back to a hashed
        // time/pid seed rather than failing the sign-in outright.
        let mut seed = Vec::new();
        seed.extend_from_slice(&now().to_le_bytes());
        seed.extend_from_slice(&std::process::id().to_le_bytes());
        b.copy_from_slice(&Sha256::digest(&seed)[..32].repeat(2)[..48]);
    }
    let v = URL_SAFE_NO_PAD.encode(b);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(v.as_bytes()));
    (v, challenge)
}

#[derive(Serialize)]
pub struct SignInResult {
    pub email: String,
    pub tokens: Tokens,
}

/// Full interactive sign-in: opens the browser, catches the loopback redirect,
/// exchanges the code for tokens, fetches the account email. Returns the tokens
/// for the frontend to persist.
#[tauri::command]
pub async fn gdrive_sign_in(
    app: tauri::AppHandle,
    state: tauri::State<'_, GDriveState>,
    client_id: String,
    client_secret: String,
) -> Result<SignInResult, String> {
    let client_id = client_id.trim().to_string();
    if client_id.is_empty() {
        return Err("Enter your Google OAuth Client ID first.".into());
    }
    let (verifier, challenge) = pkce();

    // Loopback server catches ?code=… on 127.0.0.1:<port>.
    let server = tiny_http::Server::http("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = server.server_addr().to_ip().map(|a| a.port()).ok_or("no port")?;
    let redirect = format!("http://127.0.0.1:{port}");

    let auth = format!(
        "{AUTH_URL}?client_id={cid}&redirect_uri={redir}&response_type=code&scope={scope}\
         &code_challenge={ch}&code_challenge_method=S256&access_type=offline&prompt=consent",
        cid = urlenc(&client_id),
        redir = urlenc(&redirect),
        scope = urlenc(SCOPE),
        ch = challenge,
    );
    open_browser(&app, &auth);

    // Wait (max ~3 min) for the redirect carrying the code.
    let code = std::thread::spawn(move || -> Option<String> {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(180);
        while std::time::Instant::now() < deadline {
            match server.recv_timeout(std::time::Duration::from_secs(1)) {
                Ok(Some(req)) => {
                    let url = req.url().to_string();
                    let code = url
                        .split_once('?')
                        .and_then(|(_, q)| q.split('&').find_map(|kv| kv.strip_prefix("code=")))
                        .map(|c| c.to_string());
                    let body = if code.is_some() {
                        "<h2>Signed in ✔</h2><p>You can close this tab and return to Music Player.</p>"
                    } else {
                        "<h2>Sign-in cancelled</h2>"
                    };
                    let resp = tiny_http::Response::from_string(body).with_header(
                        tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"text/html"[..]).unwrap(),
                    );
                    let _ = req.respond(resp);
                    if code.is_some() {
                        return code;
                    }
                }
                Ok(None) => continue,
                Err(_) => continue,
            }
        }
        None
    })
    .join()
    .map_err(|_| "loopback thread panicked")?
    .ok_or("Timed out waiting for Google sign-in.")?;

    // Exchange the code for tokens.
    let tok = exchange_code(&client_id, &client_secret, &code, &verifier, &redirect)?;
    let email = fetch_email(&tok.access_token).unwrap_or_default();
    let tokens = Tokens { email: email.clone(), ..tok };
    *state.0.lock().map_err(|_| "lock")? = tokens.clone();
    Ok(SignInResult { email, tokens })
}

fn urlenc(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

fn open_browser(app: &tauri::AppHandle, url: &str) {
    use tauri_plugin_opener::OpenerExt;
    let _ = app.opener().open_url(url.to_string(), None::<&str>);
}

#[derive(Deserialize)]
struct TokenResp {
    access_token: String,
    #[serde(default)]
    refresh_token: String,
    #[serde(default)]
    expires_in: u64,
}

fn exchange_code(cid: &str, secret: &str, code: &str, verifier: &str, redirect: &str) -> Result<Tokens, String> {
    let mut form = vec![
        ("client_id", cid),
        ("code", code),
        ("code_verifier", verifier),
        ("grant_type", "authorization_code"),
        ("redirect_uri", redirect),
    ];
    if !secret.trim().is_empty() {
        form.push(("client_secret", secret));
    }
    let resp = ureq::post(TOKEN_URL)
        .send_form(&form)
        .map_err(|e| format!("token exchange: {}", oauth_err(e)))?;
    let t: TokenResp = serde_json::from_str(&resp.into_string().map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    Ok(Tokens {
        refresh_token: t.refresh_token,
        access_token: t.access_token,
        expires_at: now() + t.expires_in.saturating_sub(60),
        email: String::new(),
    })
}

fn oauth_err(e: ureq::Error) -> String {
    match e {
        ureq::Error::Status(code, resp) => {
            let body = resp.into_string().unwrap_or_default();
            format!("HTTP {code}: {}", body.chars().take(300).collect::<String>())
        }
        other => other.to_string(),
    }
}

fn refresh(cid: &str, secret: &str, refresh_token: &str) -> Result<Tokens, String> {
    let mut form = vec![
        ("client_id", cid),
        ("refresh_token", refresh_token),
        ("grant_type", "refresh_token"),
    ];
    if !secret.trim().is_empty() {
        form.push(("client_secret", secret));
    }
    let resp = ureq::post(TOKEN_URL).send_form(&form).map_err(|e| format!("refresh: {}", oauth_err(e)))?;
    let t: TokenResp = serde_json::from_str(&resp.into_string().map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    Ok(Tokens {
        refresh_token: if t.refresh_token.is_empty() { refresh_token.to_string() } else { t.refresh_token },
        access_token: t.access_token,
        expires_at: now() + t.expires_in.saturating_sub(60),
        email: String::new(),
    })
}

fn fetch_email(access: &str) -> Option<String> {
    let resp = ureq::get("https://www.googleapis.com/oauth2/v3/userinfo")
        .set("Authorization", &format!("Bearer {access}"))
        .call()
        .ok()?;
    let v: serde_json::Value = serde_json::from_str(&resp.into_string().ok()?).ok()?;
    v["email"].as_str().map(str::to_string)
}

/// Return a valid access token, refreshing if it has expired. Persists any new
/// tokens back to the shared state; the frontend re-saves them.
fn valid_token(
    state: &tauri::State<'_, GDriveState>,
    cid: &str,
    secret: &str,
) -> Result<Tokens, String> {
    let cur = state.0.lock().map_err(|_| "lock")?.clone();
    if cur.refresh_token.is_empty() {
        return Err("Not signed in.".into());
    }
    if !cur.access_token.is_empty() && cur.expires_at > now() {
        return Ok(cur);
    }
    let mut t = refresh(cid, secret, &cur.refresh_token)?;
    if t.email.is_empty() {
        t.email = cur.email.clone();
    }
    *state.0.lock().map_err(|_| "lock")? = t.clone();
    Ok(t)
}

/// Restore tokens from the frontend store at startup (no network).
#[tauri::command]
pub fn gdrive_set_tokens(state: tauri::State<'_, GDriveState>, tokens: Tokens) {
    if let Ok(mut g) = state.0.lock() {
        *g = tokens;
    }
}

#[tauri::command]
pub fn gdrive_sign_out(state: tauri::State<'_, GDriveState>) {
    if let Ok(mut g) = state.0.lock() {
        *g = Tokens::default();
    }
}

fn find_sync_file(access: &str) -> Result<Option<String>, String> {
    let resp = ureq::get("https://www.googleapis.com/drive/v3/files")
        .query("spaces", "appDataFolder")
        .query("q", &format!("name = '{SYNC_FILE}'"))
        .query("fields", "files(id,name)")
        .set("Authorization", &format!("Bearer {access}"))
        .call()
        .map_err(|e| format!("drive list: {}", oauth_err(e)))?;
    let v: serde_json::Value = serde_json::from_str(&resp.into_string().map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    Ok(v["files"].as_array().and_then(|a| a.first()).and_then(|f| f["id"].as_str()).map(str::to_string))
}

/// Download the sync bundle JSON (empty string if none yet).
#[tauri::command]
pub async fn gdrive_pull(
    state: tauri::State<'_, GDriveState>,
    client_id: String,
    client_secret: String,
) -> Result<String, String> {
    let tok = valid_token(&state, &client_id, &client_secret)?;
    let id = match find_sync_file(&tok.access_token)? {
        Some(id) => id,
        None => return Ok(String::new()),
    };
    let resp = ureq::get(&format!("https://www.googleapis.com/drive/v3/files/{id}"))
        .query("alt", "media")
        .set("Authorization", &format!("Bearer {}", tok.access_token))
        .call()
        .map_err(|e| format!("drive get: {}", oauth_err(e)))?;
    let mut s = String::new();
    resp.into_reader().take(20 * 1024 * 1024).read_to_string(&mut s).map_err(|e| e.to_string())?;
    Ok(s)
}

/// Upload the sync bundle JSON (create or overwrite the single sync file).
#[tauri::command]
pub async fn gdrive_push(
    state: tauri::State<'_, GDriveState>,
    client_id: String,
    client_secret: String,
    bundle: String,
) -> Result<(), String> {
    let tok = valid_token(&state, &client_id, &client_secret)?;
    let existing = find_sync_file(&tok.access_token)?;
    match existing {
        Some(id) => {
            // Update existing file content (media upload).
            ureq::patch(&format!("https://www.googleapis.com/upload/drive/v3/files/{id}"))
                .query("uploadType", "media")
                .set("Authorization", &format!("Bearer {}", tok.access_token))
                .set("Content-Type", "application/json")
                .send_string(&bundle)
                .map_err(|e| format!("drive update: {}", oauth_err(e)))?;
        }
        None => {
            // Multipart create in appDataFolder (metadata + content in one call).
            let boundary = "mpsyncboundary1234";
            let meta = format!("{{\"name\":\"{SYNC_FILE}\",\"parents\":[\"appDataFolder\"]}}");
            let body = format!(
                "--{b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{meta}\r\n\
                 --{b}\r\nContent-Type: application/json\r\n\r\n{bundle}\r\n--{b}--",
                b = boundary
            );
            ureq::post("https://www.googleapis.com/upload/drive/v3/files")
                .query("uploadType", "multipart")
                .set("Authorization", &format!("Bearer {}", tok.access_token))
                .set("Content-Type", &format!("multipart/related; boundary={boundary}"))
                .send_string(&body)
                .map_err(|e| format!("drive create: {}", oauth_err(e)))?;
        }
    }
    Ok(())
}

/// Whether we currently hold a refresh token (frontend reflects sign-in state).
#[tauri::command]
pub fn gdrive_account(state: tauri::State<'_, GDriveState>) -> Tokens {
    state.0.lock().map(|g| g.clone()).unwrap_or_default()
}
