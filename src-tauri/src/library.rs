//! Filesystem music library: recursive scan + best-effort tag reading.
//! Returns plain `Track` structs — no coupling to audio or UI.

use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::sync::{Mutex, OnceLock};
use walkdir::WalkDir;

// lofty imports (VERSION-SENSITIVE — see Cargo.toml note). The prelude brings the
// `Accessor` (title/artist/album) and `AudioFile`/`TaggedFileExt` (properties/tags)
// traits into scope. If cargo build complains about these, align lofty's version.
use base64::{engine::general_purpose::STANDARD, Engine as _};
use lofty::prelude::*;
use lofty::read_from_path;
use lofty::tag::ItemKey;

/// Embedded cover art for a single track, as a `data:` URL (or None if the file
/// has no embedded picture). Called lazily by the frontend, deduped per album.
/// async: reads a file — must never block the main (UI) thread.
#[tauri::command]
pub async fn cover(path: String) -> Option<String> {
    let tagged = read_from_path(&path).ok()?;
    let tag = tagged.primary_tag().or_else(|| tagged.first_tag())?;
    let pic = tag.pictures().first()?;
    let mime = pic.mime_type().map(|m| m.as_str()).unwrap_or("image/jpeg");
    Some(format!("data:{};base64,{}", mime, STANDARD.encode(pic.data())))
}

#[derive(Serialize, Clone)]
pub struct Track {
    pub path: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub duration_secs: u64,
    pub gain: f32, // linear ReplayGain multiplier (1.0 = no change)
}

// Parse a ReplayGain tag value like "-6.48 dB" into a linear multiplier.
fn parse_db_gain(s: &str) -> Option<f32> {
    let cleaned = s.trim().trim_end_matches(|c: char| c.is_alphabetic() || c == ' ');
    let db: f32 = cleaned.trim().parse().ok()?;
    Some(10f32.powf(db / 20.0).clamp(0.2, 2.0))
}

const AUDIO_EXTS: &[&str] = &["mp3", "flac", "wav", "ogg", "opus", "m4a", "aac"];

/// Canonical form of a path: symlinks resolved (e.g. Fedora atomic's
/// /home/user → /var/home/user), Windows' `\\?\` verbatim prefix stripped.
/// The SAME folder picked through two different spellings used to produce two
/// distinct path strings for every file — doubling the whole library.
pub fn canon(path: &str) -> String {
    #[allow(unused_mut)]
    let mut s = match std::fs::canonicalize(path) {
        Ok(p) => {
            let s = p.to_string_lossy().into_owned();
            s.strip_prefix(r"\\?\").map(str::to_string).unwrap_or(s)
        }
        Err(_) => path.to_string(),
    };
    // Distrobox/Fedora-atomic quirk: inside the dev container /home and
    // /var/home are two BIND MOUNTS of the same directory (no symlink for
    // canonicalize to resolve), so both spellings survive as "canonical" and
    // every file can still exist under two paths — exactly what doubled the
    // library. When both really are one filesystem object, fold onto /var/home.
    // NB: compare at /home/<user> level — inside the container the /home and
    // /var/home ROOTS are distinct overlay dirs even when the user dirs are
    // the very same mount (observed: /home 133:777264 vs /var/home 133:783629,
    // but /home/user == /var/home/user == 63:257).
    #[cfg(unix)]
    if let Some(rest) = s.strip_prefix("/home/") {
        let user = rest.split('/').next().unwrap_or("");
        if !user.is_empty() && same_file(&format!("/home/{user}"), &format!("/var/home/{user}")) {
            s = format!("/var/home/{rest}");
        }
    }
    s
}

#[cfg(unix)]
fn same_file(a: &str, b: &str) -> bool {
    use std::os::unix::fs::MetadataExt;
    match (std::fs::metadata(a), std::fs::metadata(b)) {
        (Ok(x), Ok(y)) => x.dev() == y.dev() && x.ino() == y.ino(),
        _ => false,
    }
}

/// Frontend helper: canonicalize one path (folder pickers may return aliases).
#[tauri::command]
pub fn canon_path(path: String) -> String {
    canon(&path)
}

/// Batch canonicalization — one IPC call for the whole library at startup.
#[tauri::command]
pub fn canon_paths(paths: Vec<String>) -> Vec<String> {
    paths.iter().map(|p| canon(p)).collect()
}

/// Total size in bytes of all audio files under a folder (recursive). Powers the
/// storage cap in Settings — the download queue checks it before each track.
#[tauri::command]
pub async fn folder_size(path: String) -> u64 {
    let mut total = 0u64;
    for entry in WalkDir::new(&path).into_iter().filter_map(Result::ok) {
        if !entry.file_type().is_file() {
            continue;
        }
        let ext = entry.path().extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
        if AUDIO_EXTS.contains(&ext.as_str()) {
            total = total.saturating_add(entry.metadata().map(|m| m.len()).unwrap_or(0));
        }
    }
    total
}

/// Recursively scan the given root folders for supported audio files.
pub fn scan_library(roots: &[String]) -> Vec<Track> {
    let mut tracks = Vec::new();
    for root in roots {
        let root = canon(root);
        for entry in WalkDir::new(&root).into_iter().filter_map(Result::ok) {
            if !entry.file_type().is_file() {
                continue;
            }
            let path = entry.path();
            let ext = path
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_lowercase();
            if AUDIO_EXTS.contains(&ext.as_str()) {
                tracks.push(read_track(path));
            }
        }
    }
    tracks.sort_by(|a, b| (a.artist.to_lowercase(), a.album.to_lowercase(), a.title.to_lowercase())
        .cmp(&(b.artist.to_lowercase(), b.album.to_lowercase(), b.title.to_lowercase())));
    tracks
}

/// Permanently delete a local audio file from disk. Guarded: the path must
/// exist, be a regular file, and carry a known audio extension — so a stray
/// call can never nuke arbitrary files.
#[tauri::command]
pub async fn delete_file(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    let meta = std::fs::metadata(p).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("not a regular file".into());
    }
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    if !AUDIO_EXTS.contains(&ext.as_str()) {
        return Err(format!("refusing to delete a non-audio file (.{ext})"));
    }
    std::fs::remove_file(p).map_err(|e| e.to_string())
}

/// Reveal a path in the host file manager. For a file we open its containing
/// folder (so it works for both source folders and individual tracks). The app
/// may run inside a container whose `xdg-open` forwards to the host; if that
/// isn't wired, fall back to `distrobox-host-exec xdg-open`.
#[tauri::command]
pub fn open_path(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    let target = if p.is_dir() {
        path.clone()
    } else {
        p.parent()
            .map(|d| d.to_string_lossy().into_owned())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| path.clone())
    };
    #[cfg(target_os = "windows")]
    {
        return std::process::Command::new("explorer")
            .arg(&target)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("cannot open file manager: {e}"));
    }
    #[cfg(not(target_os = "windows"))]
    {
        if std::process::Command::new("xdg-open").arg(&target).spawn().is_ok() {
            return Ok(());
        }
        std::process::Command::new("distrobox-host-exec")
            .args(["xdg-open", target.as_str()])
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("cannot open file manager: {e}"))
    }
}

/// Local image file → data URL (custom app backgrounds). Kept off the UI thread.
#[tauri::command]
pub async fn read_image(path: String) -> Result<String, String> {
    let ext = std::path::Path::new(&path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    let mime = match ext.as_str() {
        "png" => "image/png",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        "avif" => "image/avif",
        _ => "image/jpeg",
    };
    let data = std::fs::read(&path).map_err(|e| e.to_string())?;
    if data.len() > 25 * 1024 * 1024 {
        return Err("image too large (max 25 MB)".into());
    }
    Ok(format!("data:{mime};base64,{}", STANDARD.encode(data)))
}

static NET_IMG_CACHE: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();

/// Fetch a remote thumbnail (YouTube covers) and return it as a data URL. The
/// Android WebView refuses to load external network background-images, so covers
/// are proxied through Rust (which reaches i.ytimg fine) and handed back inline.
/// Restricted to known image hosts and cached in memory.
#[tauri::command]
pub async fn net_image(url: String) -> Result<String, String> {
    let ok_host = ["i.ytimg.com", "i9.ytimg.com", "yt3.ggpht.com", "lh3.googleusercontent.com"]
        .iter()
        .any(|h| url.contains(h));
    if !url.starts_with("https://") || !ok_host {
        return Err("unsupported image url".into());
    }
    let cache = NET_IMG_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(v) = cache.lock().unwrap().get(&url) {
        return Ok(v.clone());
    }
    // ureq is BLOCKING: run it off the async workers. A search page fires ~100
    // of these at once — inline they starved the tokio pool and covers stalled
    // for minutes (the first few painted, the rest never resolved).
    let u = url.clone();
    let data = tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        // One shared agent: connection keep-alive to i.ytimg.com. Building a
        // fresh agent per call cost a full TLS handshake per thumbnail
        // (~5s each on this setup — a 100-card page took minutes).
        static AGENT: std::sync::OnceLock<ureq::Agent> = std::sync::OnceLock::new();
        let agent = AGENT.get_or_init(|| {
            ureq::AgentBuilder::new()
                .timeout(std::time::Duration::from_secs(15))
                .build()
        });
        let resp = agent
            .get(&u)
            .set("User-Agent", "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0")
            .call()
            .map_err(|e| e.to_string())?;
        let mime = resp.header("Content-Type").unwrap_or("image/jpeg").to_string();
        let mut bytes = Vec::new();
        resp.into_reader()
            .take(6 * 1024 * 1024)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        if bytes.is_empty() {
            return Err("empty image".into());
        }
        Ok(format!("data:{};base64,{}", mime, STANDARD.encode(&bytes)))
    })
    .await
    .map_err(|e| e.to_string())??;
    cache.lock().unwrap().insert(url, data.clone());
    Ok(data)
}

/// Differential scan for refreshes: walk the folders, but only read tags for
/// files NOT in `known` — the frontend keeps its cached metadata for the rest.
/// `present` lists every audio file found so the caller can prune deletions.
#[derive(Serialize)]
pub struct ScanDiff {
    pub new_tracks: Vec<Track>,
    pub present: Vec<String>,
}

pub fn scan_diff(roots: &[String], known: &HashSet<String>) -> ScanDiff {
    let mut new_tracks = Vec::new();
    let mut present = Vec::new();
    for root in roots {
        let root = canon(root);
        for entry in WalkDir::new(&root).into_iter().filter_map(Result::ok) {
            if !entry.file_type().is_file() {
                continue;
            }
            let path = entry.path();
            let ext = path
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_lowercase();
            if !AUDIO_EXTS.contains(&ext.as_str()) {
                continue;
            }
            let p = path.to_string_lossy().to_string();
            if !known.contains(&p) {
                new_tracks.push(read_track(path));
            }
            present.push(p);
        }
    }
    new_tracks.sort_by(|a, b| (a.artist.to_lowercase(), a.album.to_lowercase(), a.title.to_lowercase())
        .cmp(&(b.artist.to_lowercase(), b.album.to_lowercase(), b.title.to_lowercase())));
    ScanDiff { new_tracks, present }
}

fn read_track(path: &std::path::Path) -> Track {
    let path_str = path.to_string_lossy().to_string();
    let fallback = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Unknown")
        .to_string();

    match read_from_path(path) {
        Ok(tagged) => {
            let duration_secs = tagged.properties().duration().as_secs();
            let tag = tagged.primary_tag().or_else(|| tagged.first_tag());
            let (title, artist, album, gain) = match tag {
                Some(t) => (
                    t.title().map(|s| s.to_string()).unwrap_or_else(|| fallback.clone()),
                    t.artist().map(|s| s.to_string()).unwrap_or_else(|| "Unknown Artist".into()),
                    t.album().map(|s| s.to_string()).unwrap_or_else(|| "Unknown Album".into()),
                    t.get_string(&ItemKey::ReplayGainTrackGain).and_then(parse_db_gain).unwrap_or(1.0),
                ),
                None => (fallback.clone(), "Unknown Artist".into(), "Unknown Album".into(), 1.0),
            };
            Track { path: path_str, title, artist, album, duration_secs, gain }
        }
        Err(_) => Track {
            path: path_str,
            title: fallback,
            artist: "Unknown Artist".into(),
            album: "Unknown Album".into(),
            duration_secs: 0,
            gain: 1.0,
        },
    }
}
