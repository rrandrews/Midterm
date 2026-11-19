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

use keyring::{Entry, Error};

use super::error::AiError;

pub const SERVICE: &str = "com.ron.midterm.ai";

fn entry(account: &str) -> Result<Entry, AiError> {
    Entry::new(SERVICE, account).map_err(store_error)
}

fn store_error(e: Error) -> AiError {
    AiError::other(format!("keychain: {e}"))
}

pub fn set(account: &str, key: &str) -> Result<(), AiError> {
    let key = key.trim();
    if key.is_empty() {
        return Err(AiError::other("the key is empty"));
    }
    entry(account)?.set_password(key).map_err(store_error)
}

/// Deletes the key; deleting a key that is not there is not an error.
pub fn delete(account: &str) -> Result<(), AiError> {
    match entry(account)?.delete_credential() {
        Ok(()) | Err(Error::NoEntry) => Ok(()),
        Err(e) => Err(store_error(e)),
    }
}

pub fn get(account: &str) -> Result<Option<String>, AiError> {
    match entry(account)?.get_password() {
        Ok(key) => Ok(Some(key)),
        Err(Error::NoEntry) => Ok(None),
        Err(e) => Err(store_error(e)),
    }
}

pub fn is_set(account: &str) -> Result<bool, AiError> {
    get(account).map(|k| k.is_some())
}
