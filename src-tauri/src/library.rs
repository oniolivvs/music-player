//! Filesystem music library: recursive scan + best-effort tag reading.
//! Returns plain `Track` structs — no coupling to audio or UI.

use serde::Serialize;
use std::collections::HashSet;
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

const AUDIO_EXTS: &[&str] = &["mp3", "flac", "wav", "ogg", "opus", "m4a", "aac",
    // Video files are first-class playable tracks in this app, so they count as
    // media everywhere "audio" is checked: a folder holding only videos must
    // NOT read as an empty source, and its files can be sized / deleted.
    "mp4", "webm", "mkv"];

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

/// Folders the app is allowed to touch destructively: every root it has been
/// asked to scan, plus the resolved download directory. Populated as a side
/// effect of the normal flow (scan / scan_diff / downloads) and by the explicit
/// `register_roots` call the frontend makes at startup, so it is already filled
/// by the time any delete can happen.
pub static MANAGED_ROOTS: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());

pub fn register_root(path: &str) {
    let c = canon(path);
    if c.is_empty() {
        return;
    }
    if let Ok(mut v) = MANAGED_ROOTS.lock() {
        if !v.iter().any(|x| x == &c) {
            v.push(c);
        }
    }
}

fn under_managed_root(path: &str) -> bool {
    let roots = match MANAGED_ROOTS.lock() {
        Ok(v) => v,
        Err(e) => e.into_inner(), // a poisoned lock must not disable the check
    };
    roots.iter().any(|r| {
        // Prefix match on a SEPARATOR boundary, so "/music-secret" is not
        // considered to be inside "/music".
        path.len() > r.len()
            && path.starts_with(r.as_str())
            && matches!(path.as_bytes()[r.len()], b'/' | b'\\')
    })
}

/// Frontend startup: declare the source folders (and download dir) up front so
/// destructive operations are bounded even before the first scan of the session.
#[tauri::command]
pub fn register_roots(paths: Vec<String>) {
    for p in paths.iter().filter(|p| !p.is_empty()) {
        register_root(p);
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
        register_root(&root);
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
    // Scope check FIRST. The media-extension test below is not a boundary on its
    // own — it allowed deleting any .mp3/.flac/.mp4/… anywhere on the machine,
    // so one bad `invoke` from the webview could walk the whole filesystem.
    // Deletion is now confined to folders the app actually manages: registered
    // sources and the download directory.
    if !under_managed_root(&canon(&path)) {
        return Err("refusing to delete a file outside your music folders".into());
    }
    let meta = std::fs::symlink_metadata(p).map_err(|e| e.to_string())?;
    // Never follow a symlink out of the sandbox we just checked.
    if meta.file_type().is_symlink() {
        return Err("refusing to delete a symlink".into());
    }
    if !meta.is_file() {
        return Err("not a regular file".into());
    }
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    if !AUDIO_EXTS.contains(&ext.as_str()) {
        return Err(format!("refusing to delete a non-media file (.{ext})"));
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
    let is_file = p.is_file();
    let target = if is_file {
        path.clone()
    } else if p.is_dir() {
        path.clone()
    } else {
        p.parent()
            .map(|d| d.to_string_lossy().into_owned())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| path.clone())
    };
    #[cfg(target_os = "windows")]
    {
        // A real file gets SELECTED in Explorer (`/select,"C:\…"`) instead of only
        // opening its parent folder — matches what the user expects from a track row.
        if is_file {
            return std::process::Command::new("explorer")
                .arg(format!("/select,{}", target.replace('/', "\\")))
                .spawn()
                .map(|_| ())
                .map_err(|e| format!("cannot open file manager: {e}"));
        }
        return std::process::Command::new("explorer")
            .arg(&target)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("cannot open file manager: {e}"));
    }
    #[cfg(target_os = "android")]
    {
        // The system file manager has no CLI (no xdg-open/explorer on Android) —
        // opening a folder needs an Intent bridge we don't carry; the JS hides
        // the entry anyway (revealPath guard). Be honest instead of erroring on
        // a missing binary.
        let _ = target;
        return Err("no file manager bridge on Android".into());
    }
    #[cfg(not(any(target_os = "windows", target_os = "android")))]
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
    // Genuinely blocking (read + decode + resize + re-encode, seconds for a big
    // animated GIF), so it must not sit on an async worker.
    tauri::async_runtime::spawn_blocking(move || read_image_blocking(path))
        .await
        .map_err(|e| e.to_string())?
}

/// Ceiling on the FILE we are willing to read. Generous because everything above
/// the passthrough budget gets downscaled below — animated GIFs are legitimately
/// tens of MB, and the old flat 25 MB simply rejected them ("image too large"),
/// which is what made heavy GIFs look unsupported.
const IMG_MAX_BYTES: u64 = 192 * 1024 * 1024;
/// Above this, re-encode even if the dimensions are already fine: the result
/// becomes a base64 data: URL held as a JS string, so the webview pays ~4/3 of it.
const IMG_PASSTHROUGH_BYTES: usize = 8 * 1024 * 1024;

/// Decoded results, keyed by (path, mtime, len) so an edited file is re-read.
/// Essential now that GIFs are re-encoded: `plCoverInto` calls `read_image` for
/// EVERY playlist card on EVERY render, and re-quantizing an animation each time
/// would be seconds of CPU per repaint. Bounded by total bytes, not entry count,
/// because one entry can be several MB.
static IMG_CACHE: Mutex<Vec<(String, u64, u64, String)>> = Mutex::new(Vec::new());
const IMG_CACHE_BUDGET: usize = 48 * 1024 * 1024;

fn read_image_blocking(path: String) -> Result<String, String> {
    let stamp = std::fs::metadata(&path)
        .map(|m| {
            let t = m
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            (t, m.len())
        })
        .unwrap_or((0, 0));
    {
        let c = IMG_CACHE.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((_, _, _, v)) = c
            .iter()
            .find(|(p, t, l, _)| p == &path && *t == stamp.0 && *l == stamp.1)
        {
            return Ok(v.clone());
        }
    }
    let out = read_image_uncached(path.clone())?;
    {
        let mut c = IMG_CACHE.lock().unwrap_or_else(|e| e.into_inner());
        c.push((path, stamp.0, stamp.1, out.clone()));
        let mut total: usize = c.iter().map(|(_, _, _, v)| v.len()).sum();
        while total > IMG_CACHE_BUDGET && c.len() > 1 {
            total -= c.remove(0).3.len();
        }
    }
    Ok(out)
}

fn read_image_uncached(path: String) -> Result<String, String> {
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
    // Check the SIZE before reading: reading first meant pointing the wallpaper
    // picker at a 4 GB file allocated 4 GB and only then rejected it.
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    if meta.len() > IMG_MAX_BYTES {
        return Err(format!(
            "image too large ({} MB, max {} MB)",
            meta.len() / (1024 * 1024),
            IMG_MAX_BYTES / (1024 * 1024)
        ));
    }
    let data = std::fs::read(&path).map_err(|e| e.to_string())?;

    // Animated GIFs need their OWN path: the still-image branch below decodes a
    // single frame and re-encodes to JPEG, which would silently freeze the
    // animation. Downscale every frame instead and re-encode as a GIF.
    if ext == "gif" {
        match gif_downscale(&data) {
            Ok(Some(out)) => return Ok(format!("data:image/gif;base64,{}", STANDARD.encode(out))),
            Ok(None) => {} // already small enough — fall through to raw passthrough
            // Best-effort, like the still path: an odd/truncated GIF is handed
            // to the webview untouched rather than refused outright.
            Err(e) => eprintln!("[image] gif re-encode failed for {path}: {e}"),
        }
        return Ok(format!("data:image/gif;base64,{}", STANDARD.encode(data)));
    }
    // A wallpaper is shown full-screen, blurred and RE-composited under every
    // translucent panel repaint. Feeding the raw file (often 4K+) means a huge
    // decoded bitmap + a huge blur buffer — on software rendering / weak GPU
    // drivers that saturates the compositor (whole-PC freeze reports). Cap the
    // bitmap at 1920px: under a >=8px blur the extra detail is invisible anyway.
    // Below the cap we keep the original bytes untouched (no re-encode).
    // Everything is best-effort: undecodable/odd files fall back to the raw bytes.
    let resized = image::load_from_memory(&data).ok().and_then(|img| {
        let (w, h) = (img.width(), img.height());
        const MAX_DIM: u32 = 1920;
        if w.max(h) <= MAX_DIM {
            return None;
        }
        let (nw, nh) = if w >= h {
            (MAX_DIM, (h as u64 * MAX_DIM as u64 / w as u64).max(1) as u32)
        } else {
            ((w as u64 * MAX_DIM as u64 / h as u64).max(1) as u32, MAX_DIM)
        };
        let img = img.resize(nw, nh, image::imageops::FilterType::Triangle);
        let mut buf = std::io::Cursor::new(Vec::new());
        img.write_to(&mut buf, image::ImageFormat::Jpeg).ok()?;
        Some(format!("data:image/jpeg;base64,{}", STANDARD.encode(buf.into_inner())))
    });
    if let Some(out) = resized {
        return Ok(out);
    }
    Ok(format!("data:{mime};base64,{}", STANDARD.encode(data)))
}

/// Re-encode an animated GIF small enough to be used as a live background.
///
/// Returns `Ok(None)` when the original is already within budget (passed through
/// untouched — no generation loss, no CPU). A wallpaper is drawn full-screen
/// under a heavy blur and re-composited beneath every translucent panel, and an
/// ANIMATED one pays that cost on every frame, so the dimension cap is tighter
/// than for a still: past ~960px the blur has erased the detail anyway.
fn gif_downscale(data: &[u8]) -> Result<Option<Vec<u8>>, String> {
    use image::codecs::gif::{GifDecoder, GifEncoder, Repeat};
    use image::AnimationDecoder;

    const MAX_DIM: u32 = 960;
    /// Long animations are the real memory trap: every frame is decoded to a
    /// full RGBA canvas, so 1000 frames at 960×540 is ~2 GB live. Keep the
    /// beginning of the loop rather than refusing the file.
    const MAX_FRAMES: usize = 400;

    let decoder = GifDecoder::new(std::io::Cursor::new(data)).map_err(|e| e.to_string())?;
    let frames = decoder
        .into_frames()
        .take(MAX_FRAMES)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    if frames.is_empty() {
        return Err("no frames".into());
    }

    let (w, h) = frames[0].buffer().dimensions();
    let oversized = w.max(h) > MAX_DIM;
    // Nothing to gain: right size, short enough, small enough on disk.
    if !oversized && data.len() <= IMG_PASSTHROUGH_BYTES && frames.len() < MAX_FRAMES {
        return Ok(None);
    }
    let (nw, nh) = if !oversized {
        (w, h)
    } else if w >= h {
        (MAX_DIM, (h as u64 * MAX_DIM as u64 / w as u64).max(1) as u32)
    } else {
        ((w as u64 * MAX_DIM as u64 / h as u64).max(1) as u32, MAX_DIM)
    };

    let mut out = Vec::new();
    {
        // Speed 25 of 30: quantization quality is irrelevant under the blur, and
        // the slow setting took tens of seconds on a long animation.
        let mut enc = GifEncoder::new_with_speed(&mut out, 25);
        enc.set_repeat(Repeat::Infinite).map_err(|e| e.to_string())?;
        for f in frames {
            let delay = f.delay();
            // `into_frames` hands back frames already composited onto the full
            // canvas, so the per-frame offset is absorbed and must be reset —
            // re-applying it would drift every frame across the canvas.
            let buf = if oversized {
                image::imageops::resize(f.buffer(), nw, nh, image::imageops::FilterType::Triangle)
            } else {
                f.into_buffer()
            };
            enc.encode_frame(image::Frame::from_parts(buf, 0, 0, delay))
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(Some(out))
}

/// Bounded: values are base64 data URLs up to ~8 MB each, so an unbounded map
/// grew without limit across a long browsing session (thousands of thumbnails
/// retained for the life of the process — an OOM risk on Android). Insertion
/// order gives a cheap FIFO eviction; a miss just re-fetches.
static NET_IMG_CACHE: OnceLock<Mutex<Vec<(String, String)>>> = OnceLock::new();
const NET_IMG_CACHE_MAX: usize = 200;

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
    let cache = NET_IMG_CACHE.get_or_init(|| Mutex::new(Vec::new()));
    {
        let c = cache.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((_, v)) = c.iter().find(|(k, _)| k == &url) {
            return Ok(v.clone());
        }
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
    {
        let mut c = cache.lock().unwrap_or_else(|e| e.into_inner());
        if c.len() >= NET_IMG_CACHE_MAX {
            c.remove(0);
        }
        c.push((url, data.clone()));
    }
    Ok(data)
}

/// Differential scan for refreshes: walk the folders, but only read tags for
/// files NOT in `known` — the frontend keeps its cached metadata for the rest.
/// `present` lists every audio file found so the caller can prune deletions.
#[derive(Serialize)]
pub struct ScanDiff {
    pub new_tracks: Vec<Track>,
    pub present: Vec<String>,
    /// False when any part of the walk failed (root unreachable, permission
    /// denied, unreadable subtree). WITHOUT this the caller cannot tell "this
    /// folder is genuinely empty" from "I could not read this folder" — and the
    /// frontend prunes on `present`, so an unplugged drive or a lapsed Android
    /// permission silently DELETED every track of that source from the library
    /// and dropped the source itself. Only `yt:` entries survived, which is the
    /// "everything vanished, only online music is left" report.
    pub complete: bool,
}

pub fn scan_diff(roots: &[String], known: &HashSet<String>) -> ScanDiff {
    let mut new_tracks = Vec::new();
    let mut present = Vec::new();
    let mut complete = true;
    for root in roots {
        let root = canon(root);
        register_root(&root);
        // A root that cannot even be stat'd never yields a WalkDir error the
        // loop below can observe as such — it just ends. Check it up front.
        if !std::path::Path::new(&root).is_dir() {
            complete = false;
            continue;
        }
        for entry in WalkDir::new(&root) {
            let entry = match entry {
                Ok(e) => e,
                Err(_) => {
                    complete = false;
                    continue;
                }
            };
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
    ScanDiff { new_tracks, present, complete }
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

#[cfg(test)]
mod gif_tests {
    use super::{gif_downscale, IMG_PASSTHROUGH_BYTES};
    use image::codecs::gif::{GifDecoder, GifEncoder, Repeat};
    use image::{AnimationDecoder, Frame, RgbaImage};

    /// Build a real animated GIF: a moving band, so every frame differs and the
    /// encoder cannot collapse them.
    fn make_gif(w: u32, h: u32, frames: usize) -> Vec<u8> {
        let mut out = Vec::new();
        {
            let mut enc = GifEncoder::new_with_speed(&mut out, 30);
            enc.set_repeat(Repeat::Infinite).unwrap();
            for i in 0..frames {
                let mut img = RgbaImage::new(w, h);
                let band = (i as u32 * 7) % w;
                for y in 0..h {
                    for x in 0..w {
                        let on = x.abs_diff(band) < w / 8;
                        img.put_pixel(x, y, image::Rgba(if on { [220, 40, 90, 255] } else { [20, 20, 30, 255] }));
                    }
                }
                enc.encode_frame(Frame::new(img)).unwrap();
            }
        }
        out
    }

    fn probe(data: &[u8]) -> (u32, u32, usize) {
        let d = GifDecoder::new(std::io::Cursor::new(data)).unwrap();
        let fr = d.into_frames().collect_frames().unwrap();
        let (w, h) = fr[0].buffer().dimensions();
        (w, h, fr.len())
    }

    #[test]
    fn oversized_animation_is_downscaled_and_stays_animated() {
        let src = make_gif(1280, 720, 24);
        let (sw, sh, sn) = probe(&src);
        assert_eq!((sw, sh, sn), (1280, 720, 24), "fixture sanity");

        let out = gif_downscale(&src).expect("must decode").expect("must re-encode");
        let (w, h, n) = probe(&out);

        assert_eq!(w, 960, "long side capped at MAX_DIM");
        assert_eq!(h, 540, "aspect ratio preserved");
        assert_eq!(n, 24, "ANIMATION PRESERVED — every frame survives");
        assert!(out.len() < src.len(), "smaller: {} -> {}", src.len(), out.len());
    }

    #[test]
    fn small_animation_is_passed_through_untouched() {
        let src = make_gif(320, 180, 8);
        assert!(src.len() <= IMG_PASSTHROUGH_BYTES);
        // Ok(None) = "use the original bytes": no re-encode, no generation loss.
        assert!(gif_downscale(&src).unwrap().is_none());
    }

    #[test]
    fn frame_count_is_capped_so_memory_stays_bounded() {
        let src = make_gif(48, 48, 430); // over MAX_FRAMES (400)
        let out = gif_downscale(&src).expect("must decode").expect("must re-encode");
        let (_, _, n) = probe(&out);
        assert_eq!(n, 400, "truncated to the cap rather than refused");
    }

    #[test]
    fn a_single_frame_gif_still_round_trips() {
        let src = make_gif(1400, 1400, 1);
        let out = gif_downscale(&src).expect("must decode").expect("must re-encode");
        let (w, h, n) = probe(&out);
        assert_eq!((w, h, n), (960, 960, 1));
    }

    #[test]
    fn garbage_is_reported_not_panicked() {
        assert!(gif_downscale(b"GIF89a-not-really-a-gif").is_err());
        assert!(gif_downscale(&[]).is_err());
    }
}

#[cfg(test)]
mod img_cache_tests {
    use super::{read_image_blocking, IMG_CACHE};

    #[test]
    fn repeated_reads_hit_the_cache_and_a_rewrite_invalidates_it() {
        // A real file on disk, read through the real command body.
        let dir = std::env::temp_dir().join("mp-imgcache-test");
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("cover.png");

        // 1x1 PNG, then a visibly different 1x1 PNG.
        let png_a = image::RgbaImage::from_pixel(1, 1, image::Rgba([255, 0, 0, 255]));
        let png_b = image::RgbaImage::from_pixel(2, 2, image::Rgba([0, 255, 0, 255]));
        png_a.save(&p).unwrap();

        let path = p.to_string_lossy().to_string();
        let first = read_image_blocking(path.clone()).unwrap();
        let second = read_image_blocking(path.clone()).unwrap();
        assert_eq!(first, second, "same file must return the same data URL");
        let hits = {
            let c = IMG_CACHE.lock().unwrap();
            c.iter().filter(|(pp, _, _, _)| pp == &path).count()
        };
        assert_eq!(hits, 1, "cached once, not re-inserted per call");

        // Rewrite with different CONTENT and SIZE: the (mtime, len) stamp moves.
        std::thread::sleep(std::time::Duration::from_millis(1100)); // mtime is second-resolution
        png_b.save(&p).unwrap();
        let third = read_image_blocking(path.clone()).unwrap();
        assert_ne!(third, first, "an edited file must NOT serve the stale entry");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
