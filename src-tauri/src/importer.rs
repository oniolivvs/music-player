//! Import playlists from other apps. A local/YouTube player can't read Spotify
//! audio (DRM), but it CAN read a public Spotify playlist's *track list* — song
//! title + artist — and then resolve each one to a YouTube stream (front-end).
//!
//! Optional user API keys plus two keyless fallbacks:
//! 1. Client credentials use Spotify's official Web API when configured.
//! 2. The public **embed** page inlines an anonymous Web-API `accessToken`.
//!    With it we call the official paginated API → FULL playlists (the embed
//!    track list itself caps out around 100 entries) + album & duration per
//!    track (better YouTube matching).
//! 3. If the token or the API ever breaks, fall back to parsing the embed
//!    page's own `trackList` like before. Worst case the user pastes an
//!    "Artist - Title" list.

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Serialize;
use serde_json::Value;

const UA: &str = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";

#[derive(Serialize)]
pub struct ExtTrack {
    pub title: String,
    pub artist: String,
    pub album: String,
    pub duration_secs: u64,
}

#[derive(Serialize)]
pub struct ExtImport {
    pub name: String,
    pub tracks: Vec<ExtTrack>,
}

/// Pull `(kind, id)` out of any Spotify reference: web links (incl. localized
/// `/intl-xx/` ones and `?si=` query strings) and `spotify:` URIs.
fn parse_spotify(url: &str) -> Option<(String, String)> {
    if let Some(rest) = url.trim().strip_prefix("spotify:") {
        let mut it = rest.split(':');
        let kind = it.next()?;
        let id = it.next()?;
        if matches!(kind, "playlist" | "album" | "track") {
            return Some((kind.to_string(), id.to_string()));
        }
    }
    for kind in ["playlist", "album", "track"] {
        let needle = format!("{kind}/");
        if let Some(pos) = url.find(&needle) {
            let id: String = url[pos + needle.len()..]
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric())
                .collect();
            if id.len() >= 10 {
                return Some((kind.to_string(), id));
            }
        }
    }
    None
}

/// Extract the `<script id="__NEXT_DATA__" ...>…</script>` JSON payload.
fn extract_next_data(html: &str) -> Option<String> {
    let mpos = html.find("__NEXT_DATA__")?;
    let after = &html[mpos..];
    let start = after.find('>')? + 1;
    let end = after[start..].find("</script>")?;
    Some(after[start..start + end].to_string())
}

/// Anonymous Web-API bearer token inlined in the embed page JSON.
fn extract_token(html: &str) -> Option<String> {
    let needle = "\"accessToken\":\"";
    let pos = html.find(needle)?;
    let rest = &html[pos + needle.len()..];
    let end = rest.find('"')?;
    let tok = &rest[..end];
    (tok.len() > 20 && !tok.contains('\\')).then(|| tok.to_string())
}

fn api_get(token: &str, url: &str) -> Result<Value, String> {
    let body = ureq::get(url)
        .set("Authorization", &format!("Bearer {token}"))
        .set("User-Agent", UA)
        .call()
        .map_err(|e| format!("Spotify API: {e}"))?
        .into_string()
        .map_err(|e| e.to_string())?;
    serde_json::from_str(&body).map_err(|e| e.to_string())
}

fn client_token(client_id: &str, client_secret: &str) -> Result<String, String> {
    let id = client_id.trim();
    let secret = client_secret.trim();
    if id.is_empty() || secret.is_empty() {
        return Err("Spotify Client ID and Client Secret are both required".into());
    }
    let auth = STANDARD.encode(format!("{id}:{secret}"));
    let body = ureq::post("https://accounts.spotify.com/api/token")
        .set("Authorization", &format!("Basic {auth}"))
        .set("Content-Type", "application/x-www-form-urlencoded")
        .set("User-Agent", UA)
        .send_form(&[("grant_type", "client_credentials")])
        .map_err(|e| format!("Spotify credentials: {e}"))?
        .into_string()
        .map_err(|e| e.to_string())?;
    let value: Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    value["access_token"]
        .as_str()
        .filter(|token| !token.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| "Spotify did not return an access token".into())
}

/// One API track object → ExtTrack. Playlist items wrap the track in `track`;
/// album/single endpoints return it bare (and without an `album` object).
fn track_of(v: &Value) -> Option<ExtTrack> {
    let t = if v.get("track").is_some_and(|x| x.is_object()) { &v["track"] } else { v };
    let title = t["name"].as_str()?.trim().to_string();
    if title.is_empty() {
        return None;
    }
    let artist = t["artists"]
        .as_array()
        .map(|a| a.iter().filter_map(|x| x["name"].as_str()).collect::<Vec<_>>().join(", "))
        .unwrap_or_default();
    let album = t["album"]["name"].as_str().unwrap_or("").to_string();
    let duration_secs = t["duration_ms"].as_u64().unwrap_or(0) / 1000;
    Some(ExtTrack { title, artist, album, duration_secs })
}

/// Full, paginated fetch through the official API using the anonymous token.
fn via_api(token: &str, kind: &str, id: &str) -> Result<ExtImport, String> {
    match kind {
        "playlist" => {
            let meta = api_get(token, &format!("https://api.spotify.com/v1/playlists/{id}?fields=name"))?;
            let name = meta["name"].as_str().unwrap_or("Imported playlist").to_string();
            let mut tracks = Vec::new();
            let mut offset = 0usize;
            loop {
                let page = api_get(
                    token,
                    &format!("https://api.spotify.com/v1/playlists/{id}/tracks?limit=100&offset={offset}&fields=total,items(track(name,duration_ms,artists(name),album(name)))"),
                )?;
                let items = page["items"].as_array().cloned().unwrap_or_default();
                if items.is_empty() {
                    break;
                }
                offset += items.len();
                tracks.extend(items.iter().filter_map(track_of));
                let total = page["total"].as_u64().unwrap_or(0) as usize;
                if offset >= total || offset >= 3000 {
                    break; // 3000 = sanity cap, not a Spotify limit
                }
            }
            Ok(ExtImport { name, tracks })
        }
        "album" => {
            let meta = api_get(token, &format!("https://api.spotify.com/v1/albums/{id}"))?;
            let name = meta["name"].as_str().unwrap_or("Imported album").to_string();
            let mut tracks: Vec<ExtTrack> = meta["tracks"]["items"]
                .as_array()
                .map(|a| a.iter().filter_map(track_of).collect())
                .unwrap_or_default();
            let total = meta["tracks"]["total"].as_u64().unwrap_or(0) as usize;
            let mut offset = tracks.len();
            while offset < total && offset < 1000 {
                let page = api_get(token, &format!("https://api.spotify.com/v1/albums/{id}/tracks?limit=50&offset={offset}"))?;
                let items = page["items"].as_array().cloned().unwrap_or_default();
                if items.is_empty() {
                    break;
                }
                offset += items.len();
                tracks.extend(items.iter().filter_map(track_of));
            }
            for t in &mut tracks {
                if t.album.is_empty() {
                    t.album = name.clone();
                }
            }
            Ok(ExtImport { name, tracks })
        }
        _ => {
            let v = api_get(token, &format!("https://api.spotify.com/v1/tracks/{id}"))?;
            let t = track_of(&v).ok_or("Could not read the track")?;
            let name = t.title.clone();
            Ok(ExtImport { name, tracks: vec![t] })
        }
    }
}

/// Depth-first search for the object that owns a non-empty `trackList` array —
/// resilient to Spotify moving it around inside the state tree.
fn find_entity(v: &Value) -> Option<&Value> {
    match v {
        Value::Object(map) => {
            if map.get("trackList").and_then(|t| t.as_array()).is_some_and(|a| !a.is_empty()) {
                return Some(v);
            }
            map.values().find_map(find_entity)
        }
        Value::Array(arr) => arr.iter().find_map(find_entity),
        _ => None,
    }
}

fn collect(v: &Value) -> Option<ExtImport> {
    let entity = find_entity(v)?;
    let name = entity
        .get("name")
        .and_then(|x| x.as_str())
        .or_else(|| entity.get("title").and_then(|x| x.as_str()))
        .unwrap_or("Imported playlist")
        .trim()
        .to_string();
    let list = entity.get("trackList")?.as_array()?;
    let mut tracks = Vec::new();
    for t in list {
        // embed track entries: { title, subtitle (= artist), uri, duration (ms), … }
        let title = t.get("title").and_then(|x| x.as_str()).unwrap_or("").trim().to_string();
        let artist = t.get("subtitle").and_then(|x| x.as_str()).unwrap_or("").trim().to_string();
        let duration_secs = t.get("duration").and_then(|x| x.as_u64()).unwrap_or(0) / 1000;
        if !title.is_empty() {
            tracks.push(ExtTrack { title, artist, album: String::new(), duration_secs });
        }
    }
    Some(ExtImport { name, tracks })
}

#[tauri::command]
pub async fn import_spotify(
    url: String,
    client_id: Option<String>,
    client_secret: Option<String>,
) -> Result<ExtImport, String> {
    let (kind, id) = parse_spotify(&url)
        .ok_or_else(|| "Not a Spotify playlist / album / track link.".to_string())?;

    let configured_id = client_id.unwrap_or_default();
    let configured_secret = client_secret.unwrap_or_default();
    if !configured_id.trim().is_empty() || !configured_secret.trim().is_empty() {
        if let Ok(token) = client_token(&configured_id, &configured_secret) {
            if let Ok(imported) = via_api(&token, &kind, &id) {
                if !imported.tracks.is_empty() {
                    return Ok(imported);
                }
            }
        }
    }

    let embed = format!("https://open.spotify.com/embed/{kind}/{id}");
    let body = ureq::get(&embed)
        .set("User-Agent", UA)
        .call()
        .map_err(|e| format!("Could not reach Spotify: {e}"))?
        .into_string()
        .map_err(|e| e.to_string())?;

    // Preferred path: anonymous token → official API → complete + rich list.
    if let Some(token) = extract_token(&body) {
        if let Ok(imp) = via_api(&token, &kind, &id) {
            if !imp.tracks.is_empty() {
                return Ok(imp);
            }
        }
    }

    // Fallback: parse the embed page's own (possibly truncated) track list.
    let json = extract_next_data(&body).ok_or_else(|| {
        "Could not read the Spotify page (private playlist, or Spotify changed its layout — paste the songs as text instead).".to_string()
    })?;
    let v: Value = serde_json::from_str(&json).map_err(|e| e.to_string())?;
    let imp = collect(&v)
        .filter(|i| !i.tracks.is_empty())
        .ok_or_else(|| "No tracks found (private or empty playlist?).".to_string())?;
    Ok(imp)
}
