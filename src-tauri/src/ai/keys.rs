//! API keys in the OS credential store (Keychain on macOS, Credential
//! Manager on Windows, Secret Service on Linux) through `keyring`. One entry
//! per provider: service [`SERVICE`], account = the provider id.
//!
//! Keys are never written to settings files, and no command returns one to
//! the webview: it can set, delete and ask whether one is set. These calls
//! can block (the OS may show a prompt), so callers run them on the
//! blocking pool.

use keyring::{Entry, Error};

use super::error::AiError;
use super::provider::ProviderId;

pub const SERVICE: &str = "com.ron.midterm.ai";

fn entry(provider: ProviderId) -> Result<Entry, AiError> {
    if !provider.uses_key() {
        return Err(AiError::other(format!(
            "{} does not use an API key",
            provider.as_str()
        )));
    }
    Entry::new(SERVICE, provider.as_str()).map_err(store_error)
}

fn store_error(e: Error) -> AiError {
    AiError::other(format!("keychain: {e}"))
}

pub fn set(provider: ProviderId, key: &str) -> Result<(), AiError> {
    let key = key.trim();
    if key.is_empty() {
        return Err(AiError::other("the key is empty"));
    }
    entry(provider)?.set_password(key).map_err(store_error)
}

/// Deletes the key; deleting a key that is not there is not an error.
pub fn delete(provider: ProviderId) -> Result<(), AiError> {
    match entry(provider)?.delete_credential() {
        Ok(()) | Err(Error::NoEntry) => Ok(()),
        Err(e) => Err(store_error(e)),
    }
}

pub fn get(provider: ProviderId) -> Result<Option<String>, AiError> {
    match entry(provider)?.get_password() {
        Ok(key) => Ok(Some(key)),
        Err(Error::NoEntry) => Ok(None),
        Err(e) => Err(store_error(e)),
    }
}

pub fn is_set(provider: ProviderId) -> Result<bool, AiError> {
    get(provider).map(|k| k.is_some())
}
