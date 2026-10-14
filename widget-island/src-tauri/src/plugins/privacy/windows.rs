//! Windows records each app's microphone and camera sessions under the Capability Access
//! Manager's consent store; a session with a start time but no stop time is ongoing.

use std::collections::BTreeSet;

use winreg::{
    HKEY, RegKey,
    enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE},
};

use super::{Usage, app_label, in_use};

const STORE: &str = r"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore";
const DESKTOP_APPS: &str = "NonPackaged";
const HIVES: [HKEY; 2] = [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE];

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
    #[test]
    #[ignore = "reads this machine's live registry"]
    fn smoke_reads_usage() {
        println!("usage: {:?}", super::read());
    }
}
