//! API keys in the OS credential store (Keychain on macOS, Credential
//! Manager on Windows, Secret Service on Linux) through `keyring`. One entry
//! per account: service [`SERVICE`], account from
//! [`ProviderConfig::key_account`](super::provider::ProviderConfig::key_account)
//! (the provider id, or `custom:<base URL>` so a custom key stays with its
//! endpoint).
//!
//! Keys are never written to settings files, and no command returns one to
//! the webview: it can set, delete and ask whether one is set. These calls
//! can block (the OS may show a prompt), so callers run them on the
//! blocking pool. OS store reads are cached for the life of the app, so the
//! OS asks at most once per account per launch.
//!
//! Other stores, chosen by `MIDTERM_KEYSTORE`:
//! - `memory`: keys live only in this process. The default for builds with
//!   the `tauri-mcp` feature (`bun run dev:mcp`), so an agent-driven
//!   instance never touches the developer's Keychain.
//! - `file` (debug builds only, Unix, not `tauri-mcp`): a JSON file, `MIDTERM_KEYS_FILE` or
//!   `~/.config/midterm-dev/keys.json`, mode 600 in a 700 directory. A
//!   debug build is ad-hoc signed and its signature changes with every
//!   rebuild, so the Keychain asks for the password each time; this avoids
//!   that. Release builds ignore `file`.
//! - `os`: the OS store, also in `tauri-mcp` builds.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use keyring::{Entry, Error};

use super::error::AiError;

pub const SERVICE: &str = "com.ron.midterm.ai";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Store {
    Os,
    Memory,
    File,
}

/// Which store to use: `MIDTERM_KEYSTORE` (`os`, `memory`, or `file` when
/// `file_allowed`) wins, otherwise memory for `tauri-mcp` builds and the OS
/// store for the rest.
pub fn select_store(mcp_feature: bool, file_allowed: bool, env: Option<&str>) -> Store {
    match env.map(|v| v.trim().to_ascii_lowercase()).as_deref() {
        Some("os") => Store::Os,
        Some("memory") => Store::Memory,
        Some("file") if file_allowed => Store::File,
        _ if mcp_feature => Store::Memory,
        _ => Store::Os,
    }
}

fn store() -> Store {
    static STORE: OnceLock<Store> = OnceLock::new();
    *STORE.get_or_init(|| {
        let env = std::env::var("MIDTERM_KEYSTORE").ok();
        // Not in `tauri-mcp` builds: a `MIDTERM_KEYSTORE=file` exported in the
        // developer's shell must not hand their keys to an agent's instance.
        let file_allowed = cfg!(all(debug_assertions, unix, not(feature = "tauri-mcp")));
        let chosen = select_store(cfg!(feature = "tauri-mcp"), file_allowed, env.as_deref());
        match chosen {
            Store::File => eprintln!("ai keys: using the key file {}", key_file().display()),
            _ => eprintln!("ai keys: using the {chosen:?} store"),
        }
        chosen
    })
}

/// Called at startup so the chosen store is logged once.
pub fn log_store() {
    store();
}

type Memory = Mutex<HashMap<String, String>>;

fn memory() -> &'static Memory {
    static MEM: OnceLock<Memory> = OnceLock::new();
    MEM.get_or_init(Default::default)
}

fn trimmed(key: &str) -> Result<&str, AiError> {
    let key = key.trim();
    if key.is_empty() {
        return Err(AiError::other("the key is empty"));
    }
    Ok(key)
}

fn mem_set(map: &Memory, account: &str, key: &str) -> Result<(), AiError> {
    let key = trimmed(key)?;
    map.lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(account.to_string(), key.to_string());
    Ok(())
}

fn mem_delete(map: &Memory, account: &str) {
    map.lock().unwrap_or_else(|e| e.into_inner()).remove(account);
}

fn mem_get(map: &Memory, account: &str) -> Option<String> {
    map.lock().unwrap_or_else(|e| e.into_inner()).get(account).cloned()
}

// --- OS store, with a per-launch cache of what it returned ---------------

/// Account → the OS store's answer (`None`: no entry). Errors are not
/// cached, so a denied prompt is asked again next time. The cache can go
/// stale if another program edits the item while the app runs; restarting
/// (or saving the key again in the app) picks up the change.
type OsCache = Mutex<HashMap<String, Option<String>>>;

fn os_cache() -> &'static OsCache {
    static CACHE: OnceLock<OsCache> = OnceLock::new();
    CACHE.get_or_init(Default::default)
}

/// Serializes every OS store call together with its cache update, so a
/// cold read cannot overwrite a newer set/delete, updates land in the order
/// of the OS writes, and concurrent cold reads ask the OS once.
fn os_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner())
}

fn cache_lookup(account: &str) -> Option<Option<String>> {
    os_cache().lock().unwrap_or_else(|e| e.into_inner()).get(account).cloned()
}

fn cache_put(account: &str, key: Option<String>) {
    os_cache()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(account.to_string(), key);
}

fn cache_forget(account: &str) {
    os_cache().lock().unwrap_or_else(|e| e.into_inner()).remove(account);
}

fn entry(account: &str) -> Result<Entry, AiError> {
    Entry::new(SERVICE, account).map_err(store_error)
}

fn store_error(e: Error) -> AiError {
    AiError::other(format!("keychain: {e}"))
}

fn os_get(account: &str) -> Result<Option<String>, AiError> {
    let _op = os_lock();
    if let Some(hit) = cache_lookup(account) {
        return Ok(hit);
    }
    let key = match entry(account)?.get_password() {
        Ok(key) => Some(key),
        Err(Error::NoEntry) => None,
        Err(e) => return Err(store_error(e)),
    };
    cache_put(account, key.clone());
    Ok(key)
}

fn os_set(account: &str, key: &str) -> Result<(), AiError> {
    let key = trimmed(key)?;
    let _op = os_lock();
    match entry(account).and_then(|e| e.set_password(key).map_err(store_error)) {
        Ok(()) => {
            cache_put(account, Some(key.to_string()));
            Ok(())
        }
        Err(e) => {
            // The item's state is unknown now; read it again next time.
            cache_forget(account);
            Err(e)
        }
    }
}

fn os_delete(account: &str) -> Result<(), AiError> {
    let _op = os_lock();
    let result = entry(account).and_then(|e| match e.delete_credential() {
        Ok(()) | Err(Error::NoEntry) => Ok(()),
        Err(e) => Err(store_error(e)),
    });
    match &result {
        Ok(()) => cache_put(account, None),
        Err(_) => cache_forget(account),
    }
    result
}

// --- Key file (debug builds) ---------------------------------------------

fn key_file() -> PathBuf {
    if let Some(path) = std::env::var_os("MIDTERM_KEYS_FILE").filter(|p| !p.is_empty()) {
        return PathBuf::from(path);
    }
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
    home.join(".config/midterm-dev/keys.json")
}

fn file_error(path: &Path, e: impl std::fmt::Display) -> AiError {
    AiError::other(format!("key file {}: {e}", path.display()))
}

#[cfg(unix)]
mod file {
    //! The key file's I/O. Every access holds an exclusive `flock` on a
    //! sidecar `<file>.lock`, so read-modify-write is safe across app
    //! instances. The directory must belong to the user and not be writable
    //! by others; the file is opened without following symlinks, checked
    //! through the open handle (owner, mode 600), and replaced atomically
    //! from a `tempfile` (created exclusively, mode 600) in the same
    //! directory.

    use std::collections::HashMap;
    use std::fs::{File, OpenOptions};
    use std::io::{Read, Write};
    use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
    use std::os::unix::io::AsRawFd;
    use std::path::Path;

    use super::{file_error, AiError};

    fn uid() -> u32 {
        // SAFETY: geteuid has no preconditions and cannot fail.
        unsafe { libc::geteuid() }
    }

    fn dir_of(path: &Path) -> &Path {
        path.parent().filter(|d| !d.as_os_str().is_empty()).unwrap_or(Path::new("."))
    }

    /// Creates the directory (700) if needed and checks it is the user's and
    /// not writable by group or others.
    fn ensure_dir(path: &Path) -> Result<(), AiError> {
        let dir = dir_of(path);
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(dir)
            .map_err(|e| file_error(path, e))?;
        let meta = std::fs::metadata(dir).map_err(|e| file_error(path, e))?;
        if meta.uid() != uid() || meta.mode() & 0o022 != 0 {
            return Err(file_error(
                path,
                format!("its folder {} must be yours and not writable by others (chmod 700)", dir.display()),
            ));
        }
        Ok(())
    }

    /// An exclusive lock on `<file>.lock`, released when dropped.
    pub struct Lock(#[allow(dead_code)] File);

    pub fn lock(path: &Path) -> Result<Lock, AiError> {
        ensure_dir(path)?;
        let mut name = path.as_os_str().to_owned();
        name.push(".lock");
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&name)
            .map_err(|e| file_error(path, e))?;
        // SAFETY: the fd is valid for the life of `file`.
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) } != 0 {
            return Err(file_error(path, std::io::Error::last_os_error()));
        }
        Ok(Lock(file))
    }

    /// The stored keys. A missing file, or one that is empty, is an empty
    /// store; anything else that is not a JSON object of strings is an
    /// error, so a later write never overwrites it.
    pub fn read(path: &Path, _lock: &Lock) -> Result<HashMap<String, String>, AiError> {
        let mut file = match OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW).open(path) {
            Ok(file) => file,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(HashMap::new()),
            Err(e) => return Err(file_error(path, e)),
        };
        let meta = file.metadata().map_err(|e| file_error(path, e))?;
        if !meta.is_file() || meta.uid() != uid() {
            return Err(file_error(path, "must be a regular file owned by you"));
        }
        if meta.mode() & 0o077 != 0 {
            return Err(file_error(path, "is readable by other users; run chmod 600 on it"));
        }
        let mut text = String::new();
        file.read_to_string(&mut text).map_err(|e| file_error(path, e))?;
        if text.trim().is_empty() {
            return Ok(HashMap::new());
        }
        serde_json::from_str(&text).map_err(|e| file_error(path, e))
    }

    pub fn write(path: &Path, keys: &HashMap<String, String>, _lock: &Lock) -> Result<(), AiError> {
        let mut sorted: Vec<_> = keys.iter().collect();
        sorted.sort();
        let map: serde_json::Map<String, serde_json::Value> = sorted
            .into_iter()
            .map(|(k, v)| (k.clone(), serde_json::Value::String(v.clone())))
            .collect();
        let mut text = serde_json::to_string_pretty(&map).map_err(|e| file_error(path, e))?;
        text.push('\n');
        let mut tmp = tempfile::Builder::new()
            .prefix(".keys-")
            .tempfile_in(dir_of(path))
            .map_err(|e| file_error(path, e))?;
        // Exactly 600 whatever the umask.
        tmp.as_file()
            .set_permissions(std::fs::Permissions::from_mode(0o600))
            .map_err(|e| file_error(path, e))?;
        tmp.write_all(text.as_bytes()).map_err(|e| file_error(path, e))?;
        tmp.as_file().sync_all().map_err(|e| file_error(path, e))?;
        tmp.persist(path).map_err(|e| file_error(path, e.error))?;
        Ok(())
    }
}

#[cfg(not(unix))]
mod file {
    use std::collections::HashMap;
    use std::path::Path;

    use super::{file_error, AiError};

    pub struct Lock;

    pub fn lock(path: &Path) -> Result<Lock, AiError> {
        Err(file_error(path, "the key file is only supported on Unix"))
    }

    pub fn read(_: &Path, _: &Lock) -> Result<HashMap<String, String>, AiError> {
        unreachable!("lock() always fails")
    }

    pub fn write(_: &Path, _: &HashMap<String, String>, _: &Lock) -> Result<(), AiError> {
        unreachable!("lock() always fails")
    }
}

fn file_set(path: &Path, account: &str, key: &str) -> Result<(), AiError> {
    let key = trimmed(key)?;
    let lock = file::lock(path)?;
    let mut keys = file::read(path, &lock)?;
    keys.insert(account.to_string(), key.to_string());
    file::write(path, &keys, &lock)
}

fn file_delete(path: &Path, account: &str) -> Result<(), AiError> {
    let lock = file::lock(path)?;
    let mut keys = file::read(path, &lock)?;
    if keys.remove(account).is_some() {
        file::write(path, &keys, &lock)?;
    }
    Ok(())
}

fn file_get(path: &Path, account: &str) -> Result<Option<String>, AiError> {
    let lock = file::lock(path)?;
    Ok(file::read(path, &lock)?.remove(account))
}

// --- Public API ----------------------------------------------------------

pub fn set(account: &str, key: &str) -> Result<(), AiError> {
    match store() {
        Store::Memory => mem_set(memory(), account, key),
        Store::File => file_set(&key_file(), account, key),
        Store::Os => os_set(account, key),
    }
}

/// Deletes the key; deleting a key that is not there is not an error.
pub fn delete(account: &str) -> Result<(), AiError> {
    match store() {
        Store::Memory => {
            mem_delete(memory(), account);
            Ok(())
        }
        Store::File => file_delete(&key_file(), account),
        Store::Os => os_delete(account),
    }
}

pub fn get(account: &str) -> Result<Option<String>, AiError> {
    match store() {
        Store::Memory => Ok(mem_get(memory(), account)),
        Store::File => file_get(&key_file(), account),
        Store::Os => os_get(account),
    }
}

pub fn is_set(account: &str) -> Result<bool, AiError> {
    get(account).map(|k| k.is_some())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selection() {
        assert_eq!(select_store(false, false, None), Store::Os);
        assert_eq!(select_store(true, false, None), Store::Memory);
        assert_eq!(select_store(true, false, Some("os")), Store::Os);
        assert_eq!(select_store(false, false, Some("memory")), Store::Memory);
        assert_eq!(select_store(true, false, Some(" OS ")), Store::Os);
        assert_eq!(select_store(false, false, Some("bogus")), Store::Os);
        assert_eq!(select_store(true, false, Some("")), Store::Memory);
        // `file` only where allowed (debug builds); otherwise the default.
        assert_eq!(select_store(false, true, Some("file")), Store::File);
        assert_eq!(select_store(false, true, Some(" File")), Store::File);
        assert_eq!(select_store(false, false, Some("file")), Store::Os);
        assert_eq!(select_store(true, false, Some("file")), Store::Memory);
    }

    #[test]
    fn memory_store() {
        let map = Memory::default();
        assert!(mem_set(&map, "a", "  ").is_err());
        assert_eq!(mem_get(&map, "a"), None);
        mem_set(&map, "a", "  secret ").unwrap();
        assert_eq!(mem_get(&map, "a").as_deref(), Some("secret"));
        mem_set(&map, "a", "other").unwrap();
        assert_eq!(mem_get(&map, "a").as_deref(), Some("other"));
        mem_delete(&map, "a");
        assert_eq!(mem_get(&map, "a"), None);
        mem_delete(&map, "a");
    }

    #[cfg(unix)]
    #[test]
    fn file_store() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested/keys.json");

        assert_eq!(file_get(&path, "openai").unwrap(), None);
        file_delete(&path, "openai").unwrap();
        assert!(file_set(&path, "openai", "  ").is_err());

        file_set(&path, "openai", " sk-one ").unwrap();
        file_set(&path, "custom:http://localhost:1234/v1", "local").unwrap();
        assert_eq!(file_get(&path, "openai").unwrap().as_deref(), Some("sk-one"));
        assert_eq!(
            file_get(&path, "custom:http://localhost:1234/v1").unwrap().as_deref(),
            Some("local")
        );

        let mode = |p: &std::path::Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&path), 0o600);
        assert_eq!(mode(path.parent().unwrap()), 0o700);
        let mut names: Vec<_> = std::fs::read_dir(path.parent().unwrap())
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        names.sort();
        assert_eq!(names, ["keys.json", "keys.json.lock"], "no temp file left");

        file_delete(&path, "openai").unwrap();
        assert_eq!(file_get(&path, "openai").unwrap(), None);
        assert_eq!(
            file_get(&path, "custom:http://localhost:1234/v1").unwrap().as_deref(),
            Some("local")
        );

        // A file others can read is refused rather than used.
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        let err = file_get(&path, "custom:http://localhost:1234/v1").unwrap_err();
        assert!(err.message.contains("chmod 600"), "{}", err.message);

        // Malformed JSON is an error, not an empty store that a write would overwrite.
        std::fs::write(&path, "{not json").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert!(file_get(&path, "openai").is_err());
        assert!(file_set(&path, "openai", "x").is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{not json");

        // A symlink in place of the file is not followed.
        std::fs::remove_file(&path).unwrap();
        let target = dir.path().join("elsewhere.json");
        std::fs::write(&target, "{}").unwrap();
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o600)).unwrap();
        std::os::unix::fs::symlink(&target, &path).unwrap();
        assert!(file_get(&path, "openai").is_err());

        // A folder others can write to is refused.
        let loose = dir.path().join("loose");
        std::fs::create_dir(&loose).unwrap();
        std::fs::set_permissions(&loose, std::fs::Permissions::from_mode(0o777)).unwrap();
        let err = file_set(&loose.join("keys.json"), "openai", "x").unwrap_err();
        assert!(err.message.contains("chmod 700"), "{}", err.message);
    }
}
