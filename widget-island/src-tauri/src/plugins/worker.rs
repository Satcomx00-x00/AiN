//! A background thread that owns OS objects (COM/WinRT ones can't cross threads), polls them on
//! an interval and accepts commands over a channel. Commands run on the next wake-up, right away.

// Only Windows has a backend; elsewhere the commands report `Unsupported` and the rest goes unused.
#![cfg_attr(not(windows), allow(dead_code, unused_imports))]

use std::{
    io,
    sync::mpsc::{self, RecvTimeoutError, Sender},
    thread,
    time::Duration,
};

use crate::{Error, Res};

pub struct Worker<C>(Option<Sender<C>>);

impl<C> Worker<C> {
    /// A worker for a platform without support: every command fails with `Unsupported`.
    #[cfg_attr(windows, allow(dead_code))]
    pub fn unsupported() -> Self {
        Self(None)
    }

    pub fn send(&self, command: C) -> Res<()> {
        let tx = self.0.as_ref().ok_or(Error::Unsupported)?;
        tx.send(command).map_err(|_| Error::WorkerGone)
    }
}

/// Spawns `name`: builds its state with `init` on the new thread, then calls `step` with each
/// command as it arrives, or with `None` every `every` when idle. It keeps polling for the life of
/// the app, even once the returned handle (and with it, the command channel) is dropped.
pub fn spawn<S, C: Send + 'static>(
    name: &str,
    every: Duration,
    init: impl FnOnce() -> S + Send + 'static,
    mut step: impl FnMut(&mut S, Option<C>) + Send + 'static,
) -> io::Result<Worker<C>> {
    let (tx, rx) = mpsc::channel();
    thread::Builder::new().name(name.into()).spawn(move || {
        init_thread();
        let mut state = init();
        let mut commands = Some(rx);
        loop {
            let command = match &commands {
                Some(rx) => match rx.recv_timeout(every) {
                    Ok(command) => Some(command),
                    Err(RecvTimeoutError::Timeout) => None,
                    Err(RecvTimeoutError::Disconnected) => {
                        commands = None;
                        continue;
                    }
                },
                None => {
                    thread::sleep(every);
                    None
                }
            };
            step(&mut state, command);
        }
    })?;
    Ok(Worker(Some(tx)))
}

/// COM and WinRT objects need an apartment on the thread that uses them.
#[cfg(windows)]
fn init_thread() {
    use windows::Win32::System::Com::{COINIT_MULTITHREADED, CoInitializeEx};
    // SAFETY: called once at the start of a thread we own; the result only says whether it was already initialized.
    let _ = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
}

#[cfg(not(windows))]
fn init_thread() {}

#[cfg(test)]
mod tests {
    use std::sync::mpsc::channel;

    use super::*;

    #[test]
    fn runs_commands_and_idle_steps_on_its_thread() {
        let (seen_tx, seen) = channel();
        let worker = spawn(
            "test-worker",
            Duration::from_millis(5),
            || 0,
            move |n: &mut i32, cmd: Option<i32>| {
                *n += cmd.unwrap_or(0);
                if cmd.is_some() {
                    seen_tx.send(*n).unwrap();
                }
            },
        )
        .unwrap();
        worker.send(2).unwrap();
        worker.send(3).unwrap();
        assert_eq!((seen.recv().unwrap(), seen.recv().unwrap()), (2, 5));
    }

    #[test]
    fn keeps_polling_after_its_handle_is_dropped() {
        let (seen_tx, seen) = channel();
        drop(spawn::<_, ()>("test-orphan", Duration::from_millis(5), || (), move |_, _| _ = seen_tx.send(())).unwrap());
        for _ in 0..3 {
            seen.recv_timeout(Duration::from_secs(1)).expect("idle step after the handle was dropped");
        }
    }

    #[test]
    fn unsupported_rejects_commands() {
        assert!(matches!(Worker::<()>::unsupported().send(()), Err(Error::Unsupported)));
    }
}
