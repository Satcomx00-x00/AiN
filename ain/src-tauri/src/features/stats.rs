//! System load, sampled on its own thread at a fixed interval so rates are accurate
//! and commands never pay for a refresh.

use std::{
    io,
    sync::Arc,
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde::Serialize;
use specta::Type;
use sysinfo::{CpuRefreshKind, MemoryRefreshKind, Networks, RefreshKind, System};
use tauri::{Manager, State, Wry, plugin::TauriPlugin};

use super::live::Live;

pub const INTERVAL: Duration = Duration::from_secs(1);

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub cpu: f32,
    pub mem_used: u64,
    pub mem_total: u64,
    pub rx_per_sec: f64,
    pub tx_per_sec: f64,
    /// Unix time in milliseconds; lets readers tell a fresh sample from one they already have.
    pub sampled_at: u64,
}

pub fn per_sec(bytes: u64, secs: f64) -> f64 {
    if secs > 0.0 { bytes as f64 / secs } else { 0.0 }
}

/// The most recent sample, shared between the sampler thread and commands.
pub type Latest = Live<Option<Stats>>;

pub struct Sampler {
    sys: System,
    nets: Networks,
    last: Instant,
}

impl Sampler {
    pub fn new() -> Self {
        let kind = RefreshKind::nothing()
            .with_cpu(CpuRefreshKind::nothing().with_cpu_usage())
            .with_memory(MemoryRefreshKind::nothing().with_ram());
        Self { sys: System::new_with_specifics(kind), nets: Networks::new_with_refreshed_list(), last: Instant::now() }
    }

    pub fn sample(&mut self) -> Stats {
        self.sys.refresh_cpu_usage();
        self.sys.refresh_memory();
        self.nets.refresh(true);
        let secs = self.last.elapsed().as_secs_f64();
        self.last = Instant::now();
        let (rx, tx) = self.nets.values().fold((0, 0), |(r, t), n| (r + n.received(), t + n.transmitted()));
        Stats {
            cpu: self.sys.global_cpu_usage(),
            mem_used: self.sys.used_memory(),
            mem_total: self.sys.total_memory(),
            rx_per_sec: per_sec(rx, secs),
            tx_per_sec: per_sec(tx, secs),
            sampled_at: SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64),
        }
    }
}

pub fn spawn(latest: Arc<Latest>) -> io::Result<()> {
    thread::Builder::new().name("stats-sampler".into()).spawn(move || {
        let mut sampler = Sampler::new();
        loop {
            thread::sleep(INTERVAL);
            latest.set(Some(sampler.sample()));
        }
    })?;
    Ok(())
}

/// Latest sample, or `None` until the first one is ready.
#[tauri::command]
#[specta::specta]
fn latest(latest: State<'_, Arc<Latest>>) -> Option<Stats> {
    latest.get()
}

crate::ipc::stats!();

pub fn init() -> TauriPlugin<Wry> {
    ipc().plugin(|app| {
        let latest = Arc::new(Latest::default());
        spawn(Arc::clone(&latest))?;
        app.manage(latest);
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rate_over_elapsed_time() {
        assert_eq!(per_sec(2048, 2.0), 1024.0);
    }

    #[test]
    fn zero_elapsed_is_zero_rate() {
        assert_eq!(per_sec(2048, 0.0), 0.0);
    }

    #[test]
    fn samples_real_memory() {
        let s = Sampler::new().sample();
        assert!(s.mem_total > 0 && s.mem_used <= s.mem_total);
    }
}
