//! A background thread that owns OS objects (COM/WinRT ones can't cross threads), polls them on
//! an interval and accepts commands over a channel. Commands run on the next wake-up, right away.

use std::{
    io,
    sync::mpsc::{self, RecvTimeoutError, Sender},
    thread,
    time::Duration,
};

use crate::{Error, Res};

pub struct Worker<C>(Sender<C>);

impl<C> Worker<C> {
    pub fn send(&self, command: C) -> Res<()> {
        self.0.send(command).map_err(|_| Error::WorkerGone)
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
    spawn_paced(name, every, init, move |state, command| {
        step(state, command);
        every
    })
}

/// Like `spawn`, but `step` says each time how long to wait before the next idle call, the first
/// coming after `first`: for a thread that follows something closely at times and rests between.
pub fn spawn_paced<S, C: Send + 'static>(
    name: &str,
    first: Duration,
    init: impl FnOnce() -> S + Send + 'static,
    mut step: impl FnMut(&mut S, Option<C>) -> Duration + Send + 'static,
) -> io::Result<Worker<C>> {
    let (tx, rx) = mpsc::channel();
    thread::Builder::new().name(name.into()).spawn(move || {
        crate::platform::init_thread();
        let mut state = init();
        let mut commands = Some(rx);
        let mut wait = first;
        loop {
            let command = match &commands {
                Some(rx) => match rx.recv_timeout(wait) {
                    Ok(command) => Some(command),
                    Err(RecvTimeoutError::Timeout) => None,
                    Err(RecvTimeoutError::Disconnected) => {
                        commands = None;
                        continue;
                    }
                },
                None => {
                    thread::sleep(wait);
                    None
                }
            };
            wait = step(&mut state, command);
        }
    })?;
    Ok(Worker(tx))
}

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
    fn waits_as_long_as_each_step_asks() {
        let (seen_tx, seen) = channel();
        let start = std::time::Instant::now();
        let _worker = spawn_paced::<_, ()>(
            "test-paced",
            Duration::from_millis(1),
            || 0,
            move |n: &mut u64, _| {
                *n += 1;
                let _ = seen_tx.send(*n);
                Duration::from_millis(if *n < 3 { 1 } else { 60_000 })
            },
        )
        .unwrap();
        for _ in 0..3 {
            seen.recv_timeout(Duration::from_secs(1)).expect("quick steps while asked for");
        }
        assert!(seen.recv_timeout(Duration::from_millis(100)).is_err(), "then a long rest");
        assert!(start.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn keeps_polling_after_its_handle_is_dropped() {
        let (seen_tx, seen) = channel();
        drop(spawn::<_, ()>("test-orphan", Duration::from_millis(5), || (), move |_, _| _ = seen_tx.send(())).unwrap());
        for _ in 0..3 {
            seen.recv_timeout(Duration::from_secs(1)).expect("idle step after the handle was dropped");
        }
    }
}
