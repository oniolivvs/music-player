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
