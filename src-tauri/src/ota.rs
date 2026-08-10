//! Over-the-air frontend updates (CodePush-style).
//!
//! The whole UI is web code (index.html + a handful of JS modules + one CSS
//! file) embedded in the binary. This module lets the app pull a newer copy of
//! that web code straight from the repo and run it **without a reinstall** — no
//! trip to GitHub, no new APK. Only the native Rust core needs a real binary
//! update; everything the user usually changes (layout, logic, styling) ships
//! instantly here.
//!
//! Flow: `ota_check` reads a manifest from the repo → if its version beats what
//! is running, `ota_apply` downloads the files into the app-data `ota/` folder →
//! the frontend reloads → `index.html`'s bootstrap sees the folder and boots the
//! updated code instead of the embedded copy. `ota_rollback` wipes the folder
//! (the bootstrap's watchdog calls it if an OTA build fails to come up).

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use tauri::Manager;

/// Raw file host for the repo's `main` branch — the frontend on `main` *is* the
/// OTA payload, so a plain `git push` of a UI change is enough to ship it.
const RAW_BASE: &str = "https://raw.githubusercontent.com/oniolivvs/music-player/main";

#[derive(Serialize, Deserialize, Clone)]
pub struct OtaManifest {
    version: String,
    /// The ES-module entry point (e.g. `main.js`).
    entry: String,
    /// Every JS module to fetch (entry + its imported modules).
    modules: Vec<String>,
    /// The stylesheet file.
    css: String,
    /// Optional `index.html` so DOM/markup changes can ship over the air too.
    #[serde(default)]
    html: Option<String>,
    /// Optional platform scoping ("linux" / "windows" / "macos" / "android"):
    /// when present, platforms NOT listed skip this update entirely — a fix
    /// aimed at one platform no longer nags every other one. Absent = all.
    #[serde(default)]
    platforms: Option<Vec<String>>,
    /// Optional minimum NATIVE app version this frontend needs. Binaries older
    /// than this skip the OTA (check + apply): a new UI must never land on a
    /// backend that lacks the commands/behavior it relies on — update the app
    /// itself first.
    #[serde(default)]
    min_native: Option<String>,
    #[serde(default)]
    notes: Option<String>,
}

#[derive(Serialize)]
pub struct OtaBundle {
    version: String,
    entry: String,
    css: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    html: Option<String>,
    modules: HashMap<String, String>,
}

#[derive(Serialize)]
pub struct OtaStatus {
    available: bool,
    version: String,
    current: String,
    notes: String,
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout(std::time::Duration::from_secs(30))
        .build()
}

fn get_text(url: &str) -> Result<String, String> {
    agent()
        .get(url)
        .set("User-Agent", "MusicPlayer")
        // raw.githubusercontent is edge-cached; skip a stale copy when we can.
        .set("Cache-Control", "no-cache")
        .call()
        .map_err(|e| e.to_string())?
        .into_string()
        .map_err(|e| e.to_string())
}

/// Manifest file names end up in filesystem joins under `ota/` — accept only
/// plain names (letters/digits/`._-`, no separators, no `..`) so a hostile or
/// corrupted manifest can never read or write outside that folder.
fn safe_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && !name.contains("..")
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
}

fn manifest_names_ok(m: &OtaManifest) -> bool {
    m.modules.iter().all(|n| safe_name(n))
        && safe_name(&m.entry)
        && safe_name(&m.css)
        && m.html.as_ref().map_or(true, |h| safe_name(h))
}

fn ota_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("ota"))
}

/// Semver-ish compare: -1 / 0 / 1, missing components treated as 0.
fn ver_cmp(a: &str, b: &str) -> i32 {
    let pa: Vec<i64> = a.split('.').map(|x| x.parse().unwrap_or(0)).collect();
    let pb: Vec<i64> = b.split('.').map(|x| x.parse().unwrap_or(0)).collect();
    for i in 0..pa.len().max(pb.len()) {
        let d = pa.get(i).copied().unwrap_or(0) - pb.get(i).copied().unwrap_or(0);
        if d != 0 {
            return if d < 0 { -1 } else { 1 };
        }
    }
    0
}

fn stored_manifest(app: &tauri::AppHandle) -> Option<OtaManifest> {
    let raw = std::fs::read_to_string(ota_dir(app).ok()?.join("manifest.json")).ok()?;
    serde_json::from_str(&raw).ok()
}

/// The frontend version actually running: the applied OTA if it beats the
/// embedded build, otherwise the embedded build.
fn running_version(app: &tauri::AppHandle) -> String {
    let embedded = env!("CARGO_PKG_VERSION").to_string();
    match stored_manifest(app) {
        Some(m) if ver_cmp(&m.version, &embedded) > 0 => m.version,
        _ => embedded,
    }
}

/// Called by the `index.html` bootstrap on every launch. Returns the applied
/// OTA code **only if it is strictly newer than the embedded build** (so a fresh
/// APK with a bumped version always wins and a stale OTA is ignored).
#[tauri::command]
pub fn ota_bundle(app: tauri::AppHandle) -> Option<OtaBundle> {
    let dir = ota_dir(&app).ok()?;
    let m = stored_manifest(&app)?;
    if ver_cmp(&m.version, env!("CARGO_PKG_VERSION")) <= 0 || !manifest_names_ok(&m) {
        return None;
    }
    let mut modules = HashMap::new();
    for name in &m.modules {
        // A missing file means a corrupt/partial apply → refuse the whole
        // bundle so the bootstrap falls back to the embedded build.
        let code = std::fs::read_to_string(dir.join(name)).ok()?;
        modules.insert(name.clone(), code);
    }
    // Same strictness as modules: a truncated/corrupt stylesheet means the whole
    // bundle is unusable — serve nothing so the bootstrap falls back embedded.
    let css = std::fs::read_to_string(dir.join(&m.css)).ok()?;
    if !css.contains("MP_CSS") || css.len() < 1000 {
        return None;
    }
    let html = m
        .html
        .as_ref()
        .and_then(|h| std::fs::read_to_string(dir.join(h)).ok());
    Some(OtaBundle {
        version: m.version,
        entry: m.entry,
        css,
        html,
        modules,
    })
}

fn this_platform() -> &'static str {
    if cfg!(target_os = "android") { "android" } else { std::env::consts::OS }
}

fn targets_this_platform(m: &OtaManifest) -> bool {
    m.platforms
        .as_ref()
        .map_or(true, |p| p.iter().any(|x| x == this_platform()))
}

fn native_supports(m: &OtaManifest) -> bool {
    m.min_native
        .as_ref()
        .map_or(true, |mn| ver_cmp(env!("CARGO_PKG_VERSION"), mn) >= 0)
}

/// Ask the repo whether a newer frontend is available.
#[tauri::command]
pub async fn ota_check(app: tauri::AppHandle) -> Result<OtaStatus, String> {
    let raw = get_text(&format!("{RAW_BASE}/ota.json"))?;
    let m: OtaManifest = serde_json::from_str(&raw).map_err(|e| format!("bad manifest: {e}"))?;
    let current = running_version(&app);
    Ok(OtaStatus {
        available: targets_this_platform(&m) && native_supports(&m) && ver_cmp(&m.version, &current) > 0,
        version: m.version,
        current,
        notes: m.notes.unwrap_or_default(),
    })
}

/// Download the newest frontend into `ota/` (all-or-nothing: everything is
/// fetched into memory first, then written, so a dropped connection can't leave
/// a half-applied bundle).
#[tauri::command]
pub async fn ota_apply(app: tauri::AppHandle) -> Result<String, String> {
    let raw = get_text(&format!("{RAW_BASE}/ota.json"))?;
    let m: OtaManifest = serde_json::from_str(&raw).map_err(|e| format!("bad manifest: {e}"))?;
    if !targets_this_platform(&m) {
        return Err("This update does not target this platform".into());
    }
    if !native_supports(&m) {
        return Err("This UI update needs a newer app version — update the app itself first".into());
    }
    if ver_cmp(&m.version, &running_version(&app)) <= 0 {
        return Err("Already up to date".into());
    }
    if !manifest_names_ok(&m) {
        return Err("manifest contains an unsafe file name".into());
    }

    let mut files: Vec<(String, String)> = Vec::new();
    let mut wanted: Vec<String> = m.modules.clone();
    wanted.push(m.css.clone());
    if let Some(h) = &m.html {
        wanted.push(h.clone());
    }
    for name in &wanted {
        // raw.githubusercontent edge-caches ~5 min and the cache key includes the
        // query string: pinning the manifest version busts the cache, so a fresh
        // manifest can never be paired with stale module files (a mixed bundle
        // reports the new version while running old code).
        let body = get_text(&format!("{RAW_BASE}/src/{name}?ota={}", m.version))?;
        if body.trim().is_empty() {
            return Err(format!("empty file: {name}"));
        }
        files.push((name.clone(), body));
    }

    let dir = ota_dir(&app)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    for (name, body) in &files {
        std::fs::write(dir.join(name), body).map_err(|e| e.to_string())?;
    }
    std::fs::write(
        dir.join("manifest.json"),
        serde_json::to_string(&m).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    Ok(m.version)
}

/// Drop any applied OTA and fall back to the embedded build.
#[tauri::command]
pub fn ota_rollback(app: tauri::AppHandle) -> Result<(), String> {
    let dir = ota_dir(&app)?;
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    Ok(())
}
