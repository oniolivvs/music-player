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

/// "Absent" and "unreadable" MUST NOT look alike. They used to: any IO error
/// (antivirus sharing violation, OneDrive placeholder, EIO, a lock held by a
/// second instance) was reported as an empty string, i.e. "you have no library
/// yet". The frontend then came up blank, adopted the `yt:` paths out of the
/// playlists to fill it, and saved that over the real file — losing the whole
/// local library to a single unlucky launch. A real failure now surfaces as
/// `Err` so the caller can refuse to save over what it could not read.
/// A truncated/corrupt primary falls back to the `.bak` written by `store_save`.
/// async + spawn_blocking: this reads (and the twin below writes) multi-megabyte
/// JSON. As a SYNC command it ran on Tauri's main thread — saveLibrary() fires
/// after every completed download, so a large library froze the UI on each one.
#[tauri::command]
pub async fn store_load(app: AppHandle, key: String) -> Result<String, String> {
    let path = key_path(&app, &key)?;
    tauri::async_runtime::spawn_blocking(move || store_load_blocking(path, key))
        .await
        .map_err(|e| e.to_string())?
}

fn store_load_blocking(path: PathBuf, key: String) -> Result<String, String> {
    let primary = match fs::read_to_string(&path) {
        Ok(s) => {
            if s.trim().is_empty() {
                return Ok(String::new()); // written empty on purpose = "cleared"
            }
            if serde_json::from_str::<serde::de::IgnoredAny>(&s).is_ok() {
                return Ok(s);
            }
            Err(format!("{key}.json is not valid JSON"))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(String::new()),
        Err(e) => Err(format!("cannot read {key}: {e}")),
    };
    // Primary is missing-but-present, corrupt, or unreadable — try the backup.
    let bak = path.with_extension("json.bak");
    if let Ok(s) = fs::read_to_string(&bak) {
        if !s.trim().is_empty() && serde_json::from_str::<serde::de::IgnoredAny>(&s).is_ok() {
            return Ok(s);
        }
    }
    primary
}

#[tauri::command]
pub async fn store_save(app: AppHandle, key: String, data: String) -> Result<(), String> {
    let path = key_path(&app, &key)?;
    tauri::async_runtime::spawn_blocking(move || store_save_blocking(path, data))
        .await
        .map_err(|e| e.to_string())?
}

fn store_save_blocking(path: PathBuf, data: String) -> Result<(), String> {
    // An empty payload is the documented way callers CLEAR a key (store_load
    // maps an empty file back to ""). It used to fail JSON validation and be
    // swallowed by the frontend's catch, so "forget my playback position" left
    // the old value on disk and it came back at the next launch.
    if !data.is_empty() {
        // IgnoredAny validates the JSON without materializing a whole serde_json
        // Value for a multi-megabyte document.
        serde_json::from_str::<serde::de::IgnoredAny>(&data)
            .map_err(|e| format!("invalid JSON: {e}"))?;
    }
    // Unique temp per write: two concurrent saves of the SAME key (debounced
    // settings + playback save) must not interleave on one shared .tmp —
    // write A/write B/rename A/rename B leaves a hybrid or an ENOENT.
    static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let tmp = path.with_extension(format!(
        "json.{}.{}.tmp",
        std::process::id(),
        N.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    // rename() is atomic, but without sync_all() a power cut can make the RENAME
    // durable while the DATA is not — leaving a zero-length library.json that
    // reads back as "no library". Flush before swapping, and keep the previous
    // good file as .bak so store_load has something to fall back to.
    {
        use std::io::Write;
        let mut f = fs::File::create(&tmp).map_err(|e| e.to_string())?;
        f.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
        f.sync_all().map_err(|e| e.to_string())?;
    }
    if path.exists() {
        let _ = fs::rename(&path, path.with_extension("json.bak"));
    }
    if let Err(e) = fs::rename(&tmp, &path) {
        let _ = fs::remove_file(&tmp); // never leave orphaned .tmp files behind
        return Err(e.to_string());
    }
    Ok(())
}
