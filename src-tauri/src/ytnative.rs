//! Native YouTube backend — rustypipe (Innertube client, the NewPipe approach).
//! No yt-dlp binary involved, so it runs everywhere Rust runs — most notably
//! Android, where yt-dlp's glibc build can't execute. On desktop it is the
//! automatic fallback whenever yt-dlp is missing or a call fails.
//!
//! Every function mirrors the shape of its yt-dlp twin in `youtube.rs`
//! (OnlineTrack / PlaylistHit / PlaylistImport / Channel), so the frontend
//! doesn't know or care which backend served a request.

use crate::youtube::{Channel, DlState, OnlineTrack, PlaylistHit, PlaylistImport};
use rustypipe::client::RustyPipe;
use rustypipe::model::{ChannelItem, PlaylistItem, VideoItem};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::Emitter;

static STORAGE: OnceLock<PathBuf> = OnceLock::new();
static RP: OnceLock<RustyPipe> = OnceLock::new();

/// Called once at app setup with the app-data dir (rustypipe caches client
/// versions + visitor data there). Before/without it, a temp dir is used.
pub fn init_storage(dir: PathBuf) {
    let _ = STORAGE.set(dir);
}

fn rp() -> Result<&'static RustyPipe, String> {
    if let Some(r) = RP.get() {
        return Ok(r);
    }
    let dir = STORAGE
        .get()
        .cloned()
        .unwrap_or_else(|| std::env::temp_dir().join("musicplayer-rustypipe"));
    let _ = std::fs::create_dir_all(&dir);
    // Build rustypipe's reqwest client. On Android, pin the source to IPv4
    // (bind to 0.0.0.0 → IPv4-only socket): googlevideo binds each stream URL to
    // the IP that resolved it, and Android hands out rotating IPv6 "privacy"
    // addresses, so the resolve IP and the later audio-fetch IP differ → 403.
    // IPv4 uses the single stable NAT address for both, keeping the URL valid.
    let cb = reqwest::ClientBuilder::new();
    #[cfg(target_os = "android")]
    let cb = cb.local_address(std::net::IpAddr::V4(std::net::Ipv4Addr::UNSPECIFIED));
    // NB: do NOT set a custom user_agent here — rustypipe needs its own per-client
    // UAs to scrape search/browse (an Oculus VR UA makes it fail to find
    // visitorData and panic → infinite empty search). The VR client UA is used
    // ONLY for the media fetch + our own ANDROID_VR player call.
    let client = RustyPipe::builder()
        .storage_dir(dir)
        .build_with_client(cb)
        .map_err(|e| format!("native yt client: {e}"))?;
    let _ = RP.set(client);
    Ok(RP.get().unwrap())
}

fn es(e: impl std::fmt::Display) -> String {
    format!("native yt: {e}")
}

fn thumb(id: &str) -> String {
    format!("https://i.ytimg.com/vi/{id}/mqdefault.jpg")
}

fn vid_to_track(v: &VideoItem) -> OnlineTrack {
    OnlineTrack {
        // Use rustypipe's own thumbnail URL (same format as playlists, which
        // load fine) rather than a hand-built i.ytimg mqdefault link.
        thumbnail: v.thumbnail.last().map(|t| t.url.clone()).unwrap_or_else(|| thumb(&v.id)),
        title: v.name.clone(),
        artist: v
            .channel
            .as_ref()
            .map(|c| c.name.clone())
            .unwrap_or_else(|| "Unknown Artist".to_string()),
        duration_secs: v.duration.map(u64::from).unwrap_or(0),
        views: v.view_count,
        id: v.id.clone(),
    }
}

fn pl_to_hit(p: &PlaylistItem) -> PlaylistHit {
    PlaylistHit {
        url: format!("https://www.youtube.com/playlist?list={}", p.id),
        title: p.name.clone(),
        author: p.channel.as_ref().map(|c| c.name.clone()).unwrap_or_default(),
        thumbnail: p.thumbnail.last().map(|t| t.url.clone()).unwrap_or_default(),
        count: p.video_count.unwrap_or(0),
    }
}

/// "list=" query param, or the raw input when it already looks like an id.
fn playlist_id(url: &str) -> String {
    let u = url.trim();
    if let Some(pos) = u.find("list=") {
        u[pos + 5..]
            .split(['&', '#'])
            .next()
            .unwrap_or("")
            .to_string()
    } else {
        u.rsplit('/').next().unwrap_or(u).to_string()
    }
}

/// Channel id (UC…) from any channel URL form; @handles etc. are resolved.
async fn channel_id(url: &str) -> Result<String, String> {
    let u = url.trim().trim_end_matches('/');
    if let Some(pos) = u.find("/channel/") {
        return Ok(u[pos + 9..].split(['/', '?']).next().unwrap_or("").to_string());
    }
    use rustypipe::model::UrlTarget;
    match rp()?.query().resolve_url(u, false).await.map_err(es)? {
        UrlTarget::Channel { id, .. } => Ok(id),
        _ => Err("not a channel URL".into()),
    }
}

pub async fn search(q: &str, limit: u32, offset: u32) -> Result<Vec<OnlineTrack>, String> {
    let rp = rp()?;
    let mut res = rp.query().search::<VideoItem, _>(q).await.map_err(es)?;
    let want = (offset + limit) as usize;
    let _ = res.items.extend_limit(rp.query(), want).await;
    Ok(res
        .items
        .items
        .iter()
        .skip(offset as usize)
        .take(limit as usize)
        .map(vid_to_track)
        .collect())
}

pub async fn search_playlists(q: &str, limit: u32, offset: u32) -> Result<Vec<PlaylistHit>, String> {
    let rp = rp()?;
    let mut res = rp.query().search::<PlaylistItem, _>(q).await.map_err(es)?;
    let want = (offset + limit) as usize;
    let _ = res.items.extend_limit(rp.query(), want).await;
    Ok(res
        .items
        .items
        .iter()
        .skip(offset as usize)
        .take(limit as usize)
        .map(pl_to_hit)
        .collect())
}

pub async fn channel_search(q: &str) -> Result<Option<Channel>, String> {
    let rp = rp()?;
    let res = rp.query().search::<ChannelItem, _>(q).await.map_err(es)?;
    Ok(res.items.items.first().map(|c| Channel {
        title: c.name.clone(),
        url: format!("https://www.youtube.com/channel/{}", c.id),
        thumbnail: c.avatar.first().map(|t| t.url.clone()).unwrap_or_default(),
    }))
}

pub async fn channel_videos(url: &str, limit: u32, offset: u32) -> Result<Vec<OnlineTrack>, String> {
    let rp = rp()?;
    let id = channel_id(url).await?;
    let mut ch = rp.query().channel_videos(&id).await.map_err(es)?;
    let want = (offset + limit) as usize;
    let _ = ch.content.extend_limit(rp.query(), want).await;
    Ok(ch
        .content
        .items
        .iter()
        .skip(offset as usize)
        .take(limit as usize)
        .map(vid_to_track)
        .collect())
}

pub async fn channel_playlists(url: &str, limit: u32, offset: u32) -> Result<Vec<PlaylistHit>, String> {
    let rp = rp()?;
    let id = channel_id(url).await?;
    let mut ch = rp.query().channel_playlists(&id).await.map_err(es)?;
    let want = (offset + limit) as usize;
    let _ = ch.content.extend_limit(rp.query(), want).await;
    Ok(ch
        .content
        .items
        .iter()
        .skip(offset as usize)
        .take(limit as usize)
        .map(pl_to_hit)
        .collect())
}

pub async fn channel_all(url: &str) -> Result<Vec<OnlineTrack>, String> {
    let rp = rp()?;
    let id = channel_id(url).await?;
    let mut ch = rp.query().channel_videos(&id).await.map_err(es)?;
    let _ = ch.content.extend_limit(rp.query(), 1000).await;
    Ok(ch.content.items.iter().map(vid_to_track).collect())
}

pub async fn playlist(url: &str) -> Result<PlaylistImport, String> {
    let rp = rp()?;
    match rp.query().playlist(playlist_id(url)).await {
        Ok(mut pl) => {
            let _ = pl.videos.extend_limit(rp.query(), 1000).await;
            Ok(PlaylistImport {
                title: pl.name.clone(),
                tracks: pl.videos.items.iter().map(vid_to_track).collect(),
            })
        }
        // rustypipe's strict playlist model breaks whenever YouTube tweaks the
        // response (e.g. "missing field description"). Fall back to a lenient
        // scrape of the playlist page's ytInitialData — schema-tolerant, so it
        // keeps working across YouTube changes (mandatory on Android).
        Err(_) => scrape_playlist(url, 5000).await,
    }
}

pub async fn playlist_preview(url: &str, count: u32) -> Result<Vec<String>, String> {
    let pl = rp()?.query().playlist(playlist_id(url)).await.map_err(es)?;
    Ok(pl
        .videos
        .items
        .iter()
        .take(count as usize)
        .map(|v| v.name.clone())
        .collect())
}

/// First `count` tracks of a playlist as full items (title/channel/duration/
/// thumbnail) — feeds the playlist detail window without pulling all 1000.
pub async fn playlist_head(url: &str, count: u32) -> Result<PlaylistImport, String> {
    let rp = rp()?;
    match rp.query().playlist(playlist_id(url)).await {
        Ok(mut pl) => {
            if (pl.videos.items.len() as u32) < count {
                let _ = pl.videos.extend_limit(rp.query(), count as usize).await;
            }
            Ok(PlaylistImport {
                title: pl.name.clone(),
                tracks: pl.videos.items.iter().take(count as usize).map(vid_to_track).collect(),
            })
        }
        Err(_) => scrape_playlist(url, count).await,
    }
}

/// Schema-tolerant playlist extractor: fetch the public playlist page and walk
/// its inlined `ytInitialData` JSON for every `playlistVideoRenderer` (id, title,
/// author, duration). No strict model — resilient to YouTube response changes,
/// which is exactly what breaks rustypipe's typed playlist API.
async fn scrape_playlist(url: &str, limit: u32) -> Result<PlaylistImport, String> {
    let id = playlist_id(url);
    let page = format!("https://www.youtube.com/playlist?list={id}");
    let body = ureq::get(&page)
        .set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36")
        .set("Accept-Language", "en-US,en;q=0.9")
        // Bypass the EU cookie-consent interstitial (which otherwise 302s to
        // consent.youtube.com and returns no playlist data).
        .set("Cookie", "SOCS=CAISEwgDEgk0ODE3Nzk3MjQaAmVuIAEaBgiA_LyaBg; CONSENT=YES+")
        .call()
        .map_err(|e| format!("playlist page: {e}"))?
        .into_string()
        .map_err(|e| e.to_string())?;
    let json = extract_initial_data(&body).ok_or("could not read the playlist page")?;
    let v: serde_json::Value = serde_json::from_str(&json).map_err(|e| e.to_string())?;

    // Playlist name from the page <title> ("Name - YouTube"), not the greedy
    // JSON walk (which would grab a "Play all" button label).
    let title = body
        .find("<title>")
        .and_then(|i| body[i + 7..].find("</title>").map(|j| body[i + 7..i + 7 + j].to_string()))
        .map(|t| html_unescape(t.trim_end_matches(" - YouTube").trim()))
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| "Playlist".to_string());
    let mut tracks = Vec::new();
    collect_playlist_videos(&v, &mut tracks, limit as usize);
    if tracks.is_empty() {
        return Err("no tracks found on the playlist page".into());
    }
    Ok(PlaylistImport { title, tracks })
}

/// Minimal HTML entity unescape for the handful that show up in a page title.
fn html_unescape(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
}

/// Pull the `ytInitialData = {…};` JSON object out of a YouTube HTML page.
fn extract_initial_data(html: &str) -> Option<String> {
    let start = html.find("ytInitialData")?;
    let brace = html[start..].find('{')? + start;
    // Balance braces (accounting for strings/escapes) to find the object end.
    let bytes = html.as_bytes();
    let mut depth = 0i32;
    let mut in_str = false;
    let mut esc = false;
    for i in brace..bytes.len() {
        let c = bytes[i];
        if in_str {
            if esc { esc = false; }
            else if c == b'\\' { esc = true; }
            else if c == b'"' { in_str = false; }
        } else {
            match c {
                b'"' => in_str = true,
                b'{' => depth += 1,
                b'}' => {
                    depth -= 1;
                    if depth == 0 {
                        return Some(html[brace..=i].to_string());
                    }
                }
                _ => {}
            }
        }
    }
    None
}

/// First string value found for `key` anywhere in the tree (playlist title).
fn find_str(v: &serde_json::Value, key: &str) -> Option<String> {
    match v {
        serde_json::Value::Object(m) => {
            if let Some(s) = m.get(key).and_then(|x| x.as_str()) {
                if !s.is_empty() { return Some(s.to_string()); }
            }
            // YouTube wraps text as { "runs": [{ "text": … }] } or { "simpleText" }
            if let Some(t) = m.get(key) {
                if let Some(s) = text_of(t) { if !s.is_empty() { return Some(s); } }
            }
            m.values().find_map(|x| find_str(x, key))
        }
        serde_json::Value::Array(a) => a.iter().find_map(|x| find_str(x, key)),
        _ => None,
    }
}

/// Extract text from YouTube's `{runs:[{text}]}` / `{simpleText}` shapes.
fn text_of(v: &serde_json::Value) -> Option<String> {
    if let Some(s) = v.get("simpleText").and_then(|x| x.as_str()) {
        return Some(s.to_string());
    }
    if let Some(runs) = v.get("runs").and_then(|x| x.as_array()) {
        let s: String = runs.iter().filter_map(|r| r["text"].as_str()).collect();
        if !s.is_empty() { return Some(s); }
    }
    v.as_str().map(str::to_string)
}

/// Depth-first walk collecting playlist videos. Handles both the modern
/// `lockupViewModel` (2024+) and the legacy `playlistVideoRenderer` layouts,
/// deduplicating by videoId (the same item can appear in several sections).
fn collect_playlist_videos(v: &serde_json::Value, out: &mut Vec<OnlineTrack>, limit: usize) {
    let mut seen = std::collections::HashSet::new();
    walk_videos(v, out, &mut seen, limit);
}

fn walk_videos(
    v: &serde_json::Value,
    out: &mut Vec<OnlineTrack>,
    seen: &mut std::collections::HashSet<String>,
    limit: usize,
) {
    if out.len() >= limit {
        return;
    }
    match v {
        serde_json::Value::Object(m) => {
            let track = m
                .get("lockupViewModel")
                .and_then(lockup_to_track)
                .or_else(|| m.get("playlistVideoRenderer").and_then(video_renderer_to_track));
            if let Some(t) = track {
                if seen.insert(t.id.clone()) {
                    out.push(t);
                    if out.len() >= limit { return; }
                }
            }
            for val in m.values() {
                walk_videos(val, out, seen, limit);
                if out.len() >= limit { return; }
            }
        }
        serde_json::Value::Array(a) => {
            for val in a {
                walk_videos(val, out, seen, limit);
                if out.len() >= limit { return; }
            }
        }
        _ => {}
    }
}

/// Modern layout: lockupViewModel { contentId, contentType, metadata:{ … title.content } }
/// with the duration in a thumbnail badge ("3:55").
fn lockup_to_track(lm: &serde_json::Value) -> Option<OnlineTrack> {
    if lm["contentType"].as_str() != Some("LOCKUP_CONTENT_TYPE_VIDEO") {
        return None;
    }
    let id = lm["contentId"].as_str()?.to_string();
    let title = lm["metadata"]["lockupMetadataViewModel"]["title"]["content"]
        .as_str()
        .unwrap_or("Untitled")
        .to_string();
    // Channel name: first metadata row part's text (locale-proof), e.g.
    // metadata → contentMetadataViewModel → metadataRows[0] → metadataParts[0]
    // → text.content. Falls back to the avatar a11y label's trailing name.
    let meta = &lm["metadata"]["lockupMetadataViewModel"]["metadata"]["contentMetadataViewModel"];
    let artist = meta["metadataRows"][0]["metadataParts"][0]["text"]["content"]
        .as_str()
        .map(str::to_string)
        .or_else(|| find_str(&lm["metadata"], "a11yLabel").map(|s| s.rsplit(' ').next().unwrap_or("").to_string()))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "YouTube".to_string());
    // Duration badge text somewhere in the overlays ("m:ss" / "h:mm:ss").
    let duration_secs = find_hms(lm).unwrap_or(0);
    Some(OnlineTrack { thumbnail: thumb(&id), title, artist, duration_secs, views: None, id })
}

/// First "m:ss"-shaped text found in the subtree (thumbnail duration badge).
fn find_hms(v: &serde_json::Value) -> Option<u64> {
    match v {
        serde_json::Value::Object(m) => {
            if let Some(s) = m.get("text").and_then(|x| x.as_str()) {
                if s.matches(':').count() >= 1 && s.chars().all(|c| c.is_ascii_digit() || c == ':') {
                    if let Some(sec) = parse_hms(s) { return Some(sec); }
                }
            }
            m.values().find_map(find_hms)
        }
        serde_json::Value::Array(a) => a.iter().find_map(find_hms),
        _ => None,
    }
}

fn video_renderer_to_track(r: &serde_json::Value) -> Option<OnlineTrack> {
    let id = r["videoId"].as_str()?.to_string();
    let title = r.get("title").and_then(text_of).unwrap_or_else(|| "Untitled".to_string());
    let artist = r
        .get("shortBylineText")
        .and_then(text_of)
        .or_else(|| r.get("videoInfo").and_then(text_of))
        .unwrap_or_else(|| "Unknown Artist".to_string());
    let duration_secs = r["lengthSeconds"]
        .as_str()
        .and_then(|s| s.parse::<u64>().ok())
        .or_else(|| r.get("lengthText").and_then(text_of).and_then(|t| parse_hms(&t)))
        .unwrap_or(0);
    Some(OnlineTrack { thumbnail: thumb(&id), title, artist, duration_secs, views: None, id })
}

/// "3:57" / "1:02:03" → seconds.
fn parse_hms(s: &str) -> Option<u64> {
    let parts: Vec<u64> = s.trim().split(':').filter_map(|p| p.trim().parse().ok()).collect();
    match parts.as_slice() {
        [s] => Some(*s),
        [m, s] => Some(m * 60 + s),
        [h, m, s] => Some(h * 3600 + m * 60 + s),
        _ => None,
    }
}

fn best_stream_url(player: &rustypipe::model::VideoPlayer) -> Result<String, String> {
    if let Some(s) = player
        .audio_streams
        .iter()
        .filter(|s| s.mime.to_lowercase().contains("mp4"))
        .max_by_key(|s| s.bitrate)
    {
        return Ok(s.url.clone());
    }
    player
        .video_streams
        .iter()
        .filter(|s| s.mime.to_lowercase().contains("mp4"))
        .min_by_key(|s| s.bitrate)
        .map(|s| s.url.clone())
        .ok_or_else(|| "no AAC/mp4 stream available for this video".into())
}

// ─── ANDROID_VR stream resolution ───────────────────────────────────────────
// As of 2025+, YouTube gates stream URLs behind PO tokens (BotGuard) and JS
// signature descrambling for every client rustypipe supports (Desktop/Ios/Tv →
// 403 or broken deobfuscation), which is why streaming AND downloading died. The
// ANDROID_VR (Oculus Quest) client is the one that still returns DIRECTLY
// fetchable URLs — no JS runtime, no signature, no PO token. So we call the
// Innertube player endpoint ourselves for stream + download resolution. (Search,
// playlists and channels still go through rustypipe, which works for those.)
/// Must match crate::stream::YT_UA (the fetch UA).
pub const VR_UA: &str = "com.google.android.apps.youtube.vr.oculus/1.62.27 (Linux; U; Android 12L; en_US; Quest 3 Build/SQ3A.220605.009.A1) gzip";
const VR_VERSION: &str = "1.62.27";

// visitorData is REQUIRED — without it the player returns LOGIN_REQUIRED. Cached.
static VISITOR: OnceLock<Mutex<Option<(Instant, String)>>> = OnceLock::new();

fn visitor_data() -> Result<String, String> {
    let cell = VISITOR.get_or_init(|| Mutex::new(None));
    if let Some((at, vd)) = cell.lock().unwrap().as_ref() {
        if at.elapsed() < Duration::from_secs(3 * 3600) {
            return Ok(vd.clone());
        }
    }
    let html = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(15))
        .build()
        .get("https://www.youtube.com/")
        .set("User-Agent", "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0")
        .set("Accept-Language", "en")
        .call()
        .map_err(es)?
        .into_string()
        .map_err(es)?;
    let vd = html
        .split_once("\"visitorData\":\"")
        .and_then(|(_, r)| r.split_once('"'))
        .map(|(v, _)| v.to_string())
        .ok_or("could not obtain visitorData")?;
    *cell.lock().unwrap() = Some((Instant::now(), vd.clone()));
    Ok(vd)
}

/// Raw Innertube player response via the ANDROID_VR client.
fn vr_player(id: &str) -> Result<serde_json::Value, String> {
    let vd = visitor_data()?;
    let body = serde_json::json!({
        "context": { "client": {
            "clientName": "ANDROID_VR", "clientVersion": VR_VERSION,
            "deviceMake": "Oculus", "deviceModel": "Quest 3", "androidSdkVersion": 32,
            "osName": "Android", "osVersion": "12L", "hl": "en", "gl": "US",
            "visitorData": vd,
        }},
        "videoId": id, "contentCheckOk": true, "racyCheckOk": true,
    });
    let v: serde_json::Value = crate::stream::media_agent("https://www.youtube.com/youtubei/v1/player")
        .post("https://www.youtube.com/youtubei/v1/player")
        .set("User-Agent", VR_UA)
        .set("X-YouTube-Client-Name", "28")
        .set("X-YouTube-Client-Version", VR_VERSION)
        .set("X-Goog-Visitor-Id", &vd)
        .send_json(body)
        .map_err(es)?
        .into_json()
        .map_err(es)?;
    let status = v["playabilityStatus"]["status"].as_str().unwrap_or("");
    if status != "OK" {
        let reason = v["playabilityStatus"]["reason"]
            .as_str()
            .or_else(|| v["playabilityStatus"]["errorScreen"]["playerErrorMessageRenderer"]["reason"]["simpleText"].as_str())
            .unwrap_or(status);
        return Err(format!("unplayable: {reason}"));
    }
    Ok(v)
}

/// Highest-bitrate directly-fetchable AAC/mp4 audio URL from a VR player payload.
fn vr_audio_url(v: &serde_json::Value, max_kbps: Option<u64>) -> Result<String, String> {
    let fmts = v["streamingData"]["adaptiveFormats"]
        .as_array()
        .ok_or("no adaptiveFormats")?;
    let mut auds: Vec<&serde_json::Value> = fmts
        .iter()
        .filter(|f| {
            f["mimeType"].as_str().map(|m| m.contains("audio/mp4")).unwrap_or(false)
                && f["url"].as_str().is_some()
        })
        .collect();
    if auds.is_empty() {
        return Err("no audio/mp4 stream".into());
    }
    auds.sort_by_key(|f| f["bitrate"].as_u64().unwrap_or(0));
    let pick = match max_kbps {
        // closest at or below the cap, else the lowest available
        Some(cap) => auds
            .iter()
            .rev()
            .find(|f| f["bitrate"].as_u64().unwrap_or(0) <= cap * 1000)
            .or_else(|| auds.first())
            .copied(),
        None => auds.last().copied(),
    };
    pick.and_then(|f| f["url"].as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "no audio/mp4 stream".into())
}

fn vr_title_artist(v: &serde_json::Value, id: &str) -> (String, String) {
    let d = &v["videoDetails"];
    (
        d["title"].as_str().filter(|s| !s.is_empty()).unwrap_or(&format!("YouTube {id}")).to_string(),
        d["author"].as_str().unwrap_or_default().to_string(),
    )
}

/// Best playable stream URL via the ANDROID_VR client (directly fetchable).
pub async fn stream_url(id: &str) -> Result<String, String> {
    let v = vr_player(id)?;
    vr_audio_url(&v, None)
}

fn safe_filename(s: &str) -> String {
    let cleaned: String = s
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c if c.is_control() => ' ',
            c => c,
        })
        .collect();
    let t = cleaned.trim().trim_matches('.').to_string();
    if t.is_empty() { "Untitled".into() } else { t }
}

/// Download the best AAC stream to `<dir>/<title> [<id>].m4a` with title /
/// artist / album / cover tags. No ffmpeg conversion — the m4a is stored as-is
/// (every place in the app matches files by the `[videoId]` tag, extension
/// agnostic). Emits the same "dl" {id, pct} events as the yt-dlp path and
/// honors `yt_cancel` via DlState's canceled set.
pub async fn download(
    app: tauri::AppHandle,
    dls: &DlState,
    id: &str,
    dir: &str,
    quality: &str,
) -> Result<String, String> {
    // Resolve with a couple of retries — a transient DNS/network hiccup on the
    // first resolve shouldn't fail (and get marked permanent) the whole download.
    let mut vp = {
        let mut got = None;
        let mut e = String::new();
        for _ in 0..3 {
            match vr_player(id) { Ok(p) => { got = Some(p); break; } Err(err) => e = err }
        }
        got.ok_or(e)?
    };
    let (title, artist) = vr_title_artist(&vp, id);
    let max_kbps = if quality == "best" || quality.is_empty() { None } else { quality.parse::<u64>().ok() };

    let path = format!("{dir}/{} [{id}].m4a", safe_filename(&title));
    let part = format!("{path}.part");
    dls.canceled.lock().unwrap().remove(id);

    // A stream URL can occasionally 403 (expired) — re-resolve a fresh player +
    // URL and retry a few times.
    let mut resp = None;
    let mut last = String::new();
    for attempt in 0..3 {
        if attempt > 0 {
            vp = match vr_player(id) { Ok(p) => p, Err(e) => { last = e; continue; } };
        }
        let url = vr_audio_url(&vp, max_kbps)?;
        match crate::stream::media_agent(&url).get(&url).set("User-Agent", crate::stream::YT_UA).call() {
            Ok(r) => { resp = Some(r); break; }
            Err(ureq::Error::Status(403, _)) => { last = "403 (stream URL expired)".into(); continue; }
            Err(e) => { last = format!("{e}"); continue; }
        }
    }
    let resp = resp.ok_or_else(|| format!("stream fetch: {last}"))?;
    let total: u64 = resp
        .header("Content-Length")
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    let mut reader = resp.into_reader();
    let mut out = std::fs::File::create(&part).map_err(|e| e.to_string())?;
    let mut buf = [0u8; 64 * 1024];
    let mut done: u64 = 0;
    let mut last_pct: i32 = -1;
    loop {
        if dls.canceled.lock().unwrap().remove(id) {
            drop(out);
            let _ = std::fs::remove_file(&part);
            return Err("canceled".into());
        }
        let n = reader.read(&mut buf).map_err(|e| format!("stream read: {e}"))?;
        if n == 0 {
            break;
        }
        out.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        done += n as u64;
        if total > 0 {
            let pct = ((done * 100) / total) as i32;
            if pct != last_pct {
                last_pct = pct;
                let _ = app.emit("dl", serde_json::json!({ "id": id, "pct": pct }));
            }
        }
    }
    out.flush().map_err(|e| e.to_string())?;
    drop(out);
    if total > 0 && done < total {
        let _ = std::fs::remove_file(&part);
        return Err("stream ended early".into());
    }
    std::fs::rename(&part, &path).map_err(|e| e.to_string())?;

    // Tags (best-effort — an untagged file is still playable and enriched from
    // the online index by the frontend).
    let _ = write_tags(&path, &title, &artist, id);
    Ok(path)
}

/// Pick the download URL for a player + quality ("best" → highest-bitrate m4a;
/// a kbps cap → the m4a closest to and preferably ≤ the target).
fn pick_download_url(player: &rustypipe::model::VideoPlayer, quality: &str) -> Result<String, String> {
    if quality == "best" || quality.is_empty() {
        return stream_url_of(player);
    }
    let target = quality.parse::<u32>().unwrap_or(0) * 1000;
    let m4a: Vec<_> = player.audio_streams.iter().filter(|s| s.mime.to_lowercase().contains("mp4")).collect();
    if m4a.is_empty() {
        return stream_url_of(player);
    }
    let under = m4a.iter().filter(|s| s.bitrate <= target).max_by_key(|s| s.bitrate);
    Ok(under.or_else(|| m4a.iter().min_by_key(|s| s.bitrate)).unwrap().url.clone())
}

fn stream_url_of(player: &rustypipe::model::VideoPlayer) -> Result<String, String> {
    player
        .audio_streams
        .iter()
        .filter(|s| s.mime.to_lowercase().contains("mp4"))
        .max_by_key(|s| s.bitrate)
        .map(|s| s.url.clone())
        .ok_or_else(|| "no AAC/m4a audio stream available".into())
}

fn write_tags(path: &str, title: &str, artist: &str, id: &str) -> Result<(), String> {
    use lofty::config::WriteOptions;
    use lofty::picture::{MimeType, Picture, PictureType};
    use lofty::prelude::*;
    use lofty::probe::Probe;
    let mut tagged = Probe::open(path)
        .map_err(|e| e.to_string())?
        .read()
        .map_err(|e| e.to_string())?;
    let tag = match tagged.primary_tag_mut() {
        Some(t) => t,
        None => {
            let ty = tagged.primary_tag_type();
            tagged.insert_tag(lofty::tag::Tag::new(ty));
            tagged.primary_tag_mut().ok_or("no tag")?
        }
    };
    tag.set_title(title.to_string());
    tag.set_artist(artist.to_string());
    tag.set_album("YouTube".to_string());
    if let Ok(resp) = ureq::get(&thumb(id)).call() {
        let mut bytes = Vec::new();
        if resp.into_reader().take(2 * 1024 * 1024).read_to_end(&mut bytes).is_ok() && !bytes.is_empty() {
            tag.push_picture(Picture::new_unchecked(
                PictureType::CoverFront,
                Some(MimeType::Jpeg),
                None,
                bytes,
            ));
        }
    }
    tagged
        .save_to_path(path, WriteOptions::default())
        .map_err(|e| e.to_string())
}

/// True when the native backend is the only option (Android: yt-dlp's glibc
/// binary cannot run on bionic).
pub fn forced() -> bool {
    cfg!(target_os = "android")
}
