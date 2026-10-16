//! Windows records each app's microphone and camera sessions under the Capability Access
//! Manager's consent store; a session with a start time but no stop time is ongoing.

use std::collections::BTreeSet;

use winreg::{
    HKEY, RegKey,
    enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE},
};

use super::Usage;
use crate::platform::windows::exe_stem;

const STORE: &str = r"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore";
const DESKTOP_APPS: &str = "NonPackaged";
const HIVES: [HKEY; 2] = [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE];

/// A recording session is ongoing while it has started and not yet stopped.
pub fn in_use(started: u64, stopped: u64) -> bool {
    started > 0 && stopped == 0
}

/// Registry key names: packaged apps are "Publisher.Name_hash", desktop apps their exe path with
/// `#` for `\`. "Microsoft.WindowsCamera_8wekyb3d8bbwe" → "WindowsCamera", "C:#…#Zoom.exe" → "Zoom".
pub fn app_label(key: &str) -> String {
    if key.contains('#') {
        return exe_stem(key.rsplit('#').next().unwrap_or(key)).to_string();
    }
    let name = key.split('_').next().unwrap_or(key);
    name.rsplit('.').next().unwrap_or(name).into()
}

pub fn read() -> Usage {
    Usage { mic: users("microphone"), camera: users("webcam") }
}

fn users(capability: &str) -> Vec<String> {
    let mut apps = BTreeSet::new();
    for hive in HIVES {
        let Ok(key) = RegKey::predef(hive).open_subkey(format!(r"{STORE}\{capability}")) else { continue };
        collect(&key, &mut apps);
        if let Ok(desktop) = key.open_subkey(DESKTOP_APPS) {
            collect(&desktop, &mut apps);
        }
    }
    apps.into_iter().collect()
}

fn collect(key: &RegKey, apps: &mut BTreeSet<String>) {
    for name in key.enum_keys().flatten().filter(|n| n != DESKTOP_APPS) {
        let Ok(app) = key.open_subkey(&name) else { continue };
        let started: u64 = app.get_value("LastUsedTimeStart").unwrap_or(0);
        let stopped: u64 = app.get_value("LastUsedTimeStop").unwrap_or(0);
        if in_use(started, stopped) {
            apps.insert(app_label(&name));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn in_use_only_between_start_and_stop() {
        assert!(in_use(133_000, 0));
        assert!(!in_use(133_000, 133_100));
        assert!(!in_use(0, 0));
    }

    #[test]
    fn labels_packaged_and_desktop_apps() {
        assert_eq!(app_label("Microsoft.WindowsCamera_8wekyb3d8bbwe"), "WindowsCamera");
        assert_eq!(app_label(r"C:#Users#me#AppData#Roaming#Zoom#bin#Zoom.exe"), "Zoom");
        assert_eq!(app_label("C:#Tools#recorder"), "recorder");
    }

    #[test]
    #[ignore = "reads this machine's live registry"]
    fn smoke_reads_usage() {
        println!("usage: {:?}", read());
    }
}
