//! Workspace secrets: environment variables whose values live in the OS
//! credential store (see [`crate::ai::keys`], which also provides the
//! memory and file stores for development builds).
//!
//! An account is `secret/<scope>/<NAME>` (scope: `default` or a workspace
//! id). The webview can set, delete and ask whether a secret is set; **no
//! command returns a value**. The only way a value leaves the store is
//! [`resolve`], which `pty_spawn` uses to put it into the environment of a
//! new shell. Every command rejects accounts outside `secret/`, so they can
//! never reach the AI provider keys sharing the store.
//!
//! The store calls can block (the OS may show a prompt), so the commands
//! run them on the blocking pool. `pty_spawn` runs on the main thread and
//! must not wait for a prompt: the webview calls [`secrets_warm`] first, which
//! fills the store's per-launch cache.

use serde::Deserialize;

use crate::ai::keys;

/// Prefix of every secret's account in the key store.
pub const PREFIX: &str = "secret/";

/// A secret to put in a new shell's environment as `name`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretVar {
    pub name: String,
    pub account: String,
}

fn check_account(account: &str) -> Result<(), String> {
    if account.len() > PREFIX.len() && account.starts_with(PREFIX) && !account.contains('\0') {
        Ok(())
    } else {
        Err("not a secret account".into())
    }
}

async fn blocking<T: Send + 'static>(
    job: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(job)
        .await
        .map_err(|e| format!("background task failed: {e}"))?
}

fn message(error: crate::ai::AiError) -> String {
    error.message
}

/// Stores `value` for `account`, replacing any earlier one.
#[tauri::command]
pub async fn secret_set(account: String, value: String) -> Result<(), String> {
    check_account(&account)?;
    if value.trim().is_empty() {
        return Err("the secret is empty".into());
    }
    blocking(move || keys::set(&account, &value).map_err(message)).await
}

/// Deletes the secret; one that is not there is not an error.
#[tauri::command]
pub async fn secret_delete(account: String) -> Result<(), String> {
    check_account(&account)?;
    blocking(move || keys::delete(&account).map_err(message)).await
}

/// Whether each account has a value, in the order given.
#[tauri::command]
pub async fn secret_status(accounts: Vec<String>) -> Result<Vec<bool>, String> {
    for account in &accounts {
        check_account(account)?;
    }
    blocking(move || {
        accounts
            .iter()
            .map(|account| keys::is_set(account).map_err(message))
            .collect()
    })
    .await
}

/// Reads each account into the key store's cache, so that a `pty_spawn`
/// right after does not block the main thread on a credential prompt.
/// Failures are ignored: `pty_spawn` skips what it cannot read.
#[tauri::command]
pub async fn secrets_warm(accounts: Vec<String>) -> Result<(), String> {
    blocking(move || {
        for account in accounts.iter().filter(|a| check_account(a).is_ok()) {
            let _ = keys::get(account);
        }
        Ok(())
    })
    .await
}

/// The environment variables for `secrets`, reading each value with
/// `lookup`. A secret that is missing, unreadable or outside `secret/` is
/// skipped (the log names it, never the value).
pub fn resolve(
    secrets: &[SecretVar],
    lookup: impl Fn(&str) -> Option<String>,
) -> Vec<(String, String)> {
    secrets
        .iter()
        .filter_map(|secret| {
            if check_account(&secret.account).is_err() {
                eprintln!("secrets: {}: not a secret account, skipped", secret.name);
                return None;
            }
            match lookup(&secret.account) {
                Some(value) => Some((secret.name.clone(), value)),
                None => {
                    eprintln!("secrets: {}: no value, skipped", secret.name);
                    None
                }
            }
        })
        .collect()
}

/// [`resolve`] against the key store's cache, filled by [`secrets_warm`].
/// Never asks the OS store itself: `pty_spawn` runs on the main thread, and
/// a prompt the user denied during the warm-up must not come back there. A
/// secret the warm-up could not read is skipped.
pub fn resolve_from_store(secrets: &[SecretVar]) -> Vec<(String, String)> {
    resolve(secrets, |account| match keys::get_cached(account) {
        Some(value) => value,
        None => {
            eprintln!("secrets: a secret could not be read from the key store (access denied?)");
            None
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn var(name: &str, account: &str) -> SecretVar {
        SecretVar { name: name.into(), account: account.into() }
    }

    #[test]
    fn only_secret_accounts_are_accepted() {
        assert!(check_account("secret/default/TOKEN").is_ok());
        assert!(check_account("secret/w-1/A").is_ok());
        for bad in ["", "secret/", "openai", "custom:https://x", "Secret/a/b", "x/secret/a", "secret/a\0"] {
            assert!(check_account(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn resolve_skips_missing_and_foreign_accounts() {
        let secrets = [
            var("A", "secret/default/A"),
            var("B", "secret/default/B"),
            var("KEY", "openai"),
        ];
        let lookup = |account: &str| match account {
            "secret/default/A" => Some("one".to_string()),
            "openai" => Some("sk-leak".to_string()),
            _ => None,
        };
        assert_eq!(resolve(&secrets, lookup), [("A".to_string(), "one".to_string())]);
    }

    #[test]
    fn commands_reject_foreign_accounts() {
        tauri::async_runtime::block_on(async {
            assert!(secret_set("openai".into(), "x".into()).await.is_err());
            assert!(secret_delete("custom:https://x".into()).await.is_err());
            assert!(secret_status(vec!["secret/default/A".into(), "openai".into()]).await.is_err());
            assert!(secret_set("secret/default/A".into(), "  ".into()).await.is_err());
        });
    }

    #[test]
    fn set_status_delete_round_trip() {
        // The default store in tests is the OS one, which a test must not
        // touch, so only run where the memory store is selected.
        if std::env::var("MIDTERM_KEYSTORE").as_deref() != Ok("memory") {
            return;
        }
        let account = "secret/default/MIDTERM_TEST_ROUND_TRIP";
        tauri::async_runtime::block_on(async {
            secret_set(account.into(), "v".into()).await.unwrap();
            assert_eq!(secret_status(vec![account.into()]).await.unwrap(), [true]);
            secrets_warm(vec![account.into(), "openai".into()]).await.unwrap();
            secret_delete(account.into()).await.unwrap();
            assert_eq!(secret_status(vec![account.into()]).await.unwrap(), [false]);
        });
    }
}
