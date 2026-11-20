//! Generic JSON key/value store: one `<key>.json` file per key in the app data
//! dir. Backs playlists, the library cache, and settings. Writes are validated
//! as JSON and atomic (temp file + rename) so a crash can't corrupt a file.

use std::fs;
use std::path::{Path, PathBuf};
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
        // Only "never saved" when there is no backup either: a missing primary next
        // to a backup is an interrupted save, not an empty library.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(format!("cannot read {key}: {e}")),
    };
    // Primary is missing, corrupt, or unreadable — try the backup.
    let bak = path.with_extension("json.bak");
    match fs::read_to_string(&bak) {
        Ok(s) if s.trim().is_empty() => primary,
        Ok(s) if serde_json::from_str::<serde::de::IgnoredAny>(&s).is_ok() => Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => primary,
        // Something is there and cannot be used: reporting "never saved" would let
        // the frontend rebuild an empty library and save it over the real one.
        _ => primary.and(Err(format!("{key}.json is missing and its backup is unreadable"))),
    }
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
    swap_in(&tmp, &path).map_err(|e| {
        let _ = fs::remove_file(&tmp); // never leave orphaned .tmp files behind
        e.to_string()
    })
}

/// Copied, not moved: the primary must exist until its replacement is in place.
/// Moving it first left no library.json at all whenever the rename then failed.
fn swap_in(tmp: &Path, path: &Path) -> std::io::Result<()> {
    if path.exists() {
        let _ = fs::copy(path, path.with_extension("json.bak"));
    }
    rename_retrying(tmp, path)
}

#[cfg(not(test))]
const RENAME_ATTEMPTS: u32 = 8; // about 5 s in all
#[cfg(test)]
const RENAME_ATTEMPTS: u32 = 5; // about 0.6 s in all

/// Antivirus and indexer scans hold a freshly written file for a moment, and Windows
/// refuses the rename until they let go (access denied, sharing or lock violation).
pub(crate) fn rename_retrying(from: &Path, to: &Path) -> std::io::Result<()> {
    let mut wait = std::time::Duration::from_millis(20);
    for _ in 0..RENAME_ATTEMPTS {
        match fs::rename(from, to) {
            Err(e) if matches!(e.raw_os_error(), Some(5 | 32 | 33)) => std::thread::sleep(wait),
            other => return other,
        }
        wait *= 2;
    }
    fs::rename(from, to)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::windows::fs::OpenOptionsExt;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mp-store-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir.join("library.json")
    }

    #[test]
    fn a_save_outlasts_a_scanner_holding_the_file() {
        let path = scratch("held");
        fs::write(&path, "[1]").unwrap();
        // Share mode 0: exactly what makes Windows refuse a rename over this file.
        let held = fs::OpenOptions::new().read(true).share_mode(0).open(&path).unwrap();
        let release = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(150));
            drop(held);
        });
        store_save_blocking(path.clone(), "[2]".into()).unwrap();
        release.join().unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "[2]");
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn a_failed_save_keeps_the_previous_data() {
        let path = scratch("failed");
        fs::write(&path, "[1]").unwrap();
        // The scanner holds the new file past every retry.
        let tmp = path.with_extension("json.tmp");
        fs::write(&tmp, "[2]").unwrap();
        let held = fs::OpenOptions::new().read(true).share_mode(0).open(&tmp).unwrap();
        assert!(swap_in(&tmp, &path).is_err());
        drop(held);
        assert_eq!(fs::read_to_string(&path).unwrap(), "[1]");
        assert_eq!(fs::read_to_string(path.with_extension("json.bak")).unwrap(), "[1]");
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn a_missing_primary_falls_back_to_the_backup() {
        let path = scratch("backup");
        fs::write(path.with_extension("json.bak"), "[1]").unwrap();
        assert_eq!(store_load_blocking(path.clone(), "library".into()).unwrap(), "[1]");
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn an_unusable_backup_is_a_failure_not_an_empty_library() {
        let path = scratch("corrupt");
        fs::write(path.with_extension("json.bak"), "[1").unwrap();
        assert!(store_load_blocking(path.clone(), "library".into()).is_err());
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn nothing_saved_yet_reads_as_empty() {
        let path = scratch("empty");
        assert_eq!(store_load_blocking(path.clone(), "library".into()).unwrap(), "");
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }
}
