use serde::{Deserialize, Serialize};
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
#[cfg(test)]
use std::path::Path;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

const CURRENT_LOG: &str = "music-player.log";
const DEFAULT_MAX_BYTES: u64 = 5 * 1024 * 1024;
const DEFAULT_GENERATIONS: usize = 3;
const MAX_DETAIL_CHARS: usize = 4_000;
const MAX_NAME_CHARS: usize = 64;
const MAX_TAIL: usize = 200;

static GLOBAL: OnceLock<Diagnostics> = OnceLock::new();

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct DiagnosticEvent {
    pub ts_ms: u128,
    pub session: String,
    pub level: String,
    pub component: String,
    pub event: String,
    pub detail: String,
}

pub struct Diagnostics {
    dir: PathBuf,
    session: String,
    max_bytes: u64,
    generations: usize,
    lock: Mutex<()>,
}

impl Diagnostics {
    pub fn new(
        dir: PathBuf,
        session: String,
        max_bytes: u64,
        generations: usize,
    ) -> Result<Self, String> {
        fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
        Ok(Self {
            dir,
            session: bounded(&session, MAX_NAME_CHARS),
            max_bytes: max_bytes.max(1),
            generations,
            lock: Mutex::new(()),
        })
    }

    pub fn record(
        &self,
        level: &str,
        component: &str,
        event: &str,
        detail: &str,
    ) -> Result<(), String> {
        let _guard = self.lock.lock().map_err(|_| "diagnostic lock poisoned")?;
        let value = DiagnosticEvent {
            ts_ms: unix_ms(),
            session: self.session.clone(),
            level: normalize_level(level).into(),
            component: bounded(component, MAX_NAME_CHARS),
            event: bounded(event, MAX_NAME_CHARS),
            detail: bounded(&redact_secrets(detail), MAX_DETAIL_CHARS),
        };
        let mut line = serde_json::to_vec(&value).map_err(|error| error.to_string())?;
        line.push(b'\n');
        self.rotate_before(line.len() as u64)?;
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.current_path())
            .map_err(|error| error.to_string())?;
        file.write_all(&line).map_err(|error| error.to_string())
    }

    pub fn tail(&self, limit: usize) -> Result<Vec<DiagnosticEvent>, String> {
        let _guard = self.lock.lock().map_err(|_| "diagnostic lock poisoned")?;
        let mut events = self.read_events_unlocked()?;
        let keep = limit.min(MAX_TAIL);
        if keep == 0 {
            return Ok(Vec::new());
        }
        if events.len() > keep {
            events.drain(..events.len() - keep);
        }
        Ok(events)
    }

    pub fn export(&self) -> Result<PathBuf, String> {
        let _guard = self.lock.lock().map_err(|_| "diagnostic lock poisoned")?;
        let export_dir = self.dir.join("exports");
        fs::create_dir_all(&export_dir).map_err(|error| error.to_string())?;
        let path = export_dir.join(format!("music-player-diagnostics-{}.jsonl", unix_ms()));
        let roots = home_roots();
        let mut file = File::create(&path).map_err(|error| error.to_string())?;
        for mut event in self.read_events_unlocked()? {
            event.session = "<session>".into();
            event.detail = redact_export(
                &event.detail,
                &roots.iter().map(String::as_str).collect::<Vec<_>>(),
            );
            serde_json::to_writer(&mut file, &event).map_err(|error| error.to_string())?;
            file.write_all(b"\n").map_err(|error| error.to_string())?;
        }
        Ok(path)
    }

    pub fn clear(&self) -> Result<(), String> {
        let _guard = self.lock.lock().map_err(|_| "diagnostic lock poisoned")?;
        for path in self.all_log_paths() {
            match fs::remove_file(path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.to_string()),
            }
        }
        Ok(())
    }

    fn rotate_before(&self, incoming_bytes: u64) -> Result<(), String> {
        let current = self.current_path();
        let current_bytes = fs::metadata(&current).map(|m| m.len()).unwrap_or(0);
        if current_bytes == 0 || current_bytes.saturating_add(incoming_bytes) <= self.max_bytes {
            return Ok(());
        }
        if self.generations == 0 {
            fs::remove_file(&current).map_err(|error| error.to_string())?;
            return Ok(());
        }
        let oldest = self.rotated_path(self.generations);
        if oldest.exists() {
            fs::remove_file(&oldest).map_err(|error| error.to_string())?;
        }
        for index in (2..=self.generations).rev() {
            let source = self.rotated_path(index - 1);
            if source.exists() {
                fs::rename(source, self.rotated_path(index)).map_err(|error| error.to_string())?;
            }
        }
        fs::rename(current, self.rotated_path(1)).map_err(|error| error.to_string())
    }

    fn read_events_unlocked(&self) -> Result<Vec<DiagnosticEvent>, String> {
        let mut events = Vec::new();
        for path in self.log_paths() {
            let file = File::open(path).map_err(|error| error.to_string())?;
            for line in BufReader::new(file).lines().map_while(Result::ok) {
                if let Ok(event) = serde_json::from_str::<DiagnosticEvent>(&line) {
                    events.push(event);
                }
            }
        }
        Ok(events)
    }

    fn current_path(&self) -> PathBuf {
        self.dir.join(CURRENT_LOG)
    }

    fn rotated_path(&self, index: usize) -> PathBuf {
        self.dir.join(format!("{CURRENT_LOG}.{index}"))
    }

    fn all_log_paths(&self) -> Vec<PathBuf> {
        let mut paths = vec![self.current_path()];
        paths.extend((1..=self.generations).map(|index| self.rotated_path(index)));
        paths
    }

    fn log_paths(&self) -> Vec<PathBuf> {
        let mut paths = (1..=self.generations)
            .rev()
            .map(|index| self.rotated_path(index))
            .filter(|path| path.exists())
            .collect::<Vec<_>>();
        if self.current_path().exists() {
            paths.push(self.current_path());
        }
        paths
    }

    #[cfg(test)]
    fn dir(&self) -> &Path {
        &self.dir
    }
}

pub fn init(dir: PathBuf) -> Result<(), String> {
    let session = format!("{}-{}", unix_ms(), std::process::id());
    let store = Diagnostics::new(dir, session, DEFAULT_MAX_BYTES, DEFAULT_GENERATIONS)?;
    GLOBAL
        .set(store)
        .map_err(|_| "diagnostics already initialized".to_string())
}

pub fn record(level: &str, component: &str, event: &str, detail: &str) -> Result<(), String> {
    GLOBAL
        .get()
        .ok_or_else(|| "diagnostics unavailable".to_string())?
        .record(level, component, event, detail)
}

#[tauri::command]
pub fn diag_write(
    level: String,
    component: String,
    event: String,
    detail: String,
) -> Result<(), String> {
    record(&level, &component, &event, &detail)
}

#[tauri::command]
pub fn diag_tail(limit: usize) -> Result<Vec<DiagnosticEvent>, String> {
    GLOBAL
        .get()
        .ok_or_else(|| "diagnostics unavailable".to_string())?
        .tail(limit)
}

#[tauri::command]
pub fn diag_export() -> Result<String, String> {
    GLOBAL
        .get()
        .ok_or_else(|| "diagnostics unavailable".to_string())?
        .export()
        .map(|path| path.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn diag_clear() -> Result<(), String> {
    GLOBAL
        .get()
        .ok_or_else(|| "diagnostics unavailable".to_string())?
        .clear()
}

fn unix_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

fn normalize_level(level: &str) -> &'static str {
    match level.to_ascii_lowercase().as_str() {
        "debug" => "debug",
        "warn" => "warn",
        "error" => "error",
        _ => "info",
    }
}

fn bounded(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

fn redact_secrets(value: &str) -> String {
    const KEYS: [&str; 14] = [
        "access_token",
        "refresh_token",
        "authorization",
        "oauth",
        "signature",
        "cookie",
        "token",
        "lsig",
        "sig",
        "key",
        "expire",
        "expires",
        "ip",
        "password",
    ];
    let mut result = value.to_string();
    for key in KEYS {
        result = redact_key_values(&result, key);
    }
    redact_bearer(&result)
}

fn redact_key_values(value: &str, key: &str) -> String {
    let lower = value.to_ascii_lowercase();
    let needle = format!("{}=", key.to_ascii_lowercase());
    let mut output = String::with_capacity(value.len());
    let mut cursor = 0;
    while let Some(relative) = lower[cursor..].find(&needle) {
        let start = cursor + relative;
        let boundary_ok = start == 0
            || !lower.as_bytes()[start - 1].is_ascii_alphanumeric()
                && lower.as_bytes()[start - 1] != b'_';
        if !boundary_ok {
            output.push_str(&value[cursor..start + needle.len()]);
            cursor = start + needle.len();
            continue;
        }
        let value_start = start + needle.len();
        output.push_str(&value[cursor..value_start]);
        output.push_str("[redacted]");
        let mut end = value.len();
        for (offset, ch) in value[value_start..].char_indices() {
            if ch == '&' || ch.is_whitespace() || matches!(ch, '"' | '\'' | ';' | ',' | ']' | ')') {
                end = value_start + offset;
                break;
            }
        }
        cursor = end;
    }
    output.push_str(&value[cursor..]);
    output
}

fn redact_bearer(value: &str) -> String {
    let lower = value.to_ascii_lowercase();
    let mut output = String::with_capacity(value.len());
    let mut cursor = 0;
    while let Some(relative) = lower[cursor..].find("bearer ") {
        let start = cursor + relative;
        let token_start = start + "bearer ".len();
        output.push_str(&value[cursor..token_start]);
        output.push_str("[redacted]");
        let end = value[token_start..]
            .char_indices()
            .find(|(_, ch)| ch.is_whitespace() || matches!(ch, '"' | '\'' | ';' | ',' | ']' | ')'))
            .map(|(offset, _)| token_start + offset)
            .unwrap_or(value.len());
        cursor = end;
    }
    output.push_str(&value[cursor..]);
    output
}

fn redact_export(value: &str, roots: &[&str]) -> String {
    roots
        .iter()
        .filter(|root| !root.is_empty())
        .fold(value.to_string(), |text, root| {
            replace_case_insensitive(&text, root, "<home>")
        })
}

fn replace_case_insensitive(value: &str, needle: &str, replacement: &str) -> String {
    let lower = value.to_ascii_lowercase();
    let needle = needle.to_ascii_lowercase();
    let mut output = String::with_capacity(value.len());
    let mut cursor = 0;
    while let Some(relative) = lower[cursor..].find(&needle) {
        let start = cursor + relative;
        output.push_str(&value[cursor..start]);
        output.push_str(replacement);
        cursor = start + needle.len();
    }
    output.push_str(&value[cursor..]);
    output
}

fn home_roots() -> Vec<String> {
    let mut roots = Vec::new();
    for name in ["USERPROFILE", "HOME"] {
        if let Ok(value) = std::env::var(name) {
            if !value.is_empty() && !roots.contains(&value) {
                roots.push(value);
            }
        }
    }
    roots.push("/storage/emulated/0".into());
    roots
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(label: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "music-player-diagnostics-{label}-{}-{unique}",
            std::process::id()
        ))
    }

    fn test_store(max_bytes: u64, generations: usize) -> Diagnostics {
        Diagnostics::new(
            temp_dir("store"),
            "test-session".into(),
            max_bytes,
            generations,
        )
        .unwrap()
    }

    fn append_raw(store: &Diagnostics, value: &str) {
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(store.current_path())
            .unwrap();
        file.write_all(value.as_bytes()).unwrap();
    }

    #[test]
    fn secrets_are_removed_before_local_persistence() {
        let got = redact_secrets("https://x.test/a?token=abc&sig=xyz cookie=SID=secret");
        assert!(!got.contains("abc"));
        assert!(!got.contains("xyz"));
        assert!(!got.contains("secret"));
        assert!(got.contains("[redacted]"));
    }

    #[test]
    fn export_hides_windows_linux_and_android_user_paths() {
        let got = redact_export(
            r#"C:\Users\alice\Music /home/bob/Music /storage/emulated/0/Music"#,
            &[r#"C:\Users\alice"#, "/home/bob", "/storage/emulated/0"],
        );
        assert_eq!(got, r#"<home>\Music <home>/Music <home>/Music"#);
    }

    #[test]
    fn rotation_keeps_the_new_entry_and_bounds_every_generation() {
        let store = test_store(180, 3);
        for n in 0..20 {
            store
                .record("info", "test", "line", &format!("event-{n:02}"))
                .unwrap();
        }
        assert!(store
            .tail(100)
            .unwrap()
            .iter()
            .any(|event| event.detail == "event-19"));
        for path in store.log_paths() {
            assert!(std::fs::metadata(path).unwrap().len() <= 360);
        }
        std::fs::remove_dir_all(store.dir()).unwrap();
    }

    #[test]
    fn tail_is_bounded_and_skips_a_truncated_json_line() {
        let store = test_store(4096, 3);
        store.record("info", "test", "one", "first").unwrap();
        append_raw(&store, "{broken\n");
        store.record("warn", "test", "two", "second").unwrap();
        let got = store.tail(1).unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].detail, "second");
        std::fs::remove_dir_all(store.dir()).unwrap();
    }
}
