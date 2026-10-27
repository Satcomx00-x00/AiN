//! Recording what the computer plays. Windows (WASAPI) and macOS 14.6+ (a Core Audio process tap)
//! record the default output device through cpal; Linux records the default sink's monitor with
//! `parec`, which PulseAudio and PipeWire both serve.

use std::sync::{Arc, Mutex};

use crate::features::{lock, microphone::Captured};

/// What keeps a recording going: dropped, it stops.
enum Source {
    #[cfg(not(target_os = "linux"))]
    Device { _stream: cpal::Stream },
    #[cfg(target_os = "linux")]
    Monitor(super::linux::Monitor),
}

/// The system's sound, recorded as mono samples at `rate` until dropped.
pub struct Loopback {
    captured: Captured,
    rate: u32,
    source: Source,
}

impl Loopback {
    /// Starts recording the default output.
    pub fn open() -> Result<Self, String> {
        let captured: Captured = Arc::new(Mutex::new(Vec::new()));
        let (source, rate) = start(Arc::clone(&captured))?;
        Ok(Self { captured, rate, source })
    }

    pub fn rate(&self) -> u32 {
        self.rate
    }

    /// The samples recorded since the last call.
    pub fn take(&self) -> Vec<f32> {
        std::mem::take(&mut *lock(&self.captured))
    }

    /// False once the recording ended by itself (the sound server went away).
    pub fn alive(&self) -> bool {
        match &self.source {
            #[cfg(not(target_os = "linux"))]
            Source::Device { .. } => true,
            #[cfg(target_os = "linux")]
            Source::Monitor(monitor) => monitor.alive(),
        }
    }
}

#[cfg(not(target_os = "linux"))]
fn start(captured: Captured) -> Result<(Source, u32), String> {
    use cpal::traits::{DeviceTrait, HostTrait};

    let device = cpal::default_host().default_output_device().ok_or("No speakers or headphones found")?;
    let supported = device.default_output_config().map_err(|e| e.to_string())?;
    let (stream, rate) = crate::features::microphone::record(&device, &supported, captured)
        .map_err(|e| format!("The system's sound can't be recorded: {e}"))?;
    Ok((Source::Device { _stream: stream }, rate))
}

#[cfg(target_os = "linux")]
fn start(captured: Captured) -> Result<(Source, u32), String> {
    let monitor = super::linux::Monitor::start(captured)?;
    Ok((Source::Monitor(monitor), super::linux::RATE))
}
