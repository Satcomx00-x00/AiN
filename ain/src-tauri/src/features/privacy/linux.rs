//! Linux keeps no record of who uses the microphone or camera, so we look: apps recording are the
//! sound server's recording streams (`pactl`), apps filming are those holding a `/dev/video*`
//! device open. Only our own user's processes are visible, which is what matters here.

use std::{collections::BTreeSet, fs, path::Path};

use serde_json::Value;

use super::Usage;
use crate::platform::linux::pactl;

pub fn read() -> Usage {
    Usage { mic: recording(&pactl::list("source-outputs"), &|| pactl::list("sources")), camera: filming(Path::new("/proc")) }
}

/// Apps with a live recording stream. Streams from a speaker's monitor (visualizers, screen
/// recorders' system audio) and level meters aren't the microphone; `sources` is only read when
/// there is something to check, since usually nothing records.
pub fn recording(outputs: &[Value], sources: &dyn Fn() -> Vec<Value>) -> Vec<String> {
    if outputs.is_empty() {
        return Vec::new();
    }
    let monitors: BTreeSet<u64> = sources()
        .iter()
        .filter(|s| s.get("monitor_of_sink").and_then(Value::as_str).is_some_and(|m| m != "n/a"))
        .filter_map(|s| s.get("index").and_then(Value::as_u64))
        .collect();
    let apps: BTreeSet<String> = outputs
        .iter()
        .filter(|o| !pactl::flag(o, "corked"))
        .filter(|o| o.get("source").and_then(Value::as_u64).is_none_or(|s| !monitors.contains(&s)))
        .filter(|o| pactl::property(o, "stream.monitor") != Some("true"))
        .filter(|o| !pactl::property(o, "media.name").is_some_and(|n| n.starts_with("Peak detect")))
        .filter_map(|o| pactl::property(o, "application.name").or_else(|| pactl::property(o, "application.process.binary")))
        .map(str::to_string)
        .collect();
    apps.into_iter().collect()
}

/// `/dev/video0`, `/dev/video12`…: a string prefix, since `Path::starts_with` compares whole
/// components (and `video0` isn't `video`).
pub fn is_camera(target: &Path) -> bool {
    target.to_str().is_some_and(|t| t.starts_with("/dev/video"))
}

/// Programs holding a camera device open, by name, from a `/proc`-like folder.
pub fn filming(proc: &Path) -> Vec<String> {
    let Ok(processes) = fs::read_dir(proc) else { return Vec::new() };
    let mut apps = BTreeSet::new();
    for process in processes.flatten() {
        let dir = process.path();
        let is_pid = dir.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.bytes().all(|b| b.is_ascii_digit()));
        let Ok(fds) = fs::read_dir(dir.join("fd")) else { continue };
        let filming = is_pid && fds.flatten().any(|fd| fs::read_link(fd.path()).is_ok_and(|t| is_camera(&t)));
        if filming && let Ok(name) = fs::read_to_string(dir.join("comm")) {
            apps.insert(name.trim().to_string());
        }
    }
    apps.into_iter().collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn names_apps_recording_from_a_microphone_only() {
        let outputs = [
            json!({ "source": 5, "corked": false, "properties": { "application.name": "Discord" } }),
            json!({ "source": 5, "corked": true, "properties": { "application.name": "Zoom" } }),
            json!({ "source": 9, "corked": false, "properties": { "application.name": "OBS" } }),
            json!({ "source": 5, "corked": false, "properties": { "application.name": "pavucontrol", "media.name": "Peak detect" } }),
            json!({ "source": 5, "corked": false, "properties": { "application.name": "Discord" } }),
        ];
        let sources =
            || vec![json!({ "index": 5, "monitor_of_sink": "n/a" }), json!({ "index": 9, "monitor_of_sink": "alsa_output.speakers" })];
        assert_eq!(recording(&outputs, &sources), ["Discord"]);
    }

    #[test]
    fn recognizes_camera_devices() {
        assert!(is_camera(Path::new("/dev/video0")));
        assert!(is_camera(Path::new("/dev/video12")));
        assert!(!is_camera(Path::new("/dev/vhci")));
        assert!(!is_camera(Path::new("/tmp/dev/video0")));
    }

    #[test]
    fn skips_reading_sources_when_nothing_records() {
        assert!(recording(&[], &|| panic!("sources read for nothing")).is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn finds_processes_holding_a_camera() {
        let root = std::env::temp_dir().join(format!("island-proc-{}", std::process::id()));
        let process = |pid: &str, name: &str, target: &str| {
            let fd = root.join(pid).join("fd");
            fs::create_dir_all(&fd).unwrap();
            fs::write(root.join(pid).join("comm"), format!("{name}\n")).unwrap();
            std::os::unix::fs::symlink(target, fd.join("3")).unwrap();
        };
        process("100", "zoom", "/dev/video0");
        process("200", "bash", "/dev/pts/1");
        process("self", "zoom-alias", "/dev/video0");
        assert_eq!(filming(&root), ["zoom"]);
        fs::remove_dir_all(root).unwrap();
    }
}
