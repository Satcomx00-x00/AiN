//! Recording what the computer plays, through cpal: WASAPI loopback on Windows, a Core Audio process
//! tap on macOS 14.6+, and on Linux a PipeWire stream capturing the default sink (its monitor), in
//! the app's own process: nothing else to install.

use std::sync::{Arc, Mutex};

use cpal::traits::{DeviceTrait, HostTrait};

use crate::features::{lock, microphone::Captured};

/// The system's sound, recorded as mono samples at `rate` until dropped.
pub struct Loopback {
    captured: Captured,
    rate: u32,
    _stream: cpal::Stream,
}

impl Loopback {
    /// Starts recording the default output.
    pub fn open() -> Result<Self, String> {
        let captured: Captured = Arc::new(Mutex::new(Vec::new()));
        let device = host()?.default_output_device().ok_or("No speakers or headphones found")?;
        let supported = device.default_output_config().map_err(|e| e.to_string())?;
        let (stream, rate) = crate::features::microphone::record(&device, &supported, Arc::clone(&captured))
            .map_err(|e| format!("The system's sound can't be recorded: {e}"))?;
        Ok(Self { captured, rate, _stream: stream })
    }

    pub fn rate(&self) -> u32 {
        self.rate
    }

    /// The samples recorded since the last call.
    pub fn take(&self) -> Vec<f32> {
        std::mem::take(&mut *lock(&self.captured))
    }
}

/// Where the output is recorded from: PipeWire on Linux (ALSA can't record a sink), the system's host elsewhere.
fn host() -> Result<cpal::Host, String> {
    #[cfg(target_os = "linux")]
    {
        cpal::host_from_id(cpal::HostId::PipeWire).map_err(|_| "Recording the system's sound needs PipeWire".to_string())
    }
    #[cfg(not(target_os = "linux"))]
    {
        Ok(cpal::default_host())
    }
}

#[cfg(test)]
mod tests {
    #[test]
    #[ignore = "records this machine's sound for a second"]
    fn smoke_records_what_plays() {
        let loopback = super::Loopback::open().expect("loopback opens");
        std::thread::sleep(std::time::Duration::from_secs(1));
        let samples = loopback.take();
        println!("{} samples at {} Hz", samples.len(), loopback.rate());
        assert!(!samples.is_empty(), "no audio recorded");
    }
}
