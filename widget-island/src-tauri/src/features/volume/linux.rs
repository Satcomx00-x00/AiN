//! PulseAudio, as served by PipeWire on current distributions, through `pactl`. A `pactl subscribe`
//! child reports changes, so the sinks are only re-read when something actually changed.

use std::{
    collections::BTreeMap,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

use serde_json::Value;

use super::{
    Backend, Change, Output, Source, SourceKind,
    mixer::{app_identity, round_level, sort},
};
use crate::platform::linux::pactl::{self, Subscription};

/// What the sound server looks like, re-read after each change.
#[derive(Debug, Default)]
pub struct Snapshot {
    pub default: String,
    pub sinks: Vec<Value>,
    pub inputs: Vec<Value>,
}

impl Snapshot {
    fn read() -> Option<Self> {
        Some(Self {
            default: pactl::run(&["get-default-sink"])?.trim().to_string(),
            sinks: pactl::list("sinks"),
            inputs: pactl::list("sink-inputs"),
        })
    }

    /// The default output device.
    pub fn output(&self) -> Option<Output> {
        let sink = self.sinks.iter().find(|s| name(s) == Some(self.default.as_str()))?;
        Some(Output { level: round_level(pactl::level(sink)), muted: pactl::flag(sink, "mute"), device: description(sink) })
    }

    /// Every output device, then every app playing (its streams together), ours excluded.
    pub fn sources(&self, own_pid: u32) -> Vec<Source> {
        let mut out: Vec<Source> = self
            .sinks
            .iter()
            .filter_map(|s| {
                let id = name(s)?;
                Some(Source {
                    id: format!("device:{id}"),
                    kind: SourceKind::Device,
                    name: description(s),
                    level: round_level(pactl::level(s)),
                    muted: pactl::flag(s, "mute"),
                    default: id == self.default,
                    active: true,
                })
            })
            .collect();
        let mut apps: BTreeMap<String, Source> = BTreeMap::new();
        for input in self.inputs.iter().filter(|i| pid(i) != Some(own_pid)) {
            let Some((id, label)) = app_of(input) else { continue };
            let active = !pactl::flag(input, "corked");
            apps.entry(id.clone()).and_modify(|a| a.active |= active).or_insert(Source {
                id,
                kind: SourceKind::App,
                name: label,
                level: round_level(pactl::level(input)),
                muted: pactl::flag(input, "mute"),
                default: false,
                active,
            });
        }
        out.extend(apps.into_values());
        sort(&mut out);
        out
    }

    /// Stream indexes of the app with id `id`.
    pub fn streams_of(&self, id: &str) -> Vec<String> {
        self.inputs
            .iter()
            .filter(|i| app_of(i).is_some_and(|(app, _)| app == id))
            .filter_map(|i| i.get("index").and_then(Value::as_u64).map(|n| n.to_string()))
            .collect()
    }
}

fn name(sink: &Value) -> Option<&str> {
    sink.get("name").and_then(Value::as_str)
}

fn description(sink: &Value) -> String {
    sink.get("description").and_then(Value::as_str).or_else(|| name(sink)).unwrap_or_default().to_string()
}

fn pid(input: &Value) -> Option<u32> {
    pactl::property(input, "application.process.id")?.parse().ok()
}

/// An app's id and label from its stream: the program when known, else the name it gives.
pub fn app_of(input: &Value) -> Option<(String, String)> {
    let program = pactl::property(input, "application.process.binary");
    let named = pactl::property(input, "application.name");
    match (program, named) {
        (Some(program), named) => {
            let (id, label) = app_identity(program);
            Some((id, named.map_or(label, str::to_string)))
        }
        (None, Some(named)) => Some((format!("app:{}", named.to_lowercase()), named.to_string())),
        (None, None) => None,
    }
}

pub struct Pulse {
    subscription: Subscription,
    /// Set by the subscription when the server reports a change to sinks or their streams.
    events: Arc<AtomicBool>,
    snapshot: Snapshot,
}

impl Pulse {
    pub fn new() -> Option<Self> {
        let events = Arc::new(AtomicBool::new(true));
        let flag = Arc::clone(&events);
        let subscription = Subscription::start(move |line| {
            if line.contains("sink") || line.contains("server") {
                flag.store(true, Ordering::SeqCst);
            }
        })
        .ok()?;
        let snapshot = Snapshot::read()?;
        Some(Self { subscription, events, snapshot })
    }

    /// Re-reads the server if it reported a change since last time.
    fn update(&mut self) {
        if self.events.swap(false, Ordering::SeqCst)
            && let Some(s) = Snapshot::read()
        {
            self.snapshot = s;
        }
    }
}

impl Backend for Pulse {
    fn read(&mut self) -> Option<(Output, f32)> {
        self.update();
        // PulseAudio has no cheap peak meter (it takes a recording stream), so the level is all.
        Some((self.snapshot.output()?, 0.0))
    }

    fn sources(&mut self) -> Vec<Source> {
        self.update();
        self.snapshot.sources(std::process::id())
    }

    fn apply(&mut self, source: Option<&str>, change: Change) {
        let (what, value) = match change {
            Change::Level(level) => ("volume", pactl::percent(level)),
            Change::Muted(muted) => ("mute", if muted { "1" } else { "0" }.to_string()),
        };
        let set = |kind: &str, target: &str| _ = pactl::run(&[&format!("set-{kind}-{what}"), target, &value]);
        match source {
            None => set("sink", "@DEFAULT_SINK@"),
            Some(id) => match id.strip_prefix("device:") {
                Some(sink) => set("sink", sink),
                None => self.snapshot.streams_of(id).iter().for_each(|index| set("sink-input", index)),
            },
        }
        self.events.store(true, Ordering::SeqCst);
    }

    fn refresh(&mut self) -> bool {
        self.subscription.alive()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn snapshot() -> Snapshot {
        let vol = |v: u32| json!({ "front-left": { "value": v }, "front-right": { "value": v } });
        Snapshot {
            default: "alsa_output.usb-headset".into(),
            sinks: vec![
                json!({ "index": 1, "name": "alsa_output.pci-speakers", "description": "Built-in Speakers", "mute": false, "volume": vol(65536) }),
                json!({ "index": 2, "name": "alsa_output.usb-headset", "description": "USB Headset", "mute": true, "volume": vol(32768) }),
            ],
            inputs: vec![
                json!({ "index": 40, "corked": false, "mute": false, "volume": vol(45875),
                        "properties": { "application.name": "Spotify", "application.process.binary": "spotify", "application.process.id": "100" } }),
                json!({ "index": 41, "corked": true, "mute": false, "volume": vol(65536),
                        "properties": { "application.name": "Firefox", "application.process.binary": "firefox", "application.process.id": "200" } }),
                json!({ "index": 42, "corked": false, "mute": false, "volume": vol(65536),
                        "properties": { "application.name": "Firefox", "application.process.binary": "firefox", "application.process.id": "200" } }),
                json!({ "index": 43, "corked": false, "mute": false, "volume": vol(65536),
                        "properties": { "application.name": "Island", "application.process.binary": "widget", "application.process.id": "999" } }),
            ],
        }
    }

    #[test]
    fn reads_the_default_output() {
        assert_eq!(snapshot().output(), Some(Output { level: 0.5, muted: true, device: "USB Headset".into() }));
    }

    #[test]
    fn lists_devices_then_apps_without_our_own_streams() {
        let sources = snapshot().sources(999);
        let ids: Vec<&str> = sources.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids, ["device:alsa_output.usb-headset", "device:alsa_output.pci-speakers", "app:firefox", "app:spotify"]);
        let firefox = &sources[2];
        assert!(firefox.active, "one of Firefox's two streams plays");
        assert_eq!(firefox.name, "Firefox");
        assert_eq!(sources[3].level, 0.7);
    }

    #[test]
    fn finds_every_stream_of_an_app() {
        assert_eq!(snapshot().streams_of("app:firefox"), ["41", "42"]);
        assert!(snapshot().streams_of("app:zoom").is_empty());
    }

    #[test]
    fn names_streams_without_a_program() {
        let input = json!({ "properties": { "application.name": "Speech Dispatcher" } });
        assert_eq!(app_of(&input), Some(("app:speech dispatcher".into(), "Speech Dispatcher".into())));
        assert_eq!(app_of(&json!({})), None);
    }
}
