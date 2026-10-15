//! Linux specifics shared by several backends.

/// `pactl`, the PulseAudio command-line client. On PipeWire systems (Fedora, Ubuntu…) it talks to
/// pipewire-pulse. JSON output (`-f json`) needs pactl 16 or later.
pub mod pactl {
    use std::{
        io::{self, BufRead, BufReader},
        os::unix::process::CommandExt,
        process::{Child, Command, Stdio},
        sync::{
            Arc,
            atomic::{AtomicBool, Ordering},
        },
        thread,
    };

    use serde_json::Value;

    /// 100 % in PulseAudio volume units (`PA_VOLUME_NORM`).
    const NORM: f64 = 65536.0;

    pub fn run(args: &[&str]) -> Option<String> {
        let out = Command::new("pactl").args(args).stdin(Stdio::null()).stderr(Stdio::null()).output().ok()?;
        out.status.success().then(|| String::from_utf8_lossy(&out.stdout).into_owned())
    }

    /// `pactl -f json <args>`, parsed.
    pub fn json(args: &[&str]) -> Option<Value> {
        let all: Vec<&str> = ["-f", "json"].iter().chain(args).copied().collect();
        serde_json::from_str(&run(&all)?).ok()
    }

    /// The items of a `pactl -f json list …` answer.
    pub fn list(kind: &str) -> Vec<Value> {
        match json(&["list", kind]) {
            Some(Value::Array(items)) => items,
            _ => Vec::new(),
        }
    }

    /// A stream's or device's level, 0–1+: the average of its channels.
    pub fn level(item: &Value) -> f32 {
        let channels: Vec<f64> = item
            .get("volume")
            .and_then(Value::as_object)
            .map(|o| o.values().filter_map(|c| c.get("value").and_then(Value::as_f64)).collect())
            .unwrap_or_default();
        match channels.len() {
            0 => 0.0,
            n => (channels.iter().sum::<f64>() / n as f64 / NORM) as f32,
        }
    }

    pub fn property<'a>(item: &'a Value, key: &str) -> Option<&'a str> {
        item.get("properties")?.get(key)?.as_str()
    }

    pub fn flag(item: &Value, key: &str) -> bool {
        item.get(key).and_then(Value::as_bool).unwrap_or(false)
    }

    /// "45%" for 0.45, as pactl's set-…-volume commands take it.
    pub fn percent(level: f32) -> String {
        format!("{}%", (level.clamp(0.0, 1.0) * 100.0).round())
    }

    /// `pactl subscribe`, running until dropped: calls `on_event` with each event line on its own
    /// thread, e.g. "Event 'change' on sink #45".
    pub struct Subscription {
        child: Child,
        alive: Arc<AtomicBool>,
    }

    impl Subscription {
        pub fn start(mut on_event: impl FnMut(&str) + Send + 'static) -> io::Result<Self> {
            let mut command = Command::new("pactl");
            command.arg("subscribe").stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
            // Quitting ends the process without running `Drop`, so the kernel stops pactl instead:
            // it gets SIGTERM when the app goes, however it goes (quit, crash or kill).
            // SAFETY: prctl only changes this child's own death signal, between fork and exec,
            // and is async-signal-safe.
            unsafe {
                command.pre_exec(|| match libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM) {
                    0 => Ok(()),
                    _ => Err(io::Error::last_os_error()),
                });
            }
            let mut child = command.spawn()?;
            let stdout = child.stdout.take().ok_or_else(|| io::Error::other("pactl subscribe has no output"))?;
            let alive = Arc::new(AtomicBool::new(true));
            let flag = Arc::clone(&alive);
            thread::Builder::new().name("pactl-subscribe".into()).spawn(move || {
                for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                    on_event(&line);
                }
                flag.store(false, Ordering::SeqCst);
            })?;
            Ok(Self { child, alive })
        }

        /// False once pactl has exited (the sound server went away).
        pub fn alive(&self) -> bool {
            self.alive.load(Ordering::SeqCst)
        }
    }

    impl Drop for Subscription {
        fn drop(&mut self) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn averages_channels_against_norm() {
            let sink = serde_json::json!({ "volume": {
                "front-left": { "value": 65536, "value_percent": "100%" },
                "front-right": { "value": 32768, "value_percent": "50%" }
            }});
            assert_eq!(level(&sink), 0.75);
            assert_eq!(level(&serde_json::json!({})), 0.0);
        }

        #[test]
        fn formats_percentages() {
            assert_eq!(percent(0.456), "46%");
            assert_eq!(percent(1.5), "100%");
        }
    }
}
