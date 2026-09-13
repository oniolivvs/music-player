use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

const MAX_BACKUP_BYTES: u64 = 16 * 1024 * 1024;

fn validate_path(path: &Path) -> Result<(), String> {
    let is_json = path
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case("json"));
    if !is_json {
        return Err("backup file must use the .json extension".into());
    }
    Ok(())
}

fn write_backup(path: PathBuf, data: String) -> Result<(), String> {
    validate_path(&path)?;
    if data.len() as u64 > MAX_BACKUP_BYTES {
        return Err("backup is larger than 16 MB".into());
    }
    serde_json::from_str::<serde::de::IgnoredAny>(&data)
        .map_err(|error| format!("invalid backup JSON: {error}"))?;
    let parent = path
        .parent()
        .ok_or("backup destination has no parent folder")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temp = path.with_extension(format!("json.{}.tmp", std::process::id()));
    {
        let mut file = fs::File::create(&temp).map_err(|error| error.to_string())?;
        file.write_all(data.as_bytes())
            .map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
    }
    let previous = path.with_extension("json.bak");
    if path.exists() {
        let _ = fs::remove_file(&previous);
        fs::rename(&path, &previous).map_err(|error| error.to_string())?;
    }
    match fs::rename(&temp, &path) {
        Ok(()) => {
            let _ = fs::remove_file(previous);
            Ok(())
        }
        Err(error) => {
            let _ = fs::remove_file(&temp);
            if previous.exists() {
                let _ = fs::rename(previous, &path);
            }
            Err(error.to_string())
        }
    }
}

fn read_backup(path: PathBuf) -> Result<String, String> {
    validate_path(&path)?;
    let size = fs::metadata(&path)
        .map_err(|error| error.to_string())?
        .len();
    if size > MAX_BACKUP_BYTES {
        return Err("backup is larger than 16 MB".into());
    }
    fs::read_to_string(path).map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn backup_export(path: String, data: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || write_backup(PathBuf::from(path), data))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn backup_import(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || read_backup(PathBuf::from(path)))
        .await
        .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backup_round_trip_and_extension_guard() {
        let dir =
            std::env::temp_dir().join(format!("music-player-transfer-{}", std::process::id()));
        let path = dir.join("backup.json");
        write_backup(path.clone(), "{\"kind\":\"music-player-backup\"}".into()).unwrap();
        assert_eq!(
            read_backup(path).unwrap(),
            "{\"kind\":\"music-player-backup\"}"
        );
        let path = dir.join("overwrite.json");
        write_backup(path.clone(), "{\"version\":1}".into()).unwrap();
        write_backup(path.clone(), "{\"version\":2}".into()).unwrap();
        assert_eq!(read_backup(path).unwrap(), "{\"version\":2}");
        assert!(write_backup(dir.join("backup.txt"), "{}".into()).is_err());
        let _ = fs::remove_dir_all(dir);
    }
}
