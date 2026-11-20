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
use std::path::PathBuf;
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
/// cached, so a denied prompt is asked again next time.
type OsCache = Mutex<HashMap<String, Option<String>>>;

fn os_cache() -> &'static OsCache {
    static CACHE: OnceLock<OsCache> = OnceLock::new();
    CACHE.get_or_init(Default::default)
}

fn cache_put(account: &str, key: Option<String>) {
    os_cache()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(account.to_string(), key);
}

fn entry(account: &str) -> Result<Entry, AiError> {
    Entry::new(SERVICE, account).map_err(store_error)
}

fn store_error(e: Error) -> AiError {
    AiError::other(format!("keychain: {e}"))
}

fn os_get(account: &str) -> Result<Option<String>, AiError> {
    if let Some(hit) = os_cache().lock().unwrap_or_else(|e| e.into_inner()).get(account) {
        return Ok(hit.clone());
    }
    let key = match entry(account)?.get_password() {
        Ok(key) => Some(key),
        Err(Error::NoEntry) => None,
        Err(e) => return Err(store_error(e)),
    };
    cache_put(account, key.clone());
    Ok(key)
}

// --- Key file (debug builds) ---------------------------------------------

fn key_file() -> PathBuf {
    if let Some(path) = std::env::var_os("MIDTERM_KEYS_FILE").filter(|p| !p.is_empty()) {
        return PathBuf::from(path);
    }
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
    home.join(".config/midterm-dev/keys.json")
}

/// Serializes read-modify-write of the key file within this process.
fn file_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(Default::default)
}

fn file_error(path: &std::path::Path, e: impl std::fmt::Display) -> AiError {
    AiError::other(format!("key file {}: {e}", path.display()))
}

#[cfg(unix)]
fn file_read(path: &std::path::Path) -> Result<HashMap<String, String>, AiError> {
    use std::os::unix::fs::MetadataExt;
    let meta = match std::fs::metadata(path) {
        Ok(meta) => meta,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(HashMap::new()),
        Err(e) => return Err(file_error(path, e)),
    };
    if meta.mode() & 0o077 != 0 {
        return Err(file_error(path, "is readable by other users; run chmod 600 on it"));
    }
    let text = std::fs::read_to_string(path).map_err(|e| file_error(path, e))?;
    if text.trim().is_empty() {
        return Ok(HashMap::new());
    }
    serde_json::from_str(&text).map_err(|e| file_error(path, e))
}

#[cfg(unix)]
fn file_write(path: &std::path::Path, keys: &HashMap<String, String>) -> Result<(), AiError> {
    use std::io::Write;
    use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
    let dir = path.parent().filter(|d| !d.as_os_str().is_empty()).unwrap_or(std::path::Path::new("."));
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)
        .map_err(|e| file_error(path, e))?;
    let mut sorted: Vec<_> = keys.iter().collect();
    sorted.sort();
    let map: serde_json::Map<String, serde_json::Value> = sorted
        .into_iter()
        .map(|(k, v)| (k.clone(), serde_json::Value::String(v.clone())))
        .collect();
    let text = serde_json::to_string_pretty(&map).map_err(|e| file_error(path, e))?;
    let tmp = path.with_extension(format!("tmp{}", std::process::id()));
    let result = (|| {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&tmp)?;
        file.write_all(text.as_bytes())?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        std::fs::rename(&tmp, path)
    })();
    if let Err(e) = result {
        let _ = std::fs::remove_file(&tmp);
        return Err(file_error(path, e));
    }
    Ok(())
}

#[cfg(not(unix))]
fn file_read(path: &std::path::Path) -> Result<HashMap<String, String>, AiError> {
    Err(file_error(path, "the key file is only supported on Unix"))
}

#[cfg(not(unix))]
fn file_write(path: &std::path::Path, _: &HashMap<String, String>) -> Result<(), AiError> {
    Err(file_error(path, "the key file is only supported on Unix"))
}

fn file_set(path: &std::path::Path, account: &str, key: &str) -> Result<(), AiError> {
    let key = trimmed(key)?;
    let _guard = file_lock().lock().unwrap_or_else(|e| e.into_inner());
    let mut keys = file_read(path)?;
    keys.insert(account.to_string(), key.to_string());
    file_write(path, &keys)
}

fn file_delete(path: &std::path::Path, account: &str) -> Result<(), AiError> {
    let _guard = file_lock().lock().unwrap_or_else(|e| e.into_inner());
    let mut keys = file_read(path)?;
    if keys.remove(account).is_some() {
        file_write(path, &keys)?;
    }
    Ok(())
}

fn file_get(path: &std::path::Path, account: &str) -> Result<Option<String>, AiError> {
    let _guard = file_lock().lock().unwrap_or_else(|e| e.into_inner());
    Ok(file_read(path)?.remove(account))
}

// --- Public API ----------------------------------------------------------

pub fn set(account: &str, key: &str) -> Result<(), AiError> {
    match store() {
        Store::Memory => mem_set(memory(), account, key),
        Store::File => file_set(&key_file(), account, key),
        Store::Os => {
            let key = trimmed(key)?;
            entry(account)?.set_password(key).map_err(store_error)?;
            cache_put(account, Some(key.to_string()));
            Ok(())
        }
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
        Store::Os => {
            match entry(account)?.delete_credential() {
                Ok(()) | Err(Error::NoEntry) => {}
                Err(e) => return Err(store_error(e)),
            }
            cache_put(account, None);
            Ok(())
        }
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
        assert!(std::fs::read_dir(path.parent().unwrap()).unwrap().count() == 1, "no temp file left");

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
    }
}
