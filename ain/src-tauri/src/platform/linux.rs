//! Linux specifics shared by several backends.

use std::sync::atomic::{AtomicBool, Ordering};

static XWAYLAND: AtomicBool = AtomicBool::new(false);

/// GNOME has no layer-shell, so there a Wayland window can be neither placed nor kept above others;
/// an XWayland one can. Opens our windows through XWayland on GNOME, unless `GDK_BACKEND` already
/// picks a backend. Call it before GTK starts.
pub fn prefer_xwayland() {
    let set = |name| std::env::var_os(name).is_some_and(|v| !v.is_empty());
    let gnome = std::env::var("XDG_CURRENT_DESKTOP").is_ok_and(|d| d.split(':').any(|d| d.eq_ignore_ascii_case("gnome")));
    if gnome && set("WAYLAND_DISPLAY") && set("DISPLAY") && !set("GDK_BACKEND") {
        // Unlike GDK_BACKEND, this doesn't reach the apps we start, which stay on Wayland.
        gtk::gdk::set_allowed_backends("x11");
        XWAYLAND.store(true, Ordering::Relaxed);
    }
}

/// Our windows are X11 ones in a Wayland session: placed like on X11, but the cursor is still out
/// of sight outside them.
pub fn xwayland() -> bool {
    XWAYLAND.load(Ordering::Relaxed) || std::env::var("GDK_BACKEND").is_ok_and(|b| b.starts_with("x11"))
}

/// Synthetic key presses, through whichever tool the session allows: `xdotool` on X11; on Wayland,
/// which lets no app type into another by itself, `wtype` (wlroots and KDE compositors) or, for
/// Ctrl+V only, `ydotool` (any, with its daemon running). Without one, callers fall back to the
/// clipboard.
pub mod keys {
    use std::process::{Command, Stdio};

    fn wayland() -> bool {
        std::env::var_os("WAYLAND_DISPLAY").is_some_and(|d| !d.is_empty())
    }

    /// Runs a tool; its output when it ran and succeeded.
    fn run(program: &str, args: &[&str]) -> Option<String> {
        let out = Command::new(program).args(args).stdin(Stdio::null()).stderr(Stdio::null()).output().ok()?;
        out.status.success().then(|| String::from_utf8_lossy(&out.stdout).into_owned())
    }

    /// The focused window (X11), unless it's ours. Wayland doesn't tell.
    pub fn active_window() -> Option<isize> {
        if wayland() {
            return None;
        }
        let window: isize = run("xdotool", &["getactivewindow"])?.trim().parse().ok()?;
        let pid = run("xdotool", &["getwindowpid", &window.to_string()]).and_then(|p| p.trim().parse::<u32>().ok());
        (pid != Some(std::process::id())).then_some(window)
    }

    /// Types `text` where the cursor is; false when no tool could.
    pub fn type_text(text: &str) -> bool {
        if wayland() {
            // Not `ydotool type`: it presses US-layout keys, so on AZERTY "as" comes out "qs".
            // Callers paste instead, and Ctrl+V sits on the same key in the common layouts.
            run("wtype", &["--", text]).is_some()
        } else {
            run("xdotool", &["type", "--clearmodifiers", "--", text]).is_some()
        }
    }

    /// Focuses `window` again (X11; Wayland's compositor does it by itself), then presses Ctrl+V.
    pub fn paste(window: Option<isize>) -> bool {
        if wayland() {
            // ydotool takes Linux key codes: 29 is left Ctrl, 47 is V.
            return run("wtype", &["-M", "ctrl", "-k", "v", "-m", "ctrl"]).is_some()
                || run("ydotool", &["key", "29:1", "47:1", "47:0", "29:0"]).is_some();
        }
        let window = window.map(|w| w.to_string());
        let mut args = Vec::new();
        if let Some(w) = window.as_deref() {
            args.extend(["windowactivate", "--sync", w]);
        }
        args.extend(["key", "--clearmodifiers", "ctrl+v"]);
        run("xdotool", &args).is_some()
    }
}

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
