use serde::Serialize;
use serde_json::Value;
use std::time::Duration;
use tauri::{AppHandle, Manager, State};

use crate::youtube::{caption_metadata, YtCfg};

#[derive(Serialize, Clone)]
pub struct LyricsResult {
    pub source: String,
    pub format: String,
    pub content: String,
    pub synced: bool,
    pub language: String,
    pub saved_path: Option<String>,
}

fn url_encode(value: &str) -> String {
    value
        .bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (byte as char).to_string()
            }
            _ => format!("%{byte:02X}"),
        })
        .collect()
}

fn safe_name(value: &str) -> String {
    let cleaned: String = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, ' ' | '-' | '_' | '.') {
                ch
            } else {
                '_'
            }
        })
        .collect();
    cleaned
        .trim_matches([' ', '.', '_'])
        .chars()
        .take(140)
        .collect()
}

fn json3_to_lrc(content: &str) -> Option<String> {
    let value: Value = serde_json::from_str(content).ok()?;
    let mut lines = Vec::new();
    for event in value.get("events")?.as_array()? {
        let ms = event.get("tStartMs").and_then(Value::as_u64).unwrap_or(0);
        let text = event
            .get("segs")
            .and_then(Value::as_array)
            .map(|segments| {
                segments
                    .iter()
                    .filter_map(|segment| segment.get("utf8").and_then(Value::as_str))
                    .collect::<String>()
            })
            .unwrap_or_default()
            .replace('\n', " ")
            .trim()
            .to_string();
        if text.is_empty() {
            continue;
        }
        lines.push(format!(
            "[{:02}:{:02}.{:02}] {}",
            ms / 60_000,
            (ms % 60_000) / 1_000,
            (ms % 1_000) / 10,
            text
        ));
    }
    (!lines.is_empty()).then(|| lines.join("\n"))
}

fn caption_choice<'a>(root: &'a Value, requested: &str) -> Option<(&'a str, &'a Value)> {
    let object = root.as_object()?;
    let preferred = requested.trim().to_ascii_lowercase();
    if preferred != "original" {
        if let Some((key, value)) = object
            .iter()
            .find(|(key, _)| key.to_ascii_lowercase() == preferred)
        {
            return Some((key, value));
        }
        if let Some((key, value)) = object.iter().find(|(key, _)| {
            key.to_ascii_lowercase()
                .starts_with(&format!("{preferred}-"))
        }) {
            return Some((key, value));
        }
    }
    object
        .iter()
        .find(|(key, _)| key.as_str() != "live_chat")
        .map(|(key, value)| (key.as_str(), value))
}

fn youtube_caption(cfg: &YtCfg, id: &str, language: &str) -> Result<LyricsResult, String> {
    let meta = caption_metadata(cfg, id)?;
    let requested = if language == "original" {
        meta.get("language")
            .or_else(|| meta.get("language_code"))
            .and_then(Value::as_str)
            .unwrap_or("original")
    } else {
        language
    };
    let (lang, choices) = caption_choice(meta.get("subtitles").unwrap_or(&Value::Null), requested)
        .or_else(|| {
            caption_choice(
                meta.get("automatic_captions").unwrap_or(&Value::Null),
                requested,
            )
        })
        .ok_or_else(|| "no YouTube captions".to_string())?;
    let entries = choices
        .as_array()
        .ok_or_else(|| "invalid caption list".to_string())?;
    let entry = entries
        .iter()
        .find(|item| item.get("ext").and_then(Value::as_str) == Some("json3"))
        .or_else(|| {
            entries
                .iter()
                .find(|item| item.get("ext").and_then(Value::as_str) == Some("vtt"))
        })
        .or_else(|| entries.first())
        .ok_or_else(|| "empty caption list".to_string())?;
    let url = entry
        .get("url")
        .and_then(Value::as_str)
        .ok_or_else(|| "caption URL missing".to_string())?;
    let ext = entry.get("ext").and_then(Value::as_str).unwrap_or("vtt");
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(12))
        .timeout_read(Duration::from_secs(25))
        .build();
    let body = agent
        .get(url)
        .set("User-Agent", "MusicPlayer/0.22")
        .call()
        .map_err(|error| format!("caption download: {error}"))?
        .into_string()
        .map_err(|error| format!("caption body: {error}"))?;
    let (format, content) = if ext == "json3" {
        (
            "lrc".into(),
            json3_to_lrc(&body).ok_or_else(|| "empty captions".to_string())?,
        )
    } else {
        (ext.into(), body)
    };
    Ok(LyricsResult {
        source: "YouTube captions".into(),
        format,
        content,
        synced: true,
        language: lang.into(),
        saved_path: None,
    })
}

fn lrclib_lookup(
    title: &str,
    artist: &str,
    album: &str,
    duration: u64,
    language: &str,
) -> Result<LyricsResult, String> {
    let mut url = format!(
        "https://lrclib.net/api/get?track_name={}&artist_name={}",
        url_encode(title),
        url_encode(artist)
    );
    if !album.trim().is_empty() {
        url.push_str(&format!("&album_name={}", url_encode(album)));
    }
    if duration > 0 {
        url.push_str(&format!("&duration={duration}"));
    }
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(12))
        .timeout_read(Duration::from_secs(25))
        .build();
    let value: Value = agent
        .get(&url)
        .set(
            "User-Agent",
            "MusicPlayer/0.22 (https://github.com/oniolivvs/music-player)",
        )
        .call()
        .map_err(|error| format!("LRCLIB: {error}"))?
        .into_json()
        .map_err(|error| format!("LRCLIB response: {error}"))?;
    if let Some(content) = value
        .get("syncedLyrics")
        .and_then(Value::as_str)
        .filter(|text| !text.trim().is_empty())
    {
        return Ok(LyricsResult {
            source: "LRCLIB".into(),
            format: "lrc".into(),
            content: content.into(),
            synced: true,
            language: language.into(),
            saved_path: None,
        });
    }
    if let Some(content) = value
        .get("plainLyrics")
        .and_then(Value::as_str)
        .filter(|text| !text.trim().is_empty())
    {
        return Ok(LyricsResult {
            source: "LRCLIB".into(),
            format: "txt".into(),
            content: content.into(),
            synced: false,
            language: language.into(),
            saved_path: None,
        });
    }
    Err("no LRCLIB lyrics".into())
}

fn save(
    app: &AppHandle,
    result: &mut LyricsResult,
    artist: &str,
    title: &str,
    media_path: Option<&str>,
) -> Result<(), String> {
    let beside_media = media_path
        .map(std::path::Path::new)
        .filter(|path| path.is_file())
        .and_then(std::path::Path::parent)
        .map(std::path::Path::to_path_buf);
    let directory = beside_media.unwrap_or(
        app.path()
            .app_data_dir()
            .map_err(|error| error.to_string())?
            .join("lyrics"),
    );
    std::fs::create_dir_all(&directory).map_err(|error| format!("lyrics folder: {error}"))?;
    let stem = safe_name(&format!("{artist} - {title} - {}", result.language));
    let path = directory.join(format!(
        "{}.{}",
        if stem.is_empty() { "lyrics" } else { &stem },
        result.format
    ));
    std::fs::write(&path, result.content.as_bytes())
        .map_err(|error| format!("save lyrics: {error}"))?;
    result.saved_path = Some(path.to_string_lossy().into_owned());
    Ok(())
}

#[tauri::command]
pub async fn lyrics_lookup(
    app: AppHandle,
    cfg: State<'_, YtCfg>,
    title: String,
    artist: String,
    album: Option<String>,
    duration: Option<u64>,
    language: Option<String>,
    youtube_id: Option<String>,
    youtube_captions: Option<bool>,
    lrclib: Option<bool>,
    save_local: Option<bool>,
    media_path: Option<String>,
) -> Result<LyricsResult, String> {
    let title = title.trim().chars().take(300).collect::<String>();
    let artist = artist.trim().chars().take(300).collect::<String>();
    if title.is_empty()
        || artist.is_empty()
        || title.chars().any(char::is_control)
        || artist.chars().any(char::is_control)
    {
        return Err("title and artist are required".into());
    }
    let cfg = cfg.inner().clone();
    let language = language.unwrap_or_else(|| "original".into());
    let album = album.unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || {
        let mut errors = Vec::new();
        let mut result = None;
        if youtube_captions.unwrap_or(true) {
            if let Some(id) = youtube_id.as_deref() {
                match youtube_caption(&cfg, id, &language) {
                    Ok(found) => result = Some(found),
                    Err(error) => errors.push(error),
                }
            }
        }
        if result.is_none() && lrclib.unwrap_or(true) {
            match lrclib_lookup(&title, &artist, &album, duration.unwrap_or(0), &language) {
                Ok(found) => result = Some(found),
                Err(error) => errors.push(error),
            }
        }
        let mut result = result
            .ok_or_else(|| format!("No lyrics or subtitles found ({})", errors.join("; ")))?;
        if save_local.unwrap_or(false) {
            save(&app, &mut result, &artist, &title, media_path.as_deref())?;
        }
        Ok(result)
    })
    .await
    .map_err(|error| format!("lyrics worker: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::{json3_to_lrc, safe_name};

    #[test]
    fn json3_captions_become_synchronized_lrc() {
        let source =
            r#"{"events":[{"tStartMs":1234,"segs":[{"utf8":"Hello "},{"utf8":"world"}]}]}"#;
        assert_eq!(
            json3_to_lrc(source).as_deref(),
            Some("[00:01.23] Hello world")
        );
    }

    #[test]
    fn filenames_cannot_escape_the_app_directory() {
        assert_eq!(safe_name("../Artist: Song?"), "Artist_ Song");
    }
}
