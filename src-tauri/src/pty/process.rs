//! Information about processes running on a terminal.

/// The executable name of process `pid`, e.g. `zsh` for a login shell whose
/// `argv[0]` is `-zsh`. `None` if the process is gone or not visible.
#[cfg(target_os = "macos")]
pub fn name(pid: u32) -> Option<String> {
    let pid = libc::c_int::try_from(pid).ok()?;
    // proc_name truncates to 2 * MAXCOMLEN (32) bytes.
    let mut buf = [0u8; 64];
    // SAFETY: the buffer is writable for the length passed.
    let len = unsafe { libc::proc_name(pid, buf.as_mut_ptr().cast(), buf.len() as u32) };
    let len = usize::try_from(len).ok().filter(|&len| len > 0)?;
    Some(String::from_utf8_lossy(&buf[..len.min(buf.len())]).into_owned())
}

/// The executable name of process `pid`, e.g. `zsh` for a login shell whose
/// `argv[0]` is `-zsh`. `None` if the process is gone or not visible.
#[cfg(target_os = "linux")]
pub fn name(pid: u32) -> Option<String> {
    let comm = std::fs::read(format!("/proc/{pid}/comm")).ok()?;
    let comm = comm.strip_suffix(b"\n").unwrap_or(&comm);
    Some(String::from_utf8_lossy(comm).into_owned()).filter(|name| !name.is_empty())
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub fn name(_pid: u32) -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    #[test]
    fn names_the_current_process() {
        let name = super::name(std::process::id()).expect("no name for ourselves");
        let exe = std::env::current_exe().unwrap();
        let exe = exe.file_name().unwrap().to_string_lossy();
        // Linux truncates comm to 15 bytes.
        assert!(exe.starts_with(&name), "{name:?} vs {exe:?}");
    }
}
