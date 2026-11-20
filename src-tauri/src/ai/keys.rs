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
//! blocking pool.
//!
//! Builds with the `tauri-mcp` feature (`bun run dev:mcp`) keep keys in
//! memory instead, so an agent-driven instance never touches the developer's
//! Keychain. `MIDTERM_KEYSTORE=os` opts back into the OS store and
//! `MIDTERM_KEYSTORE=memory` forces memory in any build.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use keyring::{Entry, Error};

use super::error::AiError;

pub const SERVICE: &str = "com.ron.midterm.ai";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Store {
    Os,
    Memory,
}

/// Which store to use: `MIDTERM_KEYSTORE` (`os` or `memory`) wins, otherwise
/// memory for `tauri-mcp` builds and the OS store for the rest.
pub fn select_store(mcp_feature: bool, env: Option<&str>) -> Store {
    match env.map(|v| v.trim().to_ascii_lowercase()).as_deref() {
        Some("os") => Store::Os,
        Some("memory") => Store::Memory,
        _ if mcp_feature => Store::Memory,
        _ => Store::Os,
    }
}

fn store() -> Store {
    static STORE: OnceLock<Store> = OnceLock::new();
    *STORE.get_or_init(|| {
        let env = std::env::var("MIDTERM_KEYSTORE").ok();
        let chosen = select_store(cfg!(feature = "tauri-mcp"), env.as_deref());
        eprintln!("ai keys: using the {chosen:?} store");
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

fn mem_set(map: &Memory, account: &str, key: &str) -> Result<(), AiError> {
    let key = key.trim();
    if key.is_empty() {
        return Err(AiError::other("the key is empty"));
    }
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

fn entry(account: &str) -> Result<Entry, AiError> {
    Entry::new(SERVICE, account).map_err(store_error)
}

fn store_error(e: Error) -> AiError {
    AiError::other(format!("keychain: {e}"))
}

pub fn set(account: &str, key: &str) -> Result<(), AiError> {
    if store() == Store::Memory {
        return mem_set(memory(), account, key);
    }
    let key = key.trim();
    if key.is_empty() {
        return Err(AiError::other("the key is empty"));
    }
    entry(account)?.set_password(key).map_err(store_error)
}

/// Deletes the key; deleting a key that is not there is not an error.
pub fn delete(account: &str) -> Result<(), AiError> {
    if store() == Store::Memory {
        mem_delete(memory(), account);
        return Ok(());
    }
    match entry(account)?.delete_credential() {
        Ok(()) | Err(Error::NoEntry) => Ok(()),
        Err(e) => Err(store_error(e)),
    }
}

pub fn get(account: &str) -> Result<Option<String>, AiError> {
    if store() == Store::Memory {
        return Ok(mem_get(memory(), account));
    }
    match entry(account)?.get_password() {
        Ok(key) => Ok(Some(key)),
        Err(Error::NoEntry) => Ok(None),
        Err(e) => Err(store_error(e)),
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
        assert_eq!(select_store(false, None), Store::Os);
        assert_eq!(select_store(true, None), Store::Memory);
        assert_eq!(select_store(true, Some("os")), Store::Os);
        assert_eq!(select_store(false, Some("memory")), Store::Memory);
        assert_eq!(select_store(true, Some(" OS ")), Store::Os);
        assert_eq!(select_store(false, Some("bogus")), Store::Os);
        assert_eq!(select_store(true, Some("")), Store::Memory);
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
}
