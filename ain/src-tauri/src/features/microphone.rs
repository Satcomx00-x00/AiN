//! Microphones: listing them, and capturing one into a buffer of mono samples, for the features
//! that listen (dictation, conversation).

use std::sync::{Arc, Mutex};

use cpal::{
    FromSample, SampleFormat, SizedSample,
    traits::{DeviceTrait, HostTrait, StreamTrait},
};
use serde::Serialize;
use specta::Type;

use super::{audio, lock};

/// Mono samples captured at the microphone's rate, taken by whoever reads them.
pub type Captured = Arc<Mutex<Vec<f32>>>;

/// A microphone the user can pick.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
pub struct Microphone {
    /// Stable across runs and reboots: what a "microphone" option stores.
    pub id: String,
    pub name: String,
}

fn open_stream<T>(device: &cpal::Device, config: cpal::StreamConfig, captured: Captured) -> Result<cpal::Stream, String>
where
    T: SizedSample + Send + 'static,
    f32: FromSample<T>,
{
    let channels = usize::from(config.channels);
    device
        .build_input_stream::<T, _, _>(
            config,
            move |data: &[T], _: &cpal::InputCallbackInfo| lock(&captured).extend(audio::mono(data, channels, f32::from_sample_)),
            |e| eprintln!("island: microphone: {e}"),
            None,
        )
        .map_err(|e| e.to_string())
}

/// The microphones the system offers, by stable id and name.
pub fn list() -> Vec<Microphone> {
    let Ok(devices) = cpal::default_host().input_devices() else { return Vec::new() };
    devices.filter_map(|d| Some(Microphone { id: d.id().ok()?.to_string(), name: d.to_string() })).collect()
}

/// The chosen microphone when it is connected, else the system's default one.
fn input_device(chosen: Option<&str>) -> Option<cpal::Device> {
    let host = cpal::default_host();
    let wanted = chosen.and_then(|id| id.parse::<cpal::DeviceId>().ok()).and_then(|id| host.device_by_id(&id));
    if chosen.is_some() && wanted.is_none() {
        eprintln!("island: the chosen microphone isn't connected; using the default one");
    }
    wanted.or_else(|| host.default_input_device())
}

/// Starts capturing `chosen` (or the default microphone) into `captured`; the stream runs until
/// dropped. Also returns its rate.
pub fn open(chosen: Option<&str>, captured: Captured) -> Result<(cpal::Stream, u32), String> {
    let device = input_device(chosen).ok_or("No microphone found")?;
    let supported = device.default_input_config().map_err(|e| e.to_string())?;
    let (format, config) = (supported.sample_format(), supported.config());
    let rate = config.sample_rate;
    let stream = match format {
        SampleFormat::F32 => open_stream::<f32>(&device, config, captured),
        SampleFormat::I16 => open_stream::<i16>(&device, config, captured),
        SampleFormat::I32 => open_stream::<i32>(&device, config, captured),
        SampleFormat::U16 => open_stream::<u16>(&device, config, captured),
        SampleFormat::U8 => open_stream::<u8>(&device, config, captured),
        SampleFormat::I8 => open_stream::<i8>(&device, config, captured),
        other => Err(format!("Unsupported microphone format {other}")),
    }?;
    stream.play().map_err(|e| e.to_string())?;
    Ok((stream, rate))
}

#[cfg(test)]
mod tests {
    #[test]
    #[ignore = "lists this machine's microphones"]
    fn smoke_lists_microphones() {
        let mics = super::list();
        for mic in &mics {
            println!("{} | {}", mic.name, mic.id);
            assert!(mic.id.parse::<cpal::DeviceId>().is_ok(), "ids round-trip: {}", mic.id);
        }
        assert!(!mics.is_empty(), "no microphone found");
    }
}
