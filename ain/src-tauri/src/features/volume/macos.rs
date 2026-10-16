//! Core Audio's output devices. macOS has no per-app volume, so the mixer lists devices only.

use super::{
    Backend, Change, Output, Source, SourceKind,
    mixer::{round_level, sort},
};
use crate::platform::macos::audio::{
    self, Address, DEFAULT_OUTPUT, DEVICE_UID, DEVICES, MAIN, MUTE, NAME, OUTPUT, ObjectId, STREAMS, SYSTEM, VOLUME,
};

/// Devices without a main control have one per channel; the first two are the stereo pair.
const CHANNELS: [u32; 2] = [1, 2];

pub struct CoreAudio;

impl CoreAudio {
    pub fn new() -> Option<Self> {
        default_device().map(|_| Self)
    }
}

fn default_device() -> Option<ObjectId> {
    audio::get::<ObjectId>(SYSTEM, Address::global(DEFAULT_OUTPUT)).filter(|&d| d != 0)
}

fn outputs() -> Vec<ObjectId> {
    audio::objects(SYSTEM, Address::global(DEVICES))
        .into_iter()
        .filter(|&d| !audio::objects(d, Address::new(STREAMS, OUTPUT, MAIN)).is_empty())
        .collect()
}

/// The elements carrying `selector` on the output side: the main one, else each stereo channel.
fn elements(device: ObjectId, selector: u32) -> Vec<Address> {
    let main = Address::new(selector, OUTPUT, MAIN);
    if audio::has(device, main) {
        return vec![main];
    }
    CHANNELS.iter().map(|&c| Address::new(selector, OUTPUT, c)).filter(|&a| audio::has(device, a)).collect()
}

/// 0–1; full when the device has no volume control (digital outputs).
fn level(device: ObjectId) -> f32 {
    let levels: Vec<f32> = elements(device, VOLUME).into_iter().filter_map(|a| audio::get::<f32>(device, a)).collect();
    match levels.len() {
        0 => 1.0,
        n => levels.iter().sum::<f32>() / n as f32,
    }
}

fn muted(device: ObjectId) -> bool {
    elements(device, MUTE).into_iter().any(|a| audio::get::<u32>(device, a) == Some(1))
}

fn name(device: ObjectId) -> String {
    audio::string(device, Address::global(NAME)).unwrap_or_default()
}

fn uid(device: ObjectId) -> Option<String> {
    audio::string(device, Address::global(DEVICE_UID))
}

fn apply_to(device: ObjectId, change: Change) {
    match change {
        Change::Level(level) => elements(device, VOLUME).into_iter().for_each(|a| _ = audio::set(device, a, level.clamp(0.0, 1.0))),
        Change::Muted(muted) => elements(device, MUTE).into_iter().for_each(|a| _ = audio::set(device, a, u32::from(muted))),
    }
}

impl Backend for CoreAudio {
    fn read(&mut self) -> Option<(Output, f32)> {
        let device = default_device()?;
        // Core Audio has no cheap peak meter (it takes a recording tap), so the level is all.
        Some((Output { level: round_level(level(device)), muted: muted(device), device: name(device) }, 0.0))
    }

    fn sources(&mut self) -> Vec<Source> {
        let default = default_device();
        let mut out: Vec<Source> = outputs()
            .into_iter()
            .filter_map(|d| {
                Some(Source {
                    id: format!("device:{}", uid(d)?),
                    kind: SourceKind::Device,
                    name: name(d),
                    level: round_level(level(d)),
                    muted: muted(d),
                    default: Some(d) == default,
                    active: true,
                })
            })
            .collect();
        sort(&mut out);
        out
    }

    fn apply(&mut self, source: Option<&str>, change: Change) {
        let device = match source {
            None => default_device(),
            Some(id) => id.strip_prefix("device:").and_then(|wanted| outputs().into_iter().find(|&d| uid(d).as_deref() == Some(wanted))),
        };
        if let Some(device) = device {
            apply_to(device, change);
        }
    }

    fn refresh(&mut self) -> bool {
        // The default device is looked up on every read, so a new one is followed at once.
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "reads this machine's live audio devices"]
    fn smoke_reads_devices() {
        let mut audio = CoreAudio::new().expect("an output device");
        println!("output: {:?}", audio.read());
        println!("sources: {:?}", audio.sources());
    }
}
