//! The default sink's monitor, recorded by `parec` (pulseaudio-utils, beside `pactl`), which
//! PulseAudio and PipeWire (through pipewire-pulse) both serve.

use std::{
    io::{self, Read},
    os::unix::process::CommandExt,
    process::{Child, Command, Stdio},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread,
};

use crate::features::{lock, microphone::Captured};

/// What `parec` is asked for: the recognizer's rate, so nothing needs resampling.
pub const RATE: u32 = 16_000;
const SAMPLE: usize = size_of::<f32>();

/// `parec` running until dropped, its samples landing in a buffer.
pub struct Monitor {
    child: Child,
    alive: Arc<AtomicBool>,
}

impl Monitor {
    pub fn start(captured: Captured) -> Result<Self, String> {
        let mut command = Command::new("parec");
        command
            .args(["--device=@DEFAULT_MONITOR@", "--raw", "--format=float32le", "--channels=1", "--latency-msec=100"])
            .arg(format!("--rate={RATE}"))
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        // The kernel stops parec when the app goes, however it goes (as `pactl subscribe`).
        // SAFETY: prctl only changes this child's own death signal, between fork and exec,
        // and is async-signal-safe.
        unsafe {
            command.pre_exec(|| match libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM) {
                0 => Ok(()),
                _ => Err(io::Error::last_os_error()),
            });
        }
        let mut child = command.spawn().map_err(|e| match e.kind() {
            io::ErrorKind::NotFound => "Recording the system's sound needs parec: install pulseaudio-utils".to_string(),
            _ => format!("parec couldn't start: {e}"),
        })?;
        let stdout = child.stdout.take().ok_or("parec has no output")?;
        let alive = Arc::new(AtomicBool::new(true));
        let flag = Arc::clone(&alive);
        thread::Builder::new()
            .name("transcript-parec".into())
            .spawn(move || {
                pump(stdout, |samples| lock(&captured).extend_from_slice(samples));
                flag.store(false, Ordering::SeqCst);
            })
            .map_err(|e| e.to_string())?;
        Ok(Self { child, alive })
    }

    /// False once parec has exited (the sound server went away).
    pub fn alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }
}

impl Drop for Monitor {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Reads little-endian f32 samples from `input` until it ends, handing them over as they come;
/// a sample split across two reads is joined.
fn pump(mut input: impl Read, mut on_samples: impl FnMut(&[f32])) {
    let mut buf = [0_u8; 4096];
    let mut held = 0;
    loop {
        match input.read(&mut buf[held..]) {
            Ok(0) => return,
            Ok(n) => {
                let filled = held + n;
                let whole = filled - filled % SAMPLE;
                let samples: Vec<f32> = buf[..whole].as_chunks::<SAMPLE>().0.iter().map(|b| f32::from_le_bytes(*b)).collect();
                on_samples(&samples);
                buf.copy_within(whole..filled, 0);
                held = filled - whole;
            }
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(_) => return,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Hands out its bytes a few at a time, as a pipe may.
    struct Trickle(Vec<u8>, usize);

    impl Read for Trickle {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            let n = self.1.min(buf.len()).min(self.0.len());
            buf[..n].copy_from_slice(&self.0[..n]);
            self.0.drain(..n);
            Ok(n)
        }
    }

    #[test]
    fn joins_samples_split_across_reads() {
        let bytes: Vec<u8> = [0.5_f32, -1.0, 0.25].iter().flat_map(|s| s.to_le_bytes()).collect();
        let mut got = Vec::new();
        pump(Trickle(bytes, 3), |s| got.extend_from_slice(s));
        assert_eq!(got, [0.5, -1.0, 0.25]);
    }
}
