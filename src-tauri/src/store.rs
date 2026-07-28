//! Generic JSON key/value store: one `<key>.json` file per key in the app data
//! dir. Backs playlists, the library cache, and settings. Writes are validated
//! as JSON and atomic (temp file + rename) so a crash can't corrupt a file.

use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

fn safe_key(key: &str) -> Result<&str, String> {
    let ok = !key.is_empty()
        && key.len() <= 40
        && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    if ok { Ok(key) } else { Err("invalid store key".into()) }
}

fn key_path(app: &AppHandle, key: &str) -> Result<PathBuf, String> {
    let key = safe_key(key)?;
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(format!("{key}.json")))
}

#[tauri::command]
pub fn store_load(app: AppHandle, key: String) -> Result<String, String> {
    let path = key_path(&app, &key)?;
    match fs::read_to_string(&path) {
        Ok(s) if !s.trim().is_empty() => Ok(s),
        _ => Ok(String::new()), // absent/empty → caller uses its default
    }
}

#[tauri::command]
pub fn store_save(app: AppHandle, key: String, data: String) -> Result<(), String> {
    serde_json::from_str::<serde_json::Value>(&data).map_err(|e| format!("invalid JSON: {e}"))?;
    let path = key_path(&app, &key)?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, data.as_bytes()).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(())
}
