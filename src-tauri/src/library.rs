//! Filesystem music library: recursive scan + best-effort tag reading.
//! Returns plain `Track` structs — no coupling to audio or UI.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashSet};
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
    tauri::async_runtime::spawn_blocking(move || {
        let tagged = read_from_path(&path).ok()?;
        let tag = tagged.primary_tag().or_else(|| tagged.first_tag())?;
        let pic = tag.pictures().first()?;
        let mime = pic.mime_type().map(|m| m.as_str()).unwrap_or("image/jpeg");
        cover_data_url(pic.data(), mime).ok()
    })
    .await
    .ok()
    .flatten()
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

#[derive(Clone, Debug, Serialize)]
pub struct DuplicateFileGroup {
    pub paths: Vec<String>,
    pub bytes: u64,
}

#[derive(Debug, Deserialize)]
pub struct DuplicateDeletion {
    pub keep: String,
    pub remove: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct DuplicateDeleteResult {
    pub path: String,
    pub deleted: bool,
    pub error: Option<String>,
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

struct DuplicateRoot {
    path: String,
    dir: cap_std::fs::Dir,
}

struct DuplicateCandidate {
    path: String,
    root_path: String,
    bytes: u64,
}

/// A short-lived handle used only while hashing or comparing one candidate.
/// Candidate metadata intentionally owns no file handle: a library with many
/// unique-size tracks otherwise exhausts the process descriptor limit before
/// hashing can discard them.
struct OpenedDuplicateFile {
    file: cap_std::fs::File,
}

#[cfg(test)]
static DUPLICATE_OPEN_HANDLES: std::sync::atomic::AtomicUsize =
    std::sync::atomic::AtomicUsize::new(0);
#[cfg(test)]
static DUPLICATE_OPEN_HANDLE_PEAK: std::sync::atomic::AtomicUsize =
    std::sync::atomic::AtomicUsize::new(0);

impl OpenedDuplicateFile {
    fn new(file: cap_std::fs::File) -> Self {
        #[cfg(test)]
        {
            use std::sync::atomic::Ordering;

            let current = DUPLICATE_OPEN_HANDLES.fetch_add(1, Ordering::SeqCst) + 1;
            DUPLICATE_OPEN_HANDLE_PEAK.fetch_max(current, Ordering::SeqCst);
        }
        Self { file }
    }
}

impl Drop for OpenedDuplicateFile {
    fn drop(&mut self) {
        #[cfg(test)]
        DUPLICATE_OPEN_HANDLES.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
    }
}

#[cfg(test)]
fn reset_duplicate_open_handle_stats() {
    use std::sync::atomic::Ordering;

    DUPLICATE_OPEN_HANDLES.store(0, Ordering::SeqCst);
    DUPLICATE_OPEN_HANDLE_PEAK.store(0, Ordering::SeqCst);
}

#[cfg(test)]
fn duplicate_open_handle_stats() -> (usize, usize) {
    use std::sync::atomic::Ordering;

    (
        DUPLICATE_OPEN_HANDLES.load(Ordering::SeqCst),
        DUPLICATE_OPEN_HANDLE_PEAK.load(Ordering::SeqCst),
    )
}

/// A regular media file reached from a managed root without following a single
/// user-controlled component. `parent` remains open until unlink so a later
/// path rewrite cannot move deletion outside the directory capability.
struct ManagedFile {
    parent: cap_std::fs::Dir,
    basename: std::ffi::OsString,
    file: cap_std::fs::File,
    metadata: cap_std::fs::Metadata,
}

fn open_capability_component(
    dir: &cap_std::fs::Dir,
    component: &std::path::Path,
    maybe_dir: bool,
) -> Result<cap_std::fs::File, String> {
    use cap_fs_ext::{FollowSymlinks, OpenOptionsFollowExt, OpenOptionsMaybeDirExt};

    let mut options = cap_std::fs::OpenOptions::new();
    options
        .read(true)
        .follow(FollowSymlinks::No)
        .maybe_dir(maybe_dir);
    dir.open_with(component, &options)
        .map_err(|error| error.to_string())
}

fn open_duplicate_root(path: String) -> Result<DuplicateRoot, String> {
    use cap_std::ambient_authority;
    use cap_std::fs::Dir;

    let root = std::path::Path::new(&path);
    if !root.is_absolute() {
        return Err("duplicate scan root must be absolute".into());
    }

    // Ambient authority is used only for the filesystem anchor (for example
    // `/`, `C:\\`, or a UNC share root). Every user-mutable component below
    // that anchor is then opened relative to the preceding held directory
    // handle with symlink/reparse-point following disabled.
    let mut anchor = std::path::PathBuf::new();
    let mut names = Vec::new();
    for component in root.components() {
        match component {
            std::path::Component::Prefix(prefix) => anchor.push(prefix.as_os_str()),
            std::path::Component::RootDir if names.is_empty() => {
                anchor.push(component.as_os_str())
            }
            std::path::Component::Normal(name) => names.push(name.to_owned()),
            _ => return Err("duplicate scan root contains an unsafe path component".into()),
        }
    }
    if anchor.as_os_str().is_empty() {
        return Err("duplicate scan root has no filesystem anchor".into());
    }

    let mut dir = Dir::open_ambient_dir(&anchor, ambient_authority())
        .map_err(|error| error.to_string())?;
    for name in names {
        let opened = open_capability_component(&dir, std::path::Path::new(&name), true)?;
        let metadata = opened.metadata().map_err(|error| error.to_string())?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err("duplicate scan root traverses a symlink or non-directory".into());
        }
        dir = Dir::from_std_file(opened.into_std());
    }
    if !dir
        .dir_metadata()
        .map_err(|error| error.to_string())?
        .is_dir()
    {
        return Err("duplicate scan root is not a regular directory".into());
    }
    Ok(DuplicateRoot { path, dir })
}

fn managed_root_for_path(path: &std::path::Path) -> Result<(DuplicateRoot, std::path::PathBuf), String> {
    if !path.is_absolute() {
        return Err("managed file path must be absolute".into());
    }
    let mut roots = match MANAGED_ROOTS.lock() {
        Ok(roots) => roots.clone(),
        Err(error) => error.into_inner().clone(),
    };
    // A nested registered source wins so its held capability is as narrow as
    // possible. Do not canonicalize `path`: that would follow an attacker-made
    // link before the no-follow traversal below can reject it.
    roots.sort_by_key(|root| std::cmp::Reverse(root.len()));
    for root_path in roots {
        let root = std::path::Path::new(&root_path);
        let Ok(relative) = path.strip_prefix(root) else {
            continue;
        };
        if relative.as_os_str().is_empty() {
            continue;
        }
        return Ok((open_duplicate_root(root_path)?, relative.to_path_buf()));
    }
    Err("refusing to delete a file outside your music folders".into())
}

fn open_managed_file(path: &str) -> Result<ManagedFile, String> {
    let path = std::path::Path::new(path);
    let (root, relative) = managed_root_for_path(path)?;
    let extension = relative
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or("")
        .to_lowercase();
    if !AUDIO_EXTS.contains(&extension.as_str()) {
        return Err(format!("refusing to delete a non-media file (.{extension})"));
    }

    let mut components = relative.components().peekable();
    let mut parent = root.dir.try_clone().map_err(|error| error.to_string())?;
    let mut basename = None;
    while let Some(component) = components.next() {
        let name = match component {
            std::path::Component::Normal(name) => name,
            _ => return Err("managed file contains an unsafe path component".into()),
        };
        if components.peek().is_none() {
            basename = Some(name.to_owned());
            break;
        }
        let opened = open_capability_component(&parent, std::path::Path::new(name), true)?;
        let metadata = opened.metadata().map_err(|error| error.to_string())?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err("managed file traverses a symlink or non-directory".into());
        }
        parent = cap_std::fs::Dir::from_std_file(opened.into_std());
    }

    let basename = basename.ok_or_else(|| "managed file must be below its root".to_string())?;
    let file = open_capability_component(&parent, std::path::Path::new(&basename), false)?;
    let metadata = file.metadata().map_err(|error| error.to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("managed file is a symlink or non-regular file".into());
    }
    Ok(ManagedFile { parent, basename, file, metadata })
}

fn same_capability_file(first: &cap_std::fs::Metadata, second: &cap_std::fs::Metadata) -> bool {
    use cap_fs_ext::MetadataExt as _;

    first.dev() == second.dev() && first.ino() == second.ino()
}

fn unlink_managed_file(opened: ManagedFile) -> Result<(), String> {
    ensure_managed_file_is_current(&opened)?;
    // Closing the file is required on Windows before unlink, but the parent
    // capability remains held and the basename is never re-resolved globally.
    drop(opened.file);
    opened
        .parent
        .remove_file(&opened.basename)
        .map_err(|error| error.to_string())
}

fn ensure_managed_file_is_current(opened: &ManagedFile) -> Result<(), String> {
    let current = opened
        .parent
        .symlink_metadata(&opened.basename)
        .map_err(|error| error.to_string())?;
    if current.file_type().is_symlink() || !current.is_file() {
        return Err("managed file changed before deletion".into());
    }
    if !same_capability_file(&opened.metadata, &current) {
        return Err("managed file changed before deletion".into());
    }
    Ok(())
}

/// Revalidate every planned pair immediately before unlinking. Discovery can
/// run minutes before confirmation, so neither its path strings nor its hashes
/// are authority to delete a file now.
fn confirm_duplicate_deletions(
    deletions: Vec<DuplicateDeletion>,
) -> Result<Vec<DuplicateDeleteResult>, String> {
    let mut results = Vec::new();
    let mut seen_removals = BTreeSet::new();
    for deletion in deletions {
        let keeper = match open_managed_file(&deletion.keep) {
            Ok(keeper) => keeper,
            Err(error) => {
                for path in deletion.remove {
                    results.push(DuplicateDeleteResult {
                        path,
                        deleted: false,
                        error: Some(format!("duplicate keeper is unavailable: {error}")),
                    });
                }
                continue;
            }
        };
        for path in deletion.remove {
            let result = (|| -> Result<(), String> {
                if path == deletion.keep {
                    return Err("refusing to delete the duplicate keeper".into());
                }
                if !seen_removals.insert(path.clone()) {
                    return Err("duplicate removal path was requested more than once".into());
                }
                ensure_managed_file_is_current(&keeper)?;
                let removal = open_managed_file(&path)?;
                if keeper.metadata.len() != removal.metadata.len() {
                    return Err("duplicate pair changed size before deletion".into());
                }
                if sha256_file(&keeper.file)? != sha256_file(&removal.file)? {
                    return Err("duplicate pair changed content before deletion".into());
                }
                if !files_equal(&keeper.file, &removal.file)? {
                    return Err("duplicate pair is not byte-for-byte equal".into());
                }
                // Hashing can take long enough for another process to replace
                // the keeper. Recheck its held identity immediately before the
                // unlink so we never delete the last current copy on stale proof.
                ensure_managed_file_is_current(&keeper)?;
                unlink_managed_file(removal)
            })();
            match result {
                Ok(()) => results.push(DuplicateDeleteResult {
                    path,
                    deleted: true,
                    error: None,
                }),
                Err(error) => results.push(DuplicateDeleteResult {
                    path,
                    deleted: false,
                    error: Some(error),
                }),
            }
        }
    }
    Ok(results)
}

#[tauri::command]
pub async fn confirm_delete_duplicates(
    deletions: Vec<DuplicateDeletion>,
) -> Result<Vec<DuplicateDeleteResult>, String> {
    tauri::async_runtime::spawn_blocking(move || confirm_duplicate_deletions(deletions))
        .await
        .map_err(|error| error.to_string())?
}

fn open_duplicate_file(
    root: &DuplicateRoot,
    path: &std::path::Path,
) -> Result<OpenedDuplicateFile, String> {
    let relative = path
        .strip_prefix(std::path::Path::new(&root.path))
        .map_err(|_| "duplicate candidate escaped its root".to_string())?;
    let extension = relative
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or("")
        .to_lowercase();
    if !AUDIO_EXTS.contains(&extension.as_str()) {
        return Err(format!("refusing duplicate candidate with unsupported extension .{extension}"));
    }

    let mut components = relative.components().peekable();
    let mut current = root.dir.try_clone().map_err(|error| error.to_string())?;
    let mut final_component = None;
    while let Some(component) = components.next() {
        let name = match component {
            std::path::Component::Normal(name) => name,
            _ => return Err("duplicate candidate contains an unsafe path component".into()),
        };
        if components.peek().is_none() {
            final_component = Some(name.to_owned());
            break;
        }
        let opened = open_capability_component(&current, std::path::Path::new(name), true)?;
        let metadata = opened.metadata().map_err(|error| error.to_string())?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err("duplicate candidate traverses a symlink or non-directory".into());
        }
        current = cap_std::fs::Dir::from_std_file(opened.into_std());
    }

    let final_component = final_component
        .ok_or_else(|| "duplicate candidate must be below its root".to_string())?;
    let opened = open_capability_component(
        &current,
        std::path::Path::new(&final_component),
        false,
    )?;
    let metadata = opened.metadata().map_err(|error| error.to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("duplicate candidate is a symlink or non-regular file".into());
    }

    Ok(OpenedDuplicateFile::new(opened))
}

fn open_duplicate_candidate(
    root: &DuplicateRoot,
    path: &std::path::Path,
) -> Result<DuplicateCandidate, String> {
    let relative = path
        .strip_prefix(std::path::Path::new(&root.path))
        .map_err(|_| "duplicate candidate escaped its root".to_string())?;
    let opened = open_duplicate_file(root, path)?;
    let bytes = opened.file.metadata().map_err(|error| error.to_string())?.len();
    drop(opened);
    Ok(DuplicateCandidate {
        path: std::path::Path::new(&root.path)
            .join(relative)
            .to_string_lossy()
            .into_owned(),
        root_path: root.path.clone(),
        bytes,
    })
}

fn open_duplicate_candidate_file(candidate: &DuplicateCandidate) -> Result<OpenedDuplicateFile, String> {
    let root = open_duplicate_root(candidate.root_path.clone())?;
    let opened = open_duplicate_file(&root, std::path::Path::new(&candidate.path))?;
    let bytes = opened.file.metadata().map_err(|error| error.to_string())?.len();
    if bytes != candidate.bytes {
        return Err("duplicate candidate changed after scan".into());
    }
    Ok(opened)
}

fn collect_duplicate_candidates(roots: &[DuplicateRoot]) -> Result<Vec<DuplicateCandidate>, String> {
    let mut candidates = BTreeMap::new();
    for root in roots {
        for entry in WalkDir::new(&root.path).follow_links(false) {
            let entry = entry.map_err(|error| error.to_string())?;
            let extension = entry
                .path()
                .extension()
                .and_then(|extension| extension.to_str())
                .unwrap_or("")
                .to_lowercase();
            if entry.file_type().is_file() && AUDIO_EXTS.contains(&extension.as_str()) {
                let candidate = open_duplicate_candidate(root, entry.path())?;
                candidates.entry(candidate.path.clone()).or_insert(candidate);
            }
        }
    }
    Ok(candidates.into_values().collect())
}

fn sha256_file(mut file: impl Read + std::io::Seek) -> Result<[u8; 32], String> {
    use sha2::{Digest, Sha256};
    use std::io::SeekFrom;

    file.seek(SeekFrom::Start(0))
        .map_err(|error| error.to_string())?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(digest.finalize().into())
}

fn files_equal(
    mut first: impl Read + std::io::Seek,
    mut second: impl Read + std::io::Seek,
) -> Result<bool, String> {
    use std::io::SeekFrom;

    first
        .seek(SeekFrom::Start(0))
        .map_err(|error| error.to_string())?;
    second
        .seek(SeekFrom::Start(0))
        .map_err(|error| error.to_string())?;
    let mut first_buffer = [0_u8; 64 * 1024];
    let mut second_buffer = [0_u8; 64 * 1024];

    loop {
        let first_read = first
            .read(&mut first_buffer)
            .map_err(|error| error.to_string())?;
        let second_read = second
            .read(&mut second_buffer)
            .map_err(|error| error.to_string())?;
        if first_read != second_read {
            return Ok(false);
        }
        if first_buffer[..first_read] != second_buffer[..second_read] {
            return Ok(false);
        }
        if first_read == 0 {
            return Ok(true);
        }
    }
}

fn duplicate_groups(candidates: Vec<DuplicateCandidate>) -> Result<Vec<DuplicateFileGroup>, String> {
    let mut by_size: BTreeMap<u64, Vec<DuplicateCandidate>> = BTreeMap::new();
    for candidate in candidates {
        by_size.entry(candidate.bytes).or_default().push(candidate);
    }

    let mut groups = Vec::new();
    for (bytes, same_size) in by_size.into_iter().filter(|(_, paths)| paths.len() > 1) {
        let mut by_hash: BTreeMap<[u8; 32], Vec<DuplicateCandidate>> = BTreeMap::new();
        for candidate in same_size {
            let opened = open_duplicate_candidate_file(&candidate)?;
            let hash = sha256_file(&opened.file)?;
            drop(opened);
            by_hash
                .entry(hash)
                .or_default()
                .push(candidate);
        }

        for same_hash in by_hash.into_values().filter(|paths| paths.len() > 1) {
            let mut exact_groups: Vec<Vec<DuplicateCandidate>> = Vec::new();
            for candidate in same_hash {
                let opened = open_duplicate_candidate_file(&candidate)?;
                let mut matching_group = None;
                for (index, exact_group) in exact_groups.iter().enumerate() {
                    let representative = open_duplicate_candidate_file(&exact_group[0])?;
                    let equal = files_equal(&representative.file, &opened.file)?;
                    drop(representative);
                    if equal {
                        matching_group = Some(index);
                        break;
                    }
                }
                drop(opened);
                match matching_group {
                    Some(index) => exact_groups[index].push(candidate),
                    None => exact_groups.push(vec![candidate]),
                }
            }

            for exact_group in exact_groups.into_iter().filter(|paths| paths.len() > 1) {
                let mut paths: Vec<String> = exact_group
                    .into_iter()
                    .map(|candidate| candidate.path)
                    .collect();
                paths.sort();
                groups.push(DuplicateFileGroup { paths, bytes });
            }
        }
    }
    groups.sort_by(|first, second| {
        first
            .paths
            .cmp(&second.paths)
            .then(first.bytes.cmp(&second.bytes))
    });
    Ok(groups)
}

#[cfg(test)]
fn safe_duplicate_input(path: &std::path::Path, roots: &[String]) -> bool {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(_) => return false,
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return false;
    }
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or("")
        .to_lowercase();
    if !AUDIO_EXTS.contains(&extension.as_str()) {
        return false;
    }

    let canonical = canon(&path.to_string_lossy());
    roots.iter().any(|root| {
        canonical != *root
            && std::path::Path::new(&canonical).starts_with(std::path::Path::new(root))
    })
}

#[tauri::command]
pub async fn find_duplicate_files(roots: Vec<String>) -> Result<Vec<DuplicateFileGroup>, String> {
    let registered_roots = match MANAGED_ROOTS.lock() {
        Ok(roots) => roots.clone(),
        Err(error) => error.into_inner().clone(),
    };

    tauri::async_runtime::spawn_blocking(move || {
        let mut requested_roots = BTreeSet::new();
        for root in roots {
            let metadata = std::fs::symlink_metadata(&root).map_err(|error| error.to_string())?;
            if metadata.file_type().is_symlink() {
                return Err("refusing to scan a symlink root".into());
            }
            if !metadata.is_dir() {
                return Err("duplicate scan root is not a directory".into());
            }
            let canonical = canon(&root);
            if !registered_roots
                .iter()
                .any(|registered| registered == &canonical)
            {
                return Err("refusing to scan an unregistered music folder".into());
            }
            requested_roots.insert(canonical);
        }
        let requested_roots: Vec<DuplicateRoot> = requested_roots
            .into_iter()
            .map(open_duplicate_root)
            .collect::<Result<_, _>>()?;

        duplicate_groups(collect_duplicate_candidates(&requested_roots)?)
    })
    .await
    .map_err(|error| error.to_string())?
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
    tauri::async_runtime::spawn_blocking(move || {
        let opened = open_managed_file(&path)?;
        unlink_managed_file(opened)
    })
    .await
    .map_err(|error| error.to_string())?
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
const STILL_MAX_DIM: u32 = 1920;

fn resize_still(data: &[u8]) -> Result<Option<(Vec<u8>, &'static str)>, String> {
    let image = image::load_from_memory(data).map_err(|error| error.to_string())?;
    let (width, height) = (image.width(), image.height());
    if width.max(height) <= STILL_MAX_DIM && data.len() <= IMG_PASSTHROUGH_BYTES {
        return Ok(None);
    }
    let scale = STILL_MAX_DIM as f64 / width.max(height) as f64;
    let next_width = ((width as f64 * scale).round() as u32).max(1).min(width);
    let next_height = ((height as f64 * scale).round() as u32).max(1).min(height);
    let resized = image.resize(next_width, next_height, image::imageops::FilterType::Lanczos3);
    let mut output = std::io::Cursor::new(Vec::new());
    resized
        .write_to(&mut output, image::ImageFormat::Png)
        .map_err(|error| error.to_string())?;
    Ok(Some((output.into_inner(), "image/png")))
}

fn bounded_image_data_url(data: &[u8], mime: &str) -> Result<String, String> {
    if mime.eq_ignore_ascii_case("image/gif") {
        let bytes = gif_downscale(data)?.unwrap_or_else(|| data.to_vec());
        return Ok(format!("data:image/gif;base64,{}", STANDARD.encode(bytes)));
    }
    let (bytes, output_mime) = match resize_still(data)? {
        Some((bytes, mime)) => (bytes, mime),
        None => (data.to_vec(), mime),
    };
    Ok(format!("data:{output_mime};base64,{}", STANDARD.encode(bytes)))
}

fn cover_data_url(data: &[u8], mime: &str) -> Result<String, String> {
    bounded_image_data_url(data, mime)
}

fn local_image_data_url(data: &[u8], mime: &str) -> Result<String, String> {
    bounded_image_data_url(data, mime)
}

fn remote_image_data_url(data: &[u8], mime: &str) -> Result<String, String> {
    bounded_image_data_url(data, mime)
}

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
    local_image_data_url(&data, mime)
}

/// Re-encode an animated GIF small enough to be used as a live background.
///
/// Returns `Ok(None)` when the original is already within budget (passed through
/// untouched — no generation loss, no CPU). A wallpaper is drawn full-screen
/// under a heavy blur and re-composited beneath every translucent panel, and an
/// ANIMATED one pays that cost on every frame, so the dimension cap is tighter
/// than for a still: past ~960px the blur has erased the detail anyway.
const GIF_MAX_DIM: u32 = 960;
/// Reject unsafe GIF dimensions directly from the header, before frame decoding.
const GIF_SOURCE_MAX_DIM: u32 = 4096;
/// One retained composited canvas plus temporary frame buffers must remain bounded.
const GIF_MAX_DECODE_ALLOCATION: u64 = 96 * 1024 * 1024;
/// Decode and encode at most this many frames, without retaining prior frames.
const GIF_MAX_FRAMES: usize = 400;
/// Base64 data URLs live in the webview too, so cap re-encoded bytes while writing.
const GIF_OUTPUT_MAX_BYTES: usize = IMG_PASSTHROUGH_BYTES;

struct CappedGifWriter {
    bytes: Vec<u8>,
    max_bytes: usize,
}

impl CappedGifWriter {
    fn new(max_bytes: usize) -> Self {
        Self { bytes: Vec::new(), max_bytes }
    }

    fn into_bytes(self) -> Vec<u8> {
        self.bytes
    }
}

impl std::io::Write for CappedGifWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let next_len = self.bytes.len().checked_add(buf.len())
            .ok_or_else(|| std::io::Error::other("GIF output size overflow"))?;
        if next_len > self.max_bytes {
            return Err(std::io::Error::other(format!(
                "GIF output exceeds the {} byte limit", self.max_bytes
            )));
        }
        self.bytes.extend_from_slice(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn gif_decoder(data: &[u8]) -> Result<image::codecs::gif::GifDecoder<std::io::Cursor<&[u8]>>, String> {
    use image::ImageDecoder;

    let mut decoder = image::codecs::gif::GifDecoder::new(std::io::Cursor::new(data))
        .map_err(|error| error.to_string())?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(GIF_SOURCE_MAX_DIM);
    limits.max_image_height = Some(GIF_SOURCE_MAX_DIM);
    limits.max_alloc = Some(GIF_MAX_DECODE_ALLOCATION);
    decoder.set_limits(limits).map_err(|error| error.to_string())?;
    Ok(decoder)
}

fn gif_downscale(data: &[u8]) -> Result<Option<Vec<u8>>, String> {
    gif_downscale_with_limit(data, GIF_OUTPUT_MAX_BYTES)
}

fn gif_downscale_with_limit(data: &[u8], output_limit: usize) -> Result<Option<Vec<u8>>, String> {
    use image::codecs::gif::{GifEncoder, Repeat};
    use image::{AnimationDecoder, ImageDecoder};

    let decoder = gif_decoder(data)?;
    let (width, height) = decoder.dimensions();
    let oversized = width.max(height) > GIF_MAX_DIM;

    // A short first pass preserves small GIF bytes without ever retaining their
    // frames. Re-open below only when we need to encode, capping long loops.
    let mut frame_count = 0;
    for frame in decoder.into_frames().take(GIF_MAX_FRAMES) {
        frame.map_err(|error| error.to_string())?;
        frame_count += 1;
    }
    if frame_count == 0 {
        return Err("no frames".into());
    }
    if !oversized && data.len() <= IMG_PASSTHROUGH_BYTES && frame_count < GIF_MAX_FRAMES {
        return Ok(None);
    }

    let (next_width, next_height) = if !oversized {
        (width, height)
    } else if width >= height {
        (
            GIF_MAX_DIM,
            (height as u64 * GIF_MAX_DIM as u64 / width as u64).max(1) as u32,
        )
    } else {
        (
            (width as u64 * GIF_MAX_DIM as u64 / height as u64).max(1) as u32,
            GIF_MAX_DIM,
        )
    };

    let mut out = CappedGifWriter::new(output_limit);
    {
        let decoder = gif_decoder(data)?;
        // Speed 25 of 30: quantization quality is irrelevant under the blur,
        // and the slow setting took tens of seconds on a long animation.
        let mut encoder = GifEncoder::new_with_speed(&mut out, 25);
        encoder
            .set_repeat(Repeat::Infinite)
            .map_err(|error| error.to_string())?;
        for frame in decoder.into_frames().take(GIF_MAX_FRAMES) {
            let frame = frame.map_err(|error| error.to_string())?;
            let delay = frame.delay();
            // `into_frames` returns a composited full canvas. Reset the output
            // frame origin instead of applying the source delta offsets again.
            let buffer = if oversized {
                image::imageops::resize(
                    frame.buffer(),
                    next_width,
                    next_height,
                    image::imageops::FilterType::Triangle,
                )
            } else {
                frame.into_buffer()
            };
            encoder
                .encode_frame(image::Frame::from_parts(buffer, 0, 0, delay))
                .map_err(|error| error.to_string())?;
        }
    }
    Ok(Some(out.into_bytes()))
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
        remote_image_data_url(&bytes, &mime)
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
mod bounded_image_tests {
    use super::bounded_image_data_url;
    use base64::{engine::general_purpose::STANDARD, Engine as _};

    fn jpeg(width: u32, height: u32) -> Vec<u8> {
        let image = image::RgbImage::from_pixel(width, height, image::Rgb([40, 80, 160]));
        let mut out = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(image)
            .write_to(&mut out, image::ImageFormat::Jpeg)
            .unwrap();
        out.into_inner()
    }

    fn encoded(width: u32, height: u32, format: image::ImageFormat) -> Vec<u8> {
        let image = image::RgbImage::from_pixel(width, height, image::Rgb([40, 80, 160]));
        let mut out = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(image)
            .write_to(&mut out, format)
            .unwrap();
        out.into_inner()
    }

    fn decoded_size(url: &str) -> (u32, u32) {
        let encoded = url.split_once(',').unwrap().1;
        let bytes = STANDARD.decode(encoded).unwrap();
        let image = image::load_from_memory(&bytes).unwrap();
        (image.width(), image.height())
    }

    #[test]
    fn landscape_is_capped_without_changing_ratio() {
        let out = bounded_image_data_url(&jpeg(3000, 1500), "image/jpeg").unwrap();
        assert_eq!(decoded_size(&out), (1920, 960));
    }

    #[test]
    fn portrait_is_capped_without_changing_ratio() {
        let out = bounded_image_data_url(&jpeg(1000, 2000), "image/jpeg").unwrap();
        assert_eq!(decoded_size(&out), (960, 1920));
    }

    #[test]
    fn small_image_is_not_upscaled() {
        let out = bounded_image_data_url(&jpeg(320, 180), "image/jpeg").unwrap();
        assert_eq!(decoded_size(&out), (320, 180));
    }

    #[test]
    fn bmp_is_bounded() {
        let out = bounded_image_data_url(&encoded(1921, 1, image::ImageFormat::Bmp), "image/bmp")
            .unwrap();
        assert_eq!(decoded_size(&out), (1920, 1));
    }

}

#[cfg(test)]
mod image_source_tests {
    use super::{cover_data_url, local_image_data_url, remote_image_data_url};
    use base64::{engine::general_purpose::STANDARD, Engine as _};

    fn jpeg(width: u32, height: u32) -> Vec<u8> {
        let image = image::RgbImage::from_pixel(width, height, image::Rgb([40, 80, 160]));
        let mut out = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(image)
            .write_to(&mut out, image::ImageFormat::Jpeg)
            .unwrap();
        out.into_inner()
    }

    fn decoded_size(url: &str) -> (u32, u32) {
        let encoded = url.split_once(',').unwrap().1;
        let bytes = STANDARD.decode(encoded).unwrap();
        let image = image::load_from_memory(&bytes).unwrap();
        (image.width(), image.height())
    }

    #[test]
    fn every_artwork_source_caps_still_images() {
        let image = jpeg(2400, 1200);
        for out in [
            cover_data_url(&image, "image/jpeg"),
            local_image_data_url(&image, "image/jpeg"),
            remote_image_data_url(&image, "image/jpeg"),
        ] {
            assert_eq!(decoded_size(&out.unwrap()), (1920, 960));
        }
    }
}

#[cfg(test)]
mod gif_tests {
    use super::{gif_downscale, gif_downscale_with_limit, IMG_PASSTHROUGH_BYTES};
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

    // A tiny image block on a huge logical screen proves the decoder limit is
    // checked on its composited canvas, without the test fixture allocating it.
    fn sparse_canvas_gif(width: u16, height: u16) -> Vec<u8> {
        let mut out = b"GIF89a".to_vec();
        out.extend_from_slice(&width.to_le_bytes());
        out.extend_from_slice(&height.to_le_bytes());
        out.extend_from_slice(&[0x80, 0, 0]); // 2-colour global table
        out.extend_from_slice(&[0, 0, 0, 255, 255, 255]);
        out.push(0x2c); // one 1×1 image at origin
        out.extend_from_slice(&[0, 0, 0, 0, 1, 0, 1, 0, 0]);
        out.extend_from_slice(&[2, 2, 0x44, 0x01, 0, 0x3b]); // clear, pixel, end
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
    fn unsafe_gif_canvas_is_rejected_before_frame_allocation() {
        let src = make_gif(4097, 1, 1);
        assert!(gif_downscale(&src).is_err(), "unsafe source dimensions must not be decoded");
    }

    #[test]
    fn gif_decoder_rejects_a_large_composited_canvas_by_allocation_limit() {
        let src = sparse_canvas_gif(4096, 4096);
        assert!(
            gif_downscale(&src).is_err(),
            "a tiny delta frame must not bypass the retained-canvas allocation limit"
        );
    }

    #[test]
    fn gif_reencode_refuses_to_exceed_its_output_byte_ceiling() {
        let src = make_gif(1280, 720, 2);
        assert!(
            gif_downscale_with_limit(&src, 32).is_err(),
            "the encoder must stop instead of accumulating an unbounded output buffer"
        );
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

#[cfg(test)]
mod duplicate_file_tests {
    use super::{
        canon, collect_duplicate_candidates, confirm_duplicate_deletions, duplicate_groups,
        duplicate_open_handle_stats, files_equal, find_duplicate_files, open_duplicate_candidate,
        open_duplicate_file, open_duplicate_root, open_managed_file, register_root, safe_duplicate_input,
        reset_duplicate_open_handle_stats, unlink_managed_file, DuplicateDeletion,
    };
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_TEST_ID: AtomicU64 = AtomicU64::new(0);

    fn temp_dir(label: &str) -> PathBuf {
        let id = NEXT_TEST_ID.fetch_add(1, Ordering::Relaxed);
        let dir =
            std::env::temp_dir().join(format!("music-player-{label}-{}-{id}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn identical_files_group_but_same_size_different_content_does_not() {
        let dir = temp_dir("duplicate-groups");
        let first = dir.join("first.mp3");
        let copy = dir.join("copy.mp3");
        let different = dir.join("different.mp3");
        std::fs::write(&first, b"same-audio-bytes").unwrap();
        std::fs::write(&copy, b"same-audio-bytes").unwrap();
        std::fs::write(&different, b"other-audio-byte").unwrap();

        let root = open_duplicate_root(canon(&dir.to_string_lossy())).unwrap();
        let groups = duplicate_groups(vec![
            open_duplicate_candidate(&root, &first).unwrap(),
            open_duplicate_candidate(&root, &copy).unwrap(),
            open_duplicate_candidate(&root, &different).unwrap(),
        ])
        .unwrap();
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].paths.len(), 2);
        assert_eq!(groups[0].bytes, 16);
        drop(root);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn empty_input_has_no_duplicate_groups() {
        assert!(duplicate_groups(Vec::new()).unwrap().is_empty());
    }

    #[test]
    fn duplicate_scan_closes_handles_for_a_large_set_of_unique_sizes() {
        let dir = temp_dir("duplicate-bounded-handles");
        for index in 1..=320_usize {
            std::fs::write(dir.join(format!("{index}.mp3")), vec![index as u8; index]).unwrap();
        }
        let root = open_duplicate_root(canon(&dir.to_string_lossy())).unwrap();
        reset_duplicate_open_handle_stats();

        let candidates = collect_duplicate_candidates(&[root]).unwrap();
        let groups = duplicate_groups(candidates).unwrap();

        assert!(groups.is_empty(), "different sizes cannot form a duplicate group");
        assert_eq!(duplicate_open_handle_stats(), (0, 1), "unique-size candidates must not retain file descriptors");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn exact_comparison_rejects_same_size_different_content() {
        let dir = temp_dir("duplicate-byte-comparison");
        let first = dir.join("first.mp3");
        let different = dir.join("different.mp3");
        std::fs::write(&first, b"same-audio-bytes").unwrap();
        std::fs::write(&different, b"other-audio-byte").unwrap();

        let root = open_duplicate_root(canon(&dir.to_string_lossy())).unwrap();
        let first = open_duplicate_file(&root, &first).unwrap();
        let different = open_duplicate_file(&root, &different).unwrap();
        assert!(!files_equal(&first.file, &different.file).unwrap());
        drop(first);
        drop(different);
        drop(root);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn changed_candidate_is_reopened_no_follow_before_hashing() {
        let dir = temp_dir("duplicate-handle-race");
        let first = dir.join("first.mp3");
        let copy = dir.join("copy.mp3");
        let outside = dir.parent().unwrap().join(format!(
            "music-player-outside-{}-{}.mp3",
            std::process::id(),
            NEXT_TEST_ID.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::write(&first, b"same-audio-bytes").unwrap();
        std::fs::write(&copy, b"same-audio-bytes").unwrap();
        std::fs::write(&outside, b"other-audio-byte").unwrap();

        let root = open_duplicate_root(canon(&dir.to_string_lossy())).unwrap();
        let first_candidate = open_duplicate_candidate(&root, &first).unwrap();
        let copy_candidate = open_duplicate_candidate(&root, &copy).unwrap();

        let removed = std::fs::remove_file(&first).is_ok();
        assert!(removed, "candidate collection must not retain a file handle");
        if removed {
            #[cfg(unix)]
            let replaced = std::os::unix::fs::symlink(&outside, &first).is_ok();
            #[cfg(windows)]
            let replaced = std::os::windows::fs::symlink_file(&outside, &first).is_ok();
            if replaced {
                assert!(open_duplicate_candidate(&root, &first).is_err());
                assert!(duplicate_groups(vec![first_candidate, copy_candidate]).is_err());
            }
        }

        drop(root);
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_file(&outside);
    }

    #[test]
    fn root_capability_rejects_a_symlinked_ancestor() {
        let dir = temp_dir("duplicate-root-ancestor");
        let target = dir.join("target");
        let nested = target.join("music");
        let alias = dir.join("alias");
        std::fs::create_dir_all(&nested).unwrap();

        #[cfg(unix)]
        let symlink_created = std::os::unix::fs::symlink(&target, &alias).is_ok();
        #[cfg(windows)]
        let symlink_created = std::os::windows::fs::symlink_dir(&target, &alias).is_ok()
            || std::process::Command::new("cmd")
                .args(["/C", "mklink", "/J"])
                .arg(&alias)
                .arg(&target)
                .output()
                .map(|output| output.status.success())
                .unwrap_or(false);
        if symlink_created {
            assert!(open_duplicate_root(alias.join("music").to_string_lossy().into_owned()).is_err());
        }

        #[cfg(windows)]
        let _ = std::fs::remove_dir(&alias);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn production_scan_skips_non_media_and_returns_audio_duplicates() {
        let dir = temp_dir("duplicate-production-filter");
        let first = dir.join("first.mp3");
        let copy = dir.join("copy.mp3");
        std::fs::write(&first, b"same-audio-bytes").unwrap();
        std::fs::write(&copy, b"same-audio-bytes").unwrap();
        std::fs::write(dir.join("cover.jpg"), b"cover").unwrap();
        std::fs::write(dir.join("notes.txt"), b"notes").unwrap();

        let root = canon(&dir.to_string_lossy());
        register_root(&root);
        let groups = tauri::async_runtime::block_on(find_duplicate_files(vec![root])).unwrap();

        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].bytes, 16);
        assert_eq!(groups[0].paths.len(), 2);
        assert!(groups[0].paths.iter().any(|path| path.ends_with("first.mp3")));
        assert!(groups[0].paths.iter().any(|path| path.ends_with("copy.mp3")));

        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn capability_unlink_stays_inside_the_held_parent_after_ancestor_replacement() {
        let root = temp_dir("capability-unlink");
        let nested = root.join("nested");
        let parked = root.join("parked");
        let outside = temp_dir("capability-unlink-outside");
        let media = nested.join("song.mp3");
        let outside_media = outside.join("song.mp3");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(&media, b"managed-media").unwrap();
        std::fs::write(&outside_media, b"outside-media").unwrap();

        let root_path = canon(&root.to_string_lossy());
        register_root(&root_path);
        let opened = open_managed_file(&canon(&media.to_string_lossy())).unwrap();

        let ancestor_moved = std::fs::rename(&nested, &parked).is_ok();
        #[cfg(unix)]
        let ancestor_replaced = ancestor_moved
            && std::os::unix::fs::symlink(&outside, &nested).is_ok();
        #[cfg(windows)]
        let ancestor_replaced = ancestor_moved
            && (std::os::windows::fs::symlink_dir(&outside, &nested).is_ok()
                || std::process::Command::new("cmd")
                    .args(["/C", "mklink", "/J"])
                    .arg(&nested)
                    .arg(&outside)
                    .output()
                    .map(|output| output.status.success())
                    .unwrap_or(false));

        unlink_managed_file(opened).unwrap();
        assert!(outside_media.exists(), "a replacement ancestor must never redirect unlink outside the root");
        if ancestor_replaced {
            assert!(!parked.join("song.mp3").exists(), "the held parent receives the unlink");
            let _ = std::fs::remove_dir(&nested);
        } else {
            assert!(!media.exists(), "a held directory may block replacement but must still unlink its own file");
        }

        crate::library::MANAGED_ROOTS
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .retain(|managed| managed != &root_path);
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
    }

    fn managed_duplicate_pair(label: &str) -> (PathBuf, PathBuf, PathBuf, String) {
        let root = temp_dir(label);
        let keep = root.join("keep.mp3");
        let remove = root.join("remove.mp3");
        std::fs::write(&keep, b"same-audio-bytes").unwrap();
        std::fs::write(&remove, b"same-audio-bytes").unwrap();
        let root_path = canon(&root.to_string_lossy());
        register_root(&root_path);
        (root, keep, remove, root_path)
    }

    fn duplicate_delete(keep: &PathBuf, remove: &PathBuf) -> Vec<super::DuplicateDeleteResult> {
        confirm_duplicate_deletions(vec![DuplicateDeletion {
            keep: canon(&keep.to_string_lossy()),
            remove: vec![canon(&remove.to_string_lossy())],
        }])
        .unwrap()
    }

    fn cleanup_managed_duplicate_pair(root: PathBuf, root_path: &str) {
        crate::library::MANAGED_ROOTS
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .retain(|managed| managed != root_path);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn duplicate_confirmation_rejects_a_changed_removal_before_unlink() {
        let (root, keep, remove, root_path) = managed_duplicate_pair("duplicate-confirm-changed-removal");
        std::fs::write(&remove, b"other-audio-byte").unwrap();

        let outcome = duplicate_delete(&keep, &remove);

        assert_eq!(outcome.len(), 1);
        assert!(!outcome[0].deleted);
        assert!(outcome[0].error.is_some());
        assert!(remove.exists(), "changed content must not be deleted");
        cleanup_managed_duplicate_pair(root, &root_path);
    }

    #[test]
    fn duplicate_confirmation_rejects_a_missing_or_changed_keeper() {
        let (root, keep, remove, root_path) = managed_duplicate_pair("duplicate-confirm-missing-keeper");
        std::fs::remove_file(&keep).unwrap();

        let outcome = duplicate_delete(&keep, &remove);

        assert_eq!(outcome.len(), 1);
        assert!(!outcome[0].deleted);
        assert!(outcome[0].error.is_some());
        assert!(remove.exists(), "the final remaining copy must survive");
        cleanup_managed_duplicate_pair(root, &root_path);
    }

    #[test]
    fn duplicate_confirmation_rejects_non_equal_same_size_files() {
        let (root, keep, remove, root_path) = managed_duplicate_pair("duplicate-confirm-non-equal");
        std::fs::write(&keep, b"other-audio-byte").unwrap();

        let outcome = duplicate_delete(&keep, &remove);

        assert_eq!(outcome.len(), 1);
        assert!(!outcome[0].deleted);
        assert!(outcome[0].error.is_some());
        assert!(remove.exists());
        cleanup_managed_duplicate_pair(root, &root_path);
    }

    #[test]
    fn duplicate_confirmation_deletes_only_a_current_exact_match() {
        let (root, keep, remove, root_path) = managed_duplicate_pair("duplicate-confirm-success");

        let outcome = duplicate_delete(&keep, &remove);

        assert_eq!(outcome.len(), 1);
        assert!(outcome[0].deleted, "the current exact duplicate is deleted");
        assert!(outcome[0].error.is_none());
        assert!(keep.exists());
        assert!(!remove.exists());
        cleanup_managed_duplicate_pair(root, &root_path);
    }

    #[test]
    fn duplicate_input_accepts_only_regular_media_below_exact_roots() {
        let dir = temp_dir("duplicate-input");
        let root = dir.join("music");
        let sibling = dir.join("music-secret");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&sibling).unwrap();
        let regular = root.join("song.mp3");
        let prefixed_sibling = sibling.join("song.mp3");
        let text = root.join("notes.txt");
        let symlink = root.join("song-link.mp3");
        std::fs::write(&regular, b"audio").unwrap();
        std::fs::write(&prefixed_sibling, b"audio").unwrap();
        std::fs::write(&text, b"notes").unwrap();
        let roots = vec![root.to_string_lossy().into_owned()];

        assert!(safe_duplicate_input(&regular, &roots));
        assert!(!safe_duplicate_input(&prefixed_sibling, &roots));
        assert!(!safe_duplicate_input(&text, &roots));

        #[cfg(unix)]
        let symlink_created = std::os::unix::fs::symlink(&regular, &symlink).is_ok();
        #[cfg(windows)]
        let symlink_created = std::os::windows::fs::symlink_file(&regular, &symlink).is_ok();
        if symlink_created {
            assert!(!safe_duplicate_input(&symlink, &roots));
            let capability_root = open_duplicate_root(canon(&root.to_string_lossy())).unwrap();
            assert!(open_duplicate_candidate(&capability_root, &symlink).is_err());
            drop(capability_root);
        }

        std::fs::remove_dir_all(dir).unwrap();
    }
}
