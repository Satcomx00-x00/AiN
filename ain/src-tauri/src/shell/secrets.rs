//! Plugins' secrets (API keys, tokens): kept in the system's credential store (Windows Credential
//! Manager, the macOS Keychain, the Secret Service on Linux), never in `settings.json`. Each one
//! belongs to a plugin's option, `<plugin id>/<option key>`; an empty value removes it.

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Wry, async_runtime::spawn_blocking, plugin::TauriPlugin};
use tauri_specta::Event;

use crate::{Error, Res};

/// The credential store's service name for every secret the app keeps.
const SERVICE: &str = "dev.satcom.ain";
/// A token or a key, not a document.
const MAX_LEN: usize = 4096;

/// A secret changed in Settings: the island forgets what it read of it.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct SecretChanged {
    pub plugin: String,
    pub key: String,
}

/// Same rule as a plugin's id.
fn valid_plugin(id: &str) -> bool {
    (2..=32).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// An option's key, as a plugin names it in its `options`.
fn valid_key(key: &str) -> bool {
    (1..=64).contains(&key.len()) && key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// The credential's account name, or why the plugin or key can't name one.
fn account(plugin: &str, key: &str) -> Res<String> {
    if !valid_plugin(plugin) {
        return Err(Error::msg(format!("not a plugin id: {plugin:?}")));
    }
    if !valid_key(key) {
        return Err(Error::msg(format!("not an option key: {key:?}")));
    }
    Ok(format!("{plugin}/{key}"))
}

/// Where secrets are kept: the system's credential store in the app, memory in tests.
trait Vault: Send + Sync {
    fn get(&self, account: &str) -> Res<Option<String>>;
    fn set(&self, account: &str, value: &str) -> Res<()>;
    fn delete(&self, account: &str) -> Res<()>;
}

struct System;

fn failed(what: &str, e: keyring::Error) -> Error {
    Error::msg(format!("couldn't {what} the system's credential store: {e}"))
}

impl Vault for System {
    fn get(&self, account: &str) -> Res<Option<String>> {
        let entry = keyring::Entry::new(SERVICE, account).map_err(|e| failed("open", e))?;
        match entry.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(failed("read", e)),
        }
    }

    fn set(&self, account: &str, value: &str) -> Res<()> {
        keyring::Entry::new(SERVICE, account).and_then(|entry| entry.set_password(value)).map_err(|e| failed("write to", e))
    }

    fn delete(&self, account: &str) -> Res<()> {
        let entry = keyring::Entry::new(SERVICE, account).map_err(|e| failed("open", e))?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(failed("write to", e)),
        }
    }
}

fn read(vault: &dyn Vault, plugin: &str, key: &str) -> Res<Option<String>> {
    vault.get(&account(plugin, key)?)
}

/// Saves `value`, or removes the secret when it is empty.
fn write(vault: &dyn Vault, plugin: &str, key: &str, value: &str) -> Res<()> {
    let account = account(plugin, key)?;
    let value = value.trim();
    if value.len() > MAX_LEN {
        return Err(Error::msg(format!("a secret is at most {MAX_LEN} characters")));
    }
    if value.is_empty() { vault.delete(&account) } else { vault.set(&account, value) }
}

/// Which of `keys` have a secret saved, in order.
fn saved(vault: &dyn Vault, plugin: &str, keys: &[String]) -> Res<Vec<bool>> {
    keys.iter().map(|key| read(vault, plugin, key).map(|v| v.is_some())).collect()
}

/// The credential store can wait on D-Bus or a system prompt: kept off the IPC thread.
async fn off_thread<T: Send + 'static>(work: impl FnOnce() -> Res<T> + Send + 'static) -> Res<T> {
    spawn_blocking(work).await.map_err(|_| Error::WorkerGone)?
}

/// A plugin's secret, or `null` when none is saved. The island reads it for the plugin.
#[tauri::command]
#[specta::specta]
async fn get(plugin: String, key: String) -> Res<Option<String>> {
    off_thread(move || read(&System, &plugin, &key)).await
}

/// Saves a plugin's secret (an empty value removes it), and tells the windows it changed.
#[tauri::command]
#[specta::specta]
async fn set(app: AppHandle, plugin: String, key: String, value: String) -> Res<()> {
    let (p, k) = (plugin.clone(), key.clone());
    off_thread(move || write(&System, &p, &k, &value)).await?;
    SecretChanged { plugin, key }.emit(&app)?;
    Ok(())
}

/// Which of a plugin's secrets are saved, without reading them out: what Settings shows.
#[tauri::command]
#[specta::specta]
async fn saved_keys(plugin: String, keys: Vec<String>) -> Res<Vec<bool>> {
    off_thread(move || saved(&System, &plugin, &keys)).await
}

crate::ipc::secrets!();

pub fn init() -> TauriPlugin<Wry> {
    ipc().plugin(|_| Ok(()))
}

#[cfg(test)]
mod tests {
    use std::{collections::HashMap, sync::Mutex};

    use super::*;

    #[derive(Default)]
    struct Memory(Mutex<HashMap<String, String>>);

    impl Vault for Memory {
        fn get(&self, account: &str) -> Res<Option<String>> {
            Ok(self.0.lock().unwrap().get(account).cloned())
        }
        fn set(&self, account: &str, value: &str) -> Res<()> {
            self.0.lock().unwrap().insert(account.into(), value.into());
            Ok(())
        }
        fn delete(&self, account: &str) -> Res<()> {
            self.0.lock().unwrap().remove(account);
            Ok(())
        }
    }

    #[test]
    fn saves_reads_and_removes_a_secret() {
        let vault = Memory::default();
        assert_eq!(read(&vault, "weather", "apiKey").unwrap(), None);
        write(&vault, "weather", "apiKey", "  abc123 ").unwrap();
        assert_eq!(read(&vault, "weather", "apiKey").unwrap().as_deref(), Some("abc123"));
        assert_eq!(saved(&vault, "weather", &["apiKey".into(), "token".into()]).unwrap(), [true, false]);
        write(&vault, "weather", "apiKey", "").unwrap();
        assert_eq!(read(&vault, "weather", "apiKey").unwrap(), None);
    }

    #[test]
    fn keeps_each_plugins_secrets_apart() {
        let vault = Memory::default();
        write(&vault, "weather", "token", "a").unwrap();
        write(&vault, "github", "token", "b").unwrap();
        assert_eq!(read(&vault, "weather", "token").unwrap().as_deref(), Some("a"));
        assert_eq!(read(&vault, "github", "token").unwrap().as_deref(), Some("b"));
    }

    #[test]
    fn refuses_names_that_could_reach_another_credential() {
        let vault = Memory::default();
        assert!(write(&vault, "Weather", "token", "a").is_err());
        assert!(write(&vault, "weather", "a/b", "a").is_err());
        assert!(write(&vault, "weather", "", "a").is_err());
        assert!(read(&vault, "../x", "token").is_err());
        assert!(write(&vault, "weather", "token", &"x".repeat(MAX_LEN + 1)).is_err());
    }
}
