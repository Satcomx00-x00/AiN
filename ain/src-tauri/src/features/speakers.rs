//! The system's default speakers, playing whatever a queue of samples holds.

use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
};

use cpal::{
    FromSample, SampleFormat, SizedSample,
    traits::{DeviceTrait, HostTrait, StreamTrait},
};

use super::lock;

/// What the speakers still have to play, at their rate; silence while empty.
pub type Queue = Arc<Mutex<VecDeque<f32>>>;

fn open_stream<T>(device: &cpal::Device, config: cpal::StreamConfig, queue: Queue) -> Result<cpal::Stream, String>
where
    T: SizedSample + FromSample<f32> + Send + 'static,
{
    let channels = usize::from(config.channels).max(1);
    device
        .build_output_stream::<T, _, _>(
            config,
            move |data: &mut [T], _: &cpal::OutputCallbackInfo| {
                let mut queue = lock(&queue);
                for frame in data.chunks_mut(channels) {
                    frame.fill(T::from_sample_(queue.pop_front().unwrap_or(0.0)));
                }
            },
            |e| eprintln!("island: speakers: {e}"),
            None,
        )
        .map_err(|e| e.to_string())
}

/// Starts the default speakers on `queue`; the stream plays until dropped. Also returns their rate.
pub fn open(queue: Queue) -> Result<(cpal::Stream, u32), String> {
    let device = super::audio::host().default_output_device().ok_or("No speakers found")?;
    let supported = device.default_output_config().map_err(|e| e.to_string())?;
    let (format, config) = (supported.sample_format(), supported.config());
    let rate = config.sample_rate;
    let stream = match format {
        SampleFormat::F32 => open_stream::<f32>(&device, config, queue),
        SampleFormat::I16 => open_stream::<i16>(&device, config, queue),
        SampleFormat::I32 => open_stream::<i32>(&device, config, queue),
        SampleFormat::U16 => open_stream::<u16>(&device, config, queue),
        SampleFormat::U8 => open_stream::<u8>(&device, config, queue),
        SampleFormat::I8 => open_stream::<i8>(&device, config, queue),
        other => Err(format!("Unsupported speaker format {other}")),
    }?;
    stream.play().map_err(|e| e.to_string())?;
    Ok((stream, rate))
}
