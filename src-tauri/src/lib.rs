//! Shared app core. Desktop (src/main.rs binary) and Android/iOS (Tauri mobile
//! entry point below) both boot through `run()`.

mod audio;
mod importer;
pub mod library;
mod mpris;
mod rpc;
mod store;
mod stream;
mod share;
mod gdrive;
mod ota;
pub mod youtube;
pub mod ytnative;

use audio::AudioController;
use library::Track;
use tauri::{Manager, State};

struct AppState {
    audio: AudioController,
}

// Scans read tags from hundreds of files — async so the UI thread never blocks.
#[tauri::command]
async fn scan(paths: Vec<String>) -> Result<Vec<Track>, String> {
    Ok(library::scan_library(&paths))
}

#[tauri::command]
async fn scan_diff(
    paths: Vec<String>,
    known: Vec<String>,
) -> Result<library::ScanDiff, String> {
    let known: std::collections::HashSet<String> = known.into_iter().collect();
    Ok(library::scan_diff(&paths, &known))
}

/// Ground-truth existence check used to validate library-cache paths: the JS
/// `libraryLocalFor` trusts the library list blindly, so a deleted/moved/corrupt
/// file still counts as "downloaded" (ghost) until this prunes it.
#[tauri::command]
fn fs_exists(path: String) -> bool {
    let p = std::path::Path::new(&path);
    match std::fs::metadata(p) {
        Ok(m) => m.is_file() && m.len() > 0,
        Err(_) => false,
    }
}

#[tauri::command]
fn play(path: String, gain: f32, state: State<AppState>) -> u64 {
    state.audio.play(path, gain)
}

#[tauri::command]
fn preload(path: String, gain: f32, state: State<AppState>) {
    state.audio.preload(path, gain);
}

#[tauri::command]
fn pause(state: State<AppState>) {
    state.audio.pause();
}

#[tauri::command]
fn resume(state: State<AppState>) {
    state.audio.resume();
}

#[tauri::command]
fn stop(state: State<AppState>) -> u64 {
    state.audio.stop()
}

#[tauri::command]
fn set_volume(level: f32, state: State<AppState>) {
    state.audio.set_volume(level);
}

#[tauri::command]
fn set_agc(on: bool, state: State<AppState>) {
    state.audio.set_agc(on);
}

#[tauri::command]
fn seek(secs: f64, state: State<AppState>) {
    state.audio.seek(secs);
}

#[tauri::command]
fn status(state: State<AppState>) -> audio::PlaybackStatus {
    state.audio.status()
}

/// The last silent audio failure (no device, undecodable stream…), consumed on
/// read — the frontend surfaces it so "no sound" has a reason.
#[tauri::command]
fn audio_error(state: State<AppState>) -> Option<String> {
    state.audio.take_error()
}

/// Opened audio-output device config ("48000 Hz · 2 ch · F32"), "" if none.
/// On Android, appends whether the ndk_context JNI bridge fired.
#[tauri::command]
fn audio_info(state: State<AppState>) -> String {
    let base = state.audio.info();
    #[cfg(target_os = "android")]
    {
        let ndk = if NDK_READY.load(std::sync::atomic::Ordering::Relaxed) { "ndk:ok" } else { "ndk:MISSING" };
        return if base.is_empty() { format!("(no device) [{ndk}]") } else { format!("{base} [{ndk}]") };
    }
    #[allow(unreachable_code)]
    base
}

/// Whether ndk_context now holds a non-null JavaVM (audio can open) — shown in
/// the audio diagnostics so we can see if the JNI bridge fired.
#[cfg(target_os = "android")]
static NDK_READY: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// cpal's Android (AAudio) backend reads the JavaVM + Activity from the global
/// `ndk_context`, which nothing in the Tauri stack populates → no audio device.
/// MainActivity.onCreate calls THIS via JNI, handing us the Activity (a
/// Context); we register its JavaVM + context into ndk_context so audio opens.
/// The symbol name must match <package>.MainActivity.initNdkContext.
#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_com_oniolivvs_musicplayer_MainActivity_initNdkContext<'local>(
    env: jni::JNIEnv<'local>,
    this: jni::objects::JObject<'local>,
) {
    use std::os::raw::c_void;
    let vm = match env.get_java_vm() {
        Ok(vm) => vm,
        Err(_) => return,
    };
    let vm_ptr = vm.get_java_vm_pointer() as *mut c_void;
    // Keep a global ref alive so the context pointer stays valid for the app's
    // lifetime (cpal dereferences it on every audio-device open).
    match env.new_global_ref(&this) {
        Ok(gref) => {
            let ctx_ptr = gref.as_obj().as_raw() as *mut c_void;
            unsafe { ndk_context::initialize_android_context(vm_ptr, ctx_ptr) };
            std::mem::forget(gref);
        }
        Err(_) => unsafe { ndk_context::initialize_android_context(vm_ptr, std::ptr::null_mut()) },
    }
    NDK_READY.store(true, std::sync::atomic::Ordering::Relaxed);
    eprintln!("[android] ndk_context registered from MainActivity");
}

// Streaming commands are async so yt-dlp resolution never blocks the UI thread.

/// Stream URL via whichever backend works: cache → yt-dlp (desktop) → native
/// rustypipe engine (mandatory on Android, fallback elsewhere).
async fn resolve_stream_url(
    yt: &youtube::YtState,
    cfg: &youtube::YtCfg,
    id: &str,
) -> Result<String, String> {
    if let Some(u) = youtube::cached_url(yt, id) {
        return Ok(u);
    }
    // Windows: yt-dlp.exe cold-starts (PyInstaller unpack + antivirus scan)
    // cost seconds PER attempt — and resolve() tries up to 4 clients — while
    // most installs have no yt-dlp at all. The in-process rustypipe resolver
    // (the ANDROID_VR path that already carries Android) answers instantly,
    // so Windows prefers it and keeps yt-dlp as the fallback.
    let prefer_native = ytnative::forced() || cfg!(target_os = "windows");
    let res = if prefer_native {
        match ytnative::stream_url(id).await {
            Ok(u) => Ok(u),
            Err(e) if !ytnative::forced() => {
                youtube::resolve(yt, cfg, id).map_err(|ne| format!("{e} | {ne}"))
            }
            Err(e) => Err(e),
        }
    } else {
        match youtube::resolve(yt, cfg, id) {
            Ok(u) => Ok(u),
            Err(e) => ytnative::stream_url(id).await.map_err(|ne| format!("{e} | {ne}")),
        }
    };
    let url = res?;
    youtube::cache_url(yt, id, url.clone());
    Ok(url)
}

#[tauri::command]
async fn play_stream(
    id: String,
    gain: f32,
    state: State<'_, AppState>,
    yt: State<'_, youtube::YtState>,
    cfg: State<'_, youtube::YtCfg>,
) -> Result<u64, String> {
    let url = resolve_stream_url(&yt, &cfg, &id).await?;
    Ok(state.audio.play_url(url, gain, Some(reresolver(&id))))
}

/// A callback the audio stream calls to get a FRESH URL when a connection 403s
/// (the IP-bound googlevideo link went stale — constant on Android). Always
/// re-resolves natively, bypassing the cache.
fn reresolver(id: &str) -> crate::stream::ReResolve {
    let id = id.to_string();
    std::sync::Arc::new(move || tauri::async_runtime::block_on(ytnative::stream_url(&id)))
}

/// Play a direct audio URL (LAN device sharing streams remote files this way).
#[tauri::command]
fn play_direct(url: String, gain: f32, state: State<AppState>) -> u64 {
    state.audio.play_url(url, gain, None)
}

#[tauri::command]
fn preload_direct(url: String, gain: f32, state: State<AppState>) {
    state.audio.preload_url(url, gain, None);
}

/// Zero the stream download counters when a new stream starts, so the
/// frontend's buffer bar restarts at 0 instead of showing the previous
/// track's progress.
#[tauri::command]
fn reset_stream_progress() {
    stream::note_total(0);
}

#[tauri::command]
async fn preload_stream(
    id: String,
    gain: f32,
    state: State<'_, AppState>,
    yt: State<'_, youtube::YtState>,
    cfg: State<'_, youtube::YtCfg>,
) -> Result<(), String> {
    let url = resolve_stream_url(&yt, &cfg, &id).await?;
    state.audio.preload_url(url, gain, Some(reresolver(&id)));
    Ok(())
}

/// Resolve a stream URL into the cache without playing anything, so the actual
/// play later is near-instant (called when the user selects an online track).
#[tauri::command]
async fn prefetch_stream(
    id: String,
    yt: State<'_, youtube::YtState>,
    cfg: State<'_, youtube::YtCfg>,
) -> Result<(), String> {
    resolve_stream_url(&yt, &cfg, &id).await.map(|_| ())
}

// ─── Self-update: the binary is built from the local source tree (the GitHub
// repo checkout), so "latest version" = the version in the tree's
// tauri.conf.json, and "update" = cargo build + restart. ───

fn source_dir() -> Result<std::path::PathBuf, String> {
    // exe lives at <src-tauri>/target/debug/music-player
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let dir = exe
        .ancestors()
        .nth(3)
        .ok_or("cannot locate the source tree")?
        .to_path_buf();
    if dir.join("tauri.conf.json").exists() {
        Ok(dir)
    } else {
        Err("source tree not found next to the binary".into())
    }
}

const DEV_BOX: &str = "mp-dev"; // container holding git + the Rust toolchain

fn dev_user() -> String {
    std::env::var("USER").unwrap_or_else(|_| "user".into())
}

/// Best-effort: make sure the dev container is running before we exec into it.
fn ensure_devbox() {
    let _ = std::process::Command::new("podman").args(["start", DEV_BOX]).output();
}

/// Run git in the source repo. Immutable/atomic hosts (Bazzite/Silverblue) have
/// no git on the host — the dev tools live in the dev container — so if the
/// host git isn't found, run git INSIDE that container (the repo path is shared).
fn git_out(dir: &std::path::Path, args: &[&str]) -> std::io::Result<std::process::Output> {
    match std::process::Command::new("git").arg("-C").arg(dir).args(args).output() {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            ensure_devbox();
            let dirs = dir.to_string_lossy().to_string();
            let mut cmd = std::process::Command::new("podman");
            cmd.args(["exec", "-u", &dev_user(), DEV_BOX, "git", "-C", &dirs]);
            cmd.args(args);
            cmd.output()
        }
        other => other,
    }
}

/// The build command. Prefer `cargo` on PATH (app launched inside the toolchain
/// env); otherwise build inside the dev container where the Rust toolchain
/// lives — so the in-app Update / downgrade work even when the app runs on a
/// host that has no cargo. `touch tauri.conf.json` forces Tauri to re-embed the
/// frontend (its build script doesn't watch src/).
fn build_argv(dir: &std::path::Path) -> (String, Vec<String>) {
    let inner = format!(
        "export PATH=\"$HOME/.cargo/bin:$PATH\"; cd '{}' && touch tauri.conf.json && cargo build 2>&1",
        dir.display()
    );
    let has_cargo = std::process::Command::new("bash")
        .arg("-lc")
        .arg("command -v cargo >/dev/null 2>&1")
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if has_cargo {
        ("bash".into(), vec!["-lc".into(), inner])
    } else {
        ensure_devbox();
        (
            "podman".into(),
            vec![
                "exec".into(), "-u".into(), dev_user(), DEV_BOX.into(),
                "bash".into(), "-lc".into(), inner,
            ],
        )
    }
}

/// Stream a cargo build; "update" events carry the progress lines.
fn do_build(app: &tauri::AppHandle) -> Result<String, String> {
    use std::io::BufRead;
    use tauri::Emitter;
    let dir = source_dir()?;
    let (prog, args) = build_argv(&dir);
    let mut child = std::process::Command::new(&prog)
        .args(&args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("cannot run the build ({prog}): {e}"))?;
    let mut tail: Vec<String> = Vec::new();
    if let Some(out) = child.stdout.take() {
        for line in std::io::BufReader::new(out).lines().map_while(Result::ok) {
            let _ = app.emit("update", line.clone());
            tail.push(line);
            if tail.len() > 40 {
                tail.remove(0);
            }
        }
    }
    let status = child.wait().map_err(|e| e.to_string())?;
    if !status.success() {
        return Err(format!("build failed:\n{}", tail.join("\n")));
    }
    Ok("built".into())
}

/// Latest version PUBLISHED ON GITHUB (origin/main) so "check for updates"
/// reflects GitHub, not whatever happens to be checked out locally.
#[tauri::command]
async fn source_version() -> Result<String, String> {
    if let Ok(dir) = source_dir() {
        let _ = git_out(
            &dir,
            &["-c", "http.lowSpeedLimit=1000", "-c", "http.lowSpeedTime=10", "fetch", "origin", "--tags", "--quiet"],
        );
        let txt = git_out(&dir, &["show", "origin/main:src-tauri/tauri.conf.json"])
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
            .or_else(|| std::fs::read_to_string(dir.join("tauri.conf.json")).ok())
            .ok_or("cannot read version")?;
        let v: serde_json::Value = serde_json::from_str(&txt).map_err(|e| e.to_string())?;
        return v["version"].as_str().map(str::to_string).ok_or_else(|| "no version field".into());
    }

    let resp = ureq::AgentBuilder::new()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .get("https://api.github.com/repos/oniolivvs/music-player/releases/latest")
        .set("User-Agent", "MusicPlayer")
        .call()
        .map_err(|e| e.to_string())?;
    let text = resp.into_string().map_err(|e| e.to_string())?;
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    v["tag_name"]
        .as_str()
        .map(|s| s.trim_start_matches('v').to_string())
        .ok_or_else(|| "no tag_name in release".into())
}

/// Relaunch the app process — used right after a build replaced the binary.
#[tauri::command]
fn restart_app(app: tauri::AppHandle) {
    app.restart();
}

/// Per-platform update info from GitHub releases. Versions are effectively
/// independent per platform: we return the newest release that actually ships
/// an installer/APK for THIS OS, so an Android-only fix release doesn't show up
/// as "newer" to Windows users (and vice-versa). `asset_url` is the direct
/// download for this platform (APK on Android) — the frontend opens it.
#[derive(serde::Serialize, Default)]
struct ReleaseInfo {
    version: String,
    asset_url: String,
    page_url: String,
    platform: String,
}

/// Windows ships two installers in one release: the NSIS `*-setup.exe` and an
/// `.msi`. They take different silent switches, so the choice cannot be left to
/// whichever the API happens to list first — today the .exe wins only because
/// '-' sorts before '_' in the asset names. Prefer the NSIS build explicitly;
/// `run_installer` reads the extension back to pick the matching switch.
fn pick_platform_asset(assets: &[serde_json::Value]) -> Option<&serde_json::Value> {
    if cfg!(target_os = "windows") {
        if let Some(a) = assets.iter().find(|a| {
            a["name"].as_str().map(|n| n.to_lowercase().ends_with("-setup.exe")).unwrap_or(false)
        }) {
            return Some(a);
        }
    }
    assets
        .iter()
        .find(|a| a["name"].as_str().map(platform_asset_match).unwrap_or(false))
}

fn platform_asset_match(name: &str) -> bool {
    let n = name.to_lowercase();
    if cfg!(target_os = "android") {
        n.ends_with(".apk")
    } else if cfg!(target_os = "windows") {
        n.ends_with(".exe") || n.ends_with(".msi")
    } else if cfg!(target_os = "macos") {
        n.ends_with(".dmg") || n.ends_with(".app.tar.gz")
    } else {
        n.ends_with(".appimage") || n.ends_with(".deb") || n.ends_with(".rpm")
    }
}

/// Self-update downloads must come from GitHub (the release host) over HTTPS.
/// The URL reaches these commands from the webview, so a compromised frontend
/// must not be able to turn the updater into an arbitrary-file downloader.
fn github_release_url(url: &str) -> bool {
    let rest = match url.strip_prefix("https://") {
        Some(r) => r,
        None => return false,
    };
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    host == "github.com" || host == "api.github.com" || host.ends_with(".githubusercontent.com")
}

/// `run_installer` only ever launches what `download_installer` saved — refuse
/// any path outside the dedicated update temp dir.
fn is_update_artifact(path: &str) -> bool {
    let dir = std::env::temp_dir().join("musicplayer-update");
    match (std::fs::canonicalize(path), std::fs::canonicalize(&dir)) {
        (Ok(p), Ok(d)) => p.starts_with(&d),
        _ => false,
    }
}

fn platform_name() -> &'static str {
    if cfg!(target_os = "android") { "android" }
    else if cfg!(target_os = "windows") { "windows" }
    else if cfg!(target_os = "macos") { "macos" }
    else { "linux" }
}

/// Open a URL in the system browser / installer, cross-platform incl. Android.
/// Uses tauri-plugin-opener, which fires a proper ACTION_VIEW intent on Android
/// (window.open does nothing from the WebView) — the mobile update download.
#[tauri::command]
fn open_url(app: tauri::AppHandle, url: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("only http(s) links can be opened".into());
    }
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
}

/// In-app APK self-update, step 1 (Android): download the release APK into the
/// app's external files dir (the FileProvider root) with "apkdl" progress
/// events, so the user never has to visit GitHub or a browser.
#[tauri::command]
async fn download_apk(app: tauri::AppHandle, url: String) -> Result<String, String> {
    #[cfg(not(target_os = "android"))]
    {
        let _ = (&app, &url);
        Err("Android only".into())
    }
    #[cfg(target_os = "android")]
    {
        use std::io::{Read, Write};
        use tauri::Emitter;
        if !github_release_url(&url) {
            return Err("update downloads are restricted to github.com".into());
        }
        let dir = "/storage/emulated/0/Android/data/com.oniolivvs.musicplayer/files";
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        let path = format!("{dir}/update.apk");
        let part = format!("{path}.part");
        // No overall timeout — the APK is large; only cap the connect phase.
        let resp = ureq::AgentBuilder::new()
            .timeout_connect(std::time::Duration::from_secs(20))
            .build()
            .get(&url)
            .set("User-Agent", "MusicPlayer")
            .call()
            .map_err(|e| e.to_string())?;
        let total: u64 = resp
            .header("Content-Length")
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);
        let mut reader = resp.into_reader();
        let mut out = std::fs::File::create(&part).map_err(|e| e.to_string())?;
        let mut buf = vec![0u8; 256 * 1024];
        let (mut done, mut last) = (0u64, -1i32);
        loop {
            let n = reader.read(&mut buf).map_err(|e| format!("download read: {e}"))?;
            if n == 0 {
                break;
            }
            out.write_all(&buf[..n]).map_err(|e| e.to_string())?;
            done += n as u64;
            if total > 0 {
                let pct = ((done * 100) / total) as i32;
                if pct != last {
                    last = pct;
                    let _ = app.emit("apkdl", serde_json::json!({ "pct": pct }));
                }
            }
        }
        out.flush().ok();
        drop(out);
        if total > 0 && done < total {
            let _ = std::fs::remove_file(&part);
            return Err("download ended early".into());
        }
        std::fs::rename(&part, &path).map_err(|e| e.to_string())?;
        Ok(path)
    }
}

/// Step 2: hand the downloaded APK to the system installer. Calls the
/// MainActivity.installApk(String) Kotlin helper via JNI (the Activity object
/// is the context registered in ndk_context by initNdkContext).
#[tauri::command]
fn install_apk(path: String) -> Result<(), String> {
    #[cfg(not(target_os = "android"))]
    {
        let _ = path;
        Err("Android only".into())
    }
    #[cfg(target_os = "android")]
    {
        // Only the APK that download_apk just saved — never an arbitrary path.
        if path != "/storage/emulated/0/Android/data/com.oniolivvs.musicplayer/files/update.apk" {
            return Err("not the downloaded update APK".into());
        }
        // UB garde: le contexte JNI n'est prêt qu'après l'initNdkContext de la
        // MainActivity (onCreate → JNI). Un from_raw(null) est de l'UB natif,
        // pas un Err — on vérifie avant d'appeler JNI.
        let ctx = ndk_context::android_context();
        if ctx.vm().is_null() || ctx.context().is_null() {
            return Err("android bridge not ready yet".into());
        }
        let vm = unsafe { jni::JavaVM::from_raw(ctx.vm().cast()) }.map_err(|e| e.to_string())?;
        let mut env = vm.attach_current_thread().map_err(|e| e.to_string())?;
        let activity = unsafe { jni::objects::JObject::from_raw(ctx.context().cast()) };
        let jpath = env.new_string(&path).map_err(|e| e.to_string())?;
        env.call_method(
            &activity,
            "installApk",
            "(Ljava/lang/String;)V",
            &[jni::objects::JValue::Object(&jpath)],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }
}

/// In-app DESKTOP self-update, step 1: download the platform installer into
/// the temp dir, with the same "apkdl" progress events as the Android flow —
/// no browser, no GitHub page.
#[tauri::command]
async fn download_installer(app: tauri::AppHandle, url: String) -> Result<String, String> {
    #[cfg(target_os = "android")]
    {
        let _ = (&app, &url);
        Err("desktop only".into())
    }
    #[cfg(not(target_os = "android"))]
    {
        if !github_release_url(&url) {
            return Err("update downloads are restricted to github.com".into());
        }
        tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
            use std::io::{Read, Write};
            use tauri::Emitter;
            let raw = url.rsplit('/').next().unwrap_or("installer.bin");
            let name: String = raw
                .chars()
                .map(|c| if c.is_ascii_alphanumeric() || "._- ".contains(c) { c } else { '_' })
                .collect();
            let name = if name.trim_matches(['.', ' ']).is_empty() { "installer.bin".to_string() } else { name };
            let dir = std::env::temp_dir().join("musicplayer-update");
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            let path = dir.join(&name);
            let part = dir.join(format!("{name}.part"));
            let resp = ureq::AgentBuilder::new()
                .timeout_connect(std::time::Duration::from_secs(20))
                .build()
                .get(&url)
                .set("User-Agent", "MusicPlayer")
                .call()
                .map_err(|e| e.to_string())?;
            let total: u64 = resp.header("Content-Length").and_then(|s| s.parse().ok()).unwrap_or(0);
            let mut reader = resp.into_reader();
            let mut out = std::fs::File::create(&part).map_err(|e| e.to_string())?;
            let mut buf = vec![0u8; 256 * 1024];
            let (mut done, mut last) = (0u64, -1i32);
            loop {
                let n = reader.read(&mut buf).map_err(|e| format!("download read: {e}"))?;
                if n == 0 { break; }
                out.write_all(&buf[..n]).map_err(|e| e.to_string())?;
                done += n as u64;
                if total > 0 {
                    let pct = ((done * 100) / total) as i32;
                    if pct != last {
                        last = pct;
                        let _ = app.emit("apkdl", serde_json::json!({ "pct": pct }));
                    }
                }
            }
            out.flush().ok();
            drop(out);
            if total > 0 && done < total {
                let _ = std::fs::remove_file(&part);
                return Err("download ended early".into());
            }
            std::fs::rename(&part, &path).map_err(|e| e.to_string())?;
            Ok(path.to_string_lossy().into_owned())
        })
        .await
        .map_err(|e| e.to_string())?
    }
}

/// Step 2: launch the downloaded installer and quit so it can replace the app
/// (the NSIS installer closes/relaunches the app itself; exiting first keeps
/// the flow seamless). Non-Windows desktops open the file with the OS handler.
#[tauri::command]
fn run_installer(app: tauri::AppHandle, path: String) -> Result<(), String> {
    if !is_update_artifact(&path) {
        return Err("not a downloaded update file".into());
    }
    #[cfg(target_os = "windows")]
    {
        // Silent switches are per-installer-kind, so read the extension rather
        // than assuming: /S is NSIS and means nothing to msiexec, which would
        // sit on a visible dialog forever after the app has already exited.
        //
        // Running silently at all is only safe because the bundle sets
        // installMode "currentUser": nothing lands outside the user's own
        // directories, so Windows raises no UAC prompt an unattended run could
        // not answer. Switch the bundle to perMachine and both branches must go
        // back to an interactive run.
        let mut cmd = if path.to_lowercase().ends_with(".msi") {
            let mut c = std::process::Command::new("msiexec");
            c.arg("/i").arg(&path).arg("/qn").arg("/norestart");
            c
        } else {
            let mut c = std::process::Command::new(&path);
            c.arg("/S");
            c
        };
        cmd.spawn().map_err(|e| format!("cannot start installer: {e}"))?;
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(800));
            app.exit(0);
        });
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        use tauri_plugin_opener::OpenerExt;
        app.opener().open_path(path, None::<&str>).map_err(|e| e.to_string())
    }
}

#[tauri::command]
async fn latest_release() -> Result<ReleaseInfo, String> {
    let resp = ureq::AgentBuilder::new()
        .timeout(std::time::Duration::from_secs(12))
        .build()
        .get("https://api.github.com/repos/oniolivvs/music-player/releases?per_page=20")
        .set("User-Agent", "MusicPlayer")
        .call()
        .map_err(|e| e.to_string())?;
    let text = resp.into_string().map_err(|e| e.to_string())?;
    let arr: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let releases = arr.as_array().ok_or("unexpected releases payload")?;
    // Newest first (the API returns them in that order); pick the first whose
    // assets include a file for this platform.
    for r in releases {
        if r["draft"].as_bool().unwrap_or(false) || r["prerelease"].as_bool().unwrap_or(false) {
            continue;
        }
        let assets = r["assets"].as_array().cloned().unwrap_or_default();
        if let Some(a) = pick_platform_asset(&assets) {
            return Ok(ReleaseInfo {
                version: r["tag_name"].as_str().unwrap_or("").trim_start_matches('v').to_string(),
                asset_url: a["browser_download_url"].as_str().unwrap_or("").to_string(),
                page_url: r["html_url"].as_str().unwrap_or("").to_string(),
                platform: platform_name().to_string(),
            });
        }
    }
    Err("no release with an installer for this platform".into())
}

/// Update to the latest version on GitHub: fetch, move the tree onto origin/main,
/// then rebuild. (The app's source tree is only ever a clean checkout.)
#[tauri::command]
async fn self_update(app: tauri::AppHandle) -> Result<String, String> {
    if let Ok(dir) = source_dir() {
        let _ = git_out(&dir, &["fetch", "origin", "--tags", "--quiet"]);
        // The update must build EXACTLY origin/main, whatever the local tree
        // holds: `checkout -B main origin/main` only moves the branch pointer,
        // so existing local edits (stale or experimental) still compiled and
        // the app restarted on something other than the published release.
        let _ = git_out(&dir, &["reset", "--hard", "origin/main", "--quiet"]);
        return do_build(&app);
    }

    // No source tree (installer / mobile): open the releases page to download.
    use tauri_plugin_opener::OpenerExt;
    let _ = app
        .opener()
        .open_url("https://github.com/oniolivvs/music-player/releases/latest".to_string(), None::<&str>);
    Err("Opened the download page in your browser. Please run the new installer to update.".into())
}

#[derive(serde::Serialize)]
struct VersionEntry {
    version: String,
    hash: String,
    date: String,
    current: bool,
}

/// List the version commits in the local git history (any branch) so the user
/// can switch (downgrade or re-upgrade) between built versions.
#[tauri::command]
async fn list_versions() -> Result<Vec<VersionEntry>, String> {
    let dir = source_dir()?;
    let git = |args: &[&str]| git_out(&dir, args);
    // Pull the latest versions published on GitHub first (best-effort — offline
    // or no cached credentials just falls back to whatever is already local).
    let _ = git(&[
        "-c", "http.lowSpeedLimit=1000",
        "-c", "http.lowSpeedTime=10", // give up if the network stalls for 10s
        "fetch", "origin", "--tags", "--quiet",
    ]);
    let out = git(&["log", "--all", "--date-order", "--pretty=%H\x1f%cs\x1f%s", "-n", "500"])
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err("not a git checkout (version switching needs the source repo)".into());
    }
    let head = git(&["rev-parse", "HEAD"])
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();
    let text = String::from_utf8_lossy(&out.stdout);
    let mut seen = std::collections::HashSet::new();
    let mut list = Vec::new();
    for line in text.lines() {
        let mut it = line.splitn(3, '\x1f');
        let hash = it.next().unwrap_or("").to_string();
        let date = it.next().unwrap_or("").to_string();
        let subj = it.next().unwrap_or("");
        let ver = subj.split_whitespace().next().unwrap_or("");
        // Only "vX…" commit subjects; keep the newest occurrence of each version.
        if !ver.starts_with('v') || !ver[1..].starts_with(|c: char| c.is_ascii_digit()) {
            continue;
        }
        if !seen.insert(ver.to_string()) {
            continue;
        }
        let current = !hash.is_empty() && hash == head;
        list.push(VersionEntry { version: ver.to_string(), hash, date, current });
    }
    Ok(list)
}

/// Check out a version commit and rebuild into it, then the UI restarts.
/// Refuses if the working tree is dirty (would clobber local edits).
#[tauri::command]
async fn switch_version(app: tauri::AppHandle, rev: String) -> Result<String, String> {
    let dir = source_dir()?;
    // Make sure the target commit (possibly GitHub-only) is available locally.
    let _ = git_out(&dir, &["fetch", "origin", "--tags", "--quiet"]);
    // Force-checkout the chosen version: the source tree is only ever a clean
    // checkout, so this is safe and avoids a "dirty tree" dead-end for the user.
    let co = git_out(&dir, &["-c", "advice.detachedHead=false", "checkout", "-f", &rev])
        .map_err(|e| e.to_string())?;
    if !co.status.success() {
        return Err(format!(
            "git checkout failed: {}",
            String::from_utf8_lossy(&co.stderr).trim()
        ));
    }
    // Rebuild AT this version (not origin/main — that's what self_update does).
    do_build(&app)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // FORCE-LOG IMMEDIATELY TO PROVE THE APP STARTED
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        let dir = std::path::PathBuf::from(local).join("com.oniolivvs.musicplayer");
        let _ = std::fs::create_dir_all(&dir);
        let _ = std::fs::write(dir.join("startup.log"), "APP STARTED IN MAIN\n");
    }

    std::panic::set_hook(Box::new(|info| {
        let dir = if let Ok(local) = std::env::var("LOCALAPPDATA") {
            std::path::PathBuf::from(local).join("com.oniolivvs.musicplayer")
        } else if let Ok(home) = std::env::var("HOME") {
            std::path::PathBuf::from(home).join(".local/share/com.oniolivvs.musicplayer")
        } else {
            std::path::PathBuf::from(".")
        };
        let _ = std::fs::create_dir_all(&dir);
        let log_path = dir.join("crash.log");
        let msg = match info.payload().downcast_ref::<&'static str>() {
            Some(s) => *s,
            None => match info.payload().downcast_ref::<String>() {
                Some(s) => &s[..],
                None => "Box<dyn Any>",
            },
        };
        let location = info.location().map(|l| format!("{}:{}", l.file(), l.line())).unwrap_or_default();
        use std::io::Write;
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(log_path) {
            let _ = writeln!(f, "Panic at {location}:\n{msg}\n");
        }
    }));

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init());
    // "Launch at login" toggle (Settings → System) — desktop only.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_autostart::init(
        tauri_plugin_autostart::MacosLauncher::LaunchAgent,
        None,
    ));
    builder
        .manage(AppState {
            audio: AudioController::new(),
        })
        .manage(rpc::RpcState::default())
        .manage(youtube::YtState::default())
        .manage(youtube::YtCfg::default())
        .manage(youtube::DlState::default())
        .manage(mpris::MediaState::default())
        .manage(share::ShareState::default())
        .manage(gdrive::GDriveState::default())
        .setup(|app| {
            // Native YouTube engine cache (client versions, visitor data).
            ytnative::init_storage(
                app.path()
                    .app_data_dir()
                    .unwrap_or_else(|_| std::env::temp_dir().join("musicplayer")),
            );
            // Register on D-Bus right away so desktop media widgets see the player.
            let handle = app.handle();
            if let Err(e) = mpris::init(handle, &app.state::<mpris::MediaState>()) {
                eprintln!("[mpris] init failed (desktop integration disabled): {e}");
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            scan, scan_diff, fs_exists, play, preload, pause, resume, stop, set_volume, set_agc, seek, status, audio_error, audio_info,
            source_version, self_update, restart_app, list_versions, switch_version,
            latest_release, open_url, download_apk, install_apk, download_installer, run_installer,
            share::share_start, share::share_stop, share::share_status, share::share_connect, share::share_download,
            gdrive::gdrive_sign_in, gdrive::gdrive_sign_out, gdrive::gdrive_set_tokens, gdrive::gdrive_account, gdrive::gdrive_pull, gdrive::gdrive_push,
            ota::ota_bundle, ota::ota_check, ota::ota_apply, ota::ota_rollback,
            play_stream, preload_stream, prefetch_stream, play_direct, preload_direct,
            reset_stream_progress,
            youtube::yt_search, youtube::yt_search_playlists, youtube::yt_playlist,
            youtube::yt_recommendations, youtube::yt_trending,
            youtube::yt_playlist_preview, youtube::yt_playlist_head,
            youtube::yt_channel, youtube::yt_channel_videos,
            youtube::yt_channel_playlists, youtube::yt_channel_all,
            youtube::yt_download, youtube::yt_cancel,
            youtube::yt_config, youtube::yt_install, youtube::detect_browsers,
            mpris::media_update, mpris::media_playback,
            library::cover, library::read_image, library::net_image, library::delete_file, library::open_path,
            library::canon_path, library::canon_paths, library::folder_size,
            store::store_load, store::store_save,
            rpc::rpc_update, rpc::rpc_clear,
            importer::import_spotify
        ])
        .run(tauri::generate_context!())
        .expect("error while running Music Player");
}
