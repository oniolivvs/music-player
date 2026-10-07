#[cfg(target_os = "windows")]
pub struct InstanceGuard(windows_sys::Win32::Foundation::HANDLE);

#[cfg(target_os = "windows")]
impl Drop for InstanceGuard {
    fn drop(&mut self) {
        unsafe { windows_sys::Win32::Foundation::CloseHandle(self.0); }
    }
}

#[cfg(target_os = "windows")]
pub fn try_acquire_named(name: &str) -> Option<InstanceGuard> {
    use std::iter;
    use windows_sys::Win32::Foundation::{GetLastError, ERROR_ALREADY_EXISTS};
    use windows_sys::Win32::System::Threading::CreateMutexW;
    let wide: Vec<u16> = name.encode_utf16().chain(iter::once(0)).collect();
    let handle = unsafe { CreateMutexW(std::ptr::null(), 0, wide.as_ptr()) };
    if handle.is_null() { return None; }
    if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
        unsafe { windows_sys::Win32::Foundation::CloseHandle(handle); }
        return None;
    }
    Some(InstanceGuard(handle))
}

/// What a second launch did about the instance holding the lock. Launching
/// again used to exit silently: a minimized or hidden window never came back,
/// and an instance stuck before its window appeared (WebView2 never started)
/// kept the lock forever — clicking the shortcut simply did nothing.
#[derive(Debug, PartialEq, Eq)]
pub enum HandOff {
    /// Its window was brought to the front: this launch can exit.
    Focused,
    /// It had no window long after starting and was ended, or it was already
    /// exiting: this launch takes over.
    TakeOver,
    /// It is still starting up: leave it alone.
    Starting,
}

/// Window title set in tauri.conf.json — helper windows (IME, WebView2) carry
/// other titles and must never be mistaken for the app.
#[cfg(target_os = "windows")]
const WINDOW_TITLE: &str = "Music Player";
/// A normal cold start shows the window within a few seconds.
#[cfg(target_os = "windows")]
const STUCK_AFTER_SECS: u64 = 20;

/// Another process running this executable.
#[cfg(target_os = "windows")]
struct Other {
    pid: u32,
    age_secs: u64,
    /// Its WebView2 browser process is running (a direct child). A window is
    /// not proof of health: a start that failed in WebView2 still created an
    /// (empty) "Music Player" window behind an "Error" dialog.
    has_webview: bool,
}

#[cfg(target_os = "windows")]
pub fn hand_off() -> HandOff {
    let others = other_instances();
    if others.is_empty() {
        return HandOff::TakeOver;
    }
    if others.iter().all(|o| !o.has_webview && o.age_secs >= STUCK_AFTER_SECS) {
        for other in &others {
            terminate(other.pid);
        }
        return HandOff::TakeOver;
    }
    let healthy: Vec<u32> = others.iter().filter(|o| o.has_webview).map(|o| o.pid).collect();
    if let Some(hwnd) = app_window_of(&healthy) {
        focus(hwnd);
        return HandOff::Focused;
    }
    HandOff::Starting
}

#[cfg(not(target_os = "windows"))]
pub fn hand_off() -> HandOff {
    HandOff::Starting
}

/// After a takeover, wait for the previous holder to release the lock.
pub fn acquire_after_takeover() -> Option<InstanceGuard> {
    for _ in 0..30 {
        if let Some(guard) = acquire() {
            return Some(guard);
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
    None
}

/// Other processes running this very executable.
#[cfg(target_os = "windows")]
fn other_instances() -> Vec<Other> {
    use windows_sys::Win32::Foundation::{CloseHandle, FILETIME, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    let Ok(me) = std::env::current_exe() else { return Vec::new() };
    let me_name = me.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
    let me_path = me.to_string_lossy().to_lowercase();
    let my_pid = std::process::id();
    let mut out = Vec::new();
    let mut webview_parents = std::collections::HashSet::new();
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return out;
        }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut more = Process32FirstW(snapshot, &mut entry) != 0;
        while more {
            let len = entry.szExeFile.iter().position(|&c| c == 0).unwrap_or(entry.szExeFile.len());
            let name = String::from_utf16_lossy(&entry.szExeFile[..len]).to_lowercase();
            let pid = entry.th32ProcessID;
            if name == "msedgewebview2.exe" {
                webview_parents.insert(entry.th32ParentProcessID);
            }
            if pid != my_pid && name == me_name {
                let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
                if !process.is_null() {
                    let mut buf = [0u16; 1024];
                    let mut size = buf.len() as u32;
                    let same_exe = QueryFullProcessImageNameW(process, 0, buf.as_mut_ptr(), &mut size) != 0
                        && String::from_utf16_lossy(&buf[..size as usize]).to_lowercase() == me_path;
                    let mut times: [FILETIME; 4] = std::mem::zeroed();
                    let [created, exited, kernel, user] = &mut times;
                    let age = if GetProcessTimes(process, created, exited, kernel, user) != 0 { age_secs(created) } else { 0 };
                    CloseHandle(process);
                    if same_exe {
                        out.push(Other { pid, age_secs: age, has_webview: false });
                    }
                }
            }
            more = Process32NextW(snapshot, &mut entry) != 0;
        }
        CloseHandle(snapshot);
    }
    for other in &mut out {
        other.has_webview = webview_parents.contains(&other.pid);
    }
    out
}

#[cfg(target_os = "windows")]
fn age_secs(created: &windows_sys::Win32::Foundation::FILETIME) -> u64 {
    // FILETIME counts 100 ns since 1601-01-01.
    const UNIX_TO_FILETIME: u64 = 116_444_736_000_000_000;
    let created = ((created.dwHighDateTime as u64) << 32) | created.dwLowDateTime as u64;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| (d.as_nanos() / 100) as u64)
        .unwrap_or(0)
        + UNIX_TO_FILETIME;
    now.saturating_sub(created) / 10_000_000
}

/// The app's own top-level window among these processes, by its exact title.
#[cfg(target_os = "windows")]
fn app_window_of(pids: &[u32]) -> Option<windows_sys::Win32::Foundation::HWND> {
    use windows_sys::Win32::Foundation::{HWND, LPARAM};
    use windows_sys::Win32::UI::WindowsAndMessaging::{EnumWindows, GetWindowTextW, GetWindowThreadProcessId};
    struct Search<'a> {
        pids: &'a [u32],
        found: HWND,
    }
    unsafe extern "system" fn visit(hwnd: HWND, lparam: LPARAM) -> windows_sys::core::BOOL {
        let search = unsafe { &mut *(lparam as *mut Search) };
        let mut pid = 0u32;
        unsafe { GetWindowThreadProcessId(hwnd, &mut pid) };
        if search.pids.contains(&pid) {
            let mut buf = [0u16; 64];
            let len = unsafe { GetWindowTextW(hwnd, buf.as_mut_ptr(), buf.len() as i32) };
            if len > 0 && String::from_utf16_lossy(&buf[..len as usize]) == WINDOW_TITLE {
                search.found = hwnd;
                return 0; // stop enumerating
            }
        }
        1
    }
    let mut search = Search { pids, found: std::ptr::null_mut() };
    unsafe { EnumWindows(Some(visit), &mut search as *mut Search as LPARAM) };
    (!search.found.is_null()).then_some(search.found)
}

#[cfg(target_os = "windows")]
fn focus(hwnd: windows_sys::Win32::Foundation::HWND) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{IsIconic, SetForegroundWindow, ShowWindow, SW_RESTORE, SW_SHOW};
    unsafe {
        ShowWindow(hwnd, if IsIconic(hwnd) != 0 { SW_RESTORE } else { SW_SHOW });
        SetForegroundWindow(hwnd);
    }
}

#[cfg(target_os = "windows")]
fn terminate(pid: u32) {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};
    unsafe {
        let process = OpenProcess(PROCESS_TERMINATE, 0, pid);
        if !process.is_null() {
            TerminateProcess(process, 1);
            CloseHandle(process);
        }
    }
}

#[cfg(not(target_os = "windows"))]
pub struct InstanceGuard;

#[cfg(not(target_os = "windows"))]
pub fn try_acquire_named(_name: &str) -> Option<InstanceGuard> { Some(InstanceGuard) }

pub fn acquire() -> Option<InstanceGuard> {
    try_acquire_named("Local\\MusicPlayer-single-instance")
}

#[cfg(test)]
mod tests {
    use super::try_acquire_named;

    #[test]
    fn second_acquire_of_same_name_is_rejected() {
        let name = format!("Local\\MusicPlayerTest-{}", std::process::id());
        let first = try_acquire_named(&name);
        assert!(first.is_some());
        let second = try_acquire_named(&name);
        assert!(second.is_none());
    }
}
