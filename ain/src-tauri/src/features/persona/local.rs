//! PersonaPlex on this computer, run by the app: installed on request into its folder (a Python
//! environment that uv makes, or Python's venv and pip without uv, with NVIDIA's `moshi` package), its model's weights (about 17 GB,
//! with the user's Hugging Face token) downloaded on request or else by the first start, its server
//! started on localhost when a conversation needs it, and stopped once unused for a while.

use std::{
    fs,
    io::{self, BufReader, Read, Seek, SeekFrom},
    net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream},
    ops::RangeInclusive,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::{Duration, Instant},
};

use serde::Serialize;
use specta::Type;

use super::super::{download, live::Live, lock};
use crate::{config, platform};

/// NVIDIA's package, bundled with the app as a wheel (made by `scripts/personaplex-wheel.py`), so
/// installing it clones nothing; only its dependencies come from PyPI.
pub const WHEEL: &str = "moshi_personaplex-0.1.0-py3-none-any.whl";
/// What the wheel was made from: NVIDIA's package at the commit whose protocol `link.rs` speaks.
/// An install records it, and one of another build is redone.
const PACKAGE: &str =
    "moshi-personaplex @ git+https://github.com/NVIDIA/personaplex.git@3428dfd95309a7f3c84fd93259ded0f810d1ff91#subdirectory=moshi";
/// PyTorch built for NVIDIA GPUs (CUDA 12.4), at the newest version the package allows (< 2.5),
/// installed before it from PyTorch's own index: PyPI's is built for the CPU alone on Windows.
const TORCH: &str = "torch==2.4.1";
/// Points huggingface_hub at [`config::HF_URL`] when overridden; else leaves the user's own `HF_ENDPOINT` be.
fn hf_endpoint(command: &mut Command) {
    if let Some(url) = config::HF_URL.set() {
        command.env("HF_ENDPOINT", url.trim_end_matches('/'));
    }
}

/// PyTorch's index: [`config::TORCH_INDEX_URL`].
fn torch_index() -> String {
    let index = config::TORCH_INDEX_URL;
    index.set().unwrap_or_else(|| index.default.into())
}
/// What `--cpu-offload` needs besides.
const EXTRAS: &[&str] = &["accelerate"];
/// The Python its pinned torch supports; uv fetches it when the computer has none.
const PYTHON: &str = "3.12";
/// The Python 3 minor versions its pinned torch (< 2.5) has wheels for, which pip needs installed.
const PYTHONS: RangeInclusive<u32> = 10..=12;
const UV_HELP: &str = "https://docs.astral.sh/uv/getting-started/installation/";
/// The model's repository on Hugging Face, and the files its server fetches from it (all but the
/// web page, which the app doesn't serve).
const REPO: &str = "nvidia/personaplex-7b-v1";
const FILES: &[&str] =
    &["config.json", "tokenizer-e351c8d8-checkpoint125.safetensors", "tokenizer_spm_32k_3.model", "model.safetensors", "voices.tgz"];
/// Fetches the files named after the repository into Hugging Face's cache, as the server would,
/// printing `progress <received> <total>` (bytes) as it goes: the total from the files' sizes on the
/// Hub, what was received from the files in the cache on disk. Those are in `blobs` (finished, or
/// still `.incomplete`), with links to them in `snapshots`; where Windows can't link, a finished
/// file moves to `snapshots` instead, so real files there count too, and links don't.
const FETCH: &str = r#"import os, sys, threading, time
from huggingface_hub import get_hf_file_metadata, hf_hub_download, hf_hub_url
from huggingface_hub.constants import HF_HUB_CACHE
repo, names = sys.argv[1], sys.argv[2:]
total = sum(get_hf_file_metadata(hf_hub_url(repo, name)).size or 0 for name in names)
cache = os.path.join(HF_HUB_CACHE, "models--" + repo.replace("/", "--"))
def received():
    size = 0
    for folder in ("blobs", "snapshots"):
        for root, _, files in os.walk(os.path.join(cache, folder)):
            for name in files:
                path = os.path.join(root, name)
                try:
                    size += 0 if os.path.islink(path) else os.path.getsize(path)
                except OSError:
                    pass
    return min(size, total)
def report():
    shown = None
    while True:
        now = received()
        if now != shown:
            print(f"progress {now} {total}", flush=True)
            shown = now
        time.sleep(0.5)
print(f"progress {received()} {total}", flush=True)
threading.Thread(target=report, daemon=True).start()
for name in names:
    hf_hub_download(repo, name)
print(f"progress {total} {total}", flush=True)
"#;
/// Long enough for the first start, which downloads the weights.
const READY_WITHIN: Duration = Duration::from_secs(2 * 60 * 60);
const POLL: Duration = Duration::from_millis(250);
/// How much of the server's log is read for its last lines.
const TAIL: u64 = 16 * 1024;
/// How many of the log's last lines say why the server stopped: a Python traceback, with its cause.
const WHY_LINES: usize = 20;

/// Whether PersonaPlex is installed in its folder.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Type)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum Setup {
    #[default]
    Missing,
    /// uv, or pip, at work: its last line of output.
    Installing {
        line: String,
    },
    Ready,
    Error {
        message: String,
    },
}

/// Whether the model's weights are in its folder.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Type)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum Weights {
    #[default]
    Missing,
    /// Hugging Face's download at work: bytes received of the total (0 until the Hub tells it).
    Downloading {
        received: u64,
        total: u64,
    },
    Ready,
    Error {
        message: String,
    },
}

/// What Settings shows: the folder, the setup, the model, and whether the server runs now.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
pub struct LocalInfo {
    pub dir: String,
    pub running: bool,
    pub model: Weights,
    #[serde(flatten)]
    pub setup: Setup,
}

/// PersonaPlex's folder, and what it holds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Place(pub PathBuf);

impl Place {
    fn venv(&self) -> PathBuf {
        self.0.join("venv")
    }

    fn python(&self) -> PathBuf {
        if cfg!(windows) { self.venv().join("Scripts").join("python.exe") } else { self.venv().join("bin").join("python") }
    }

    /// Written last by an install, with the package it installed.
    fn marker(&self) -> PathBuf {
        self.0.join("installed")
    }

    /// Hugging Face's cache: the weights, removed with the folder.
    fn hf(&self) -> PathBuf {
        self.0.join("hf")
    }

    fn log(&self) -> PathBuf {
        self.0.join("server.log")
    }

    /// Installed, with the package this app speaks to and the PyTorch it needs.
    pub fn installed(&self) -> bool {
        fs::read_to_string(self.marker()).is_ok_and(|m| m.trim() == build()) && self.python().is_file()
    }

    /// Every file the server needs is in a snapshot of the cache (wherever it was downloaded from).
    pub fn downloaded(&self) -> bool {
        let snapshots = self.hf().join("hub").join(format!("models--{}", REPO.replace('/', "--"))).join("snapshots");
        let snapshots = fs::read_dir(snapshots).into_iter().flatten().flatten();
        snapshots.map(|s| s.path()).any(|s| FILES.iter().all(|f| s.join(f).is_file()))
    }
}

/// uv: on the PATH, or where its installer puts it (an app started from the desktop may not have
/// the shell's PATH).
fn find_uv() -> Option<PathBuf> {
    let exe = if cfg!(windows) { "uv.exe" } else { "uv" };
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from);
    let path = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect::<Vec<_>>()).unwrap_or_default();
    let usual = home.into_iter().flat_map(|h| [h.join(".local").join("bin"), h.join(".cargo").join("bin")]);
    path.into_iter().chain(usual).map(|dir| dir.join(exe)).find(|p| p.is_file())
}

/// What an install records: the package, and the PyTorch build under it. An install made otherwise
/// (an older package, or PyTorch for the CPU alone) is redone.
fn build() -> String {
    format!("{PACKAGE}\n{TORCH} from {}", torch_index())
}

/// A Python that can make PersonaPlex's environment when uv is missing: how to start it, and its
/// version.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Python {
    program: &'static str,
    args: &'static [&'static str],
    version: (u32, u32),
}

impl Python {
    fn command(&self) -> Command {
        let mut command = Command::new(self.program);
        command.args(self.args);
        command
    }
}

/// `major minor`, as `print(*sys.version_info[:2])` prints them.
fn parse_version(text: &str) -> Option<(u32, u32)> {
    let mut numbers = text.split_whitespace().map(str::parse);
    match (numbers.next(), numbers.next()) {
        (Some(Ok(major)), Some(Ok(minor))) => Some((major, minor)),
        _ => None,
    }
}

/// A Python of a version its torch supports: the Windows launcher's newest, or one on the PATH.
fn find_python() -> Option<Python> {
    let candidates: &[(&'static str, &'static [&'static str])] = if cfg!(windows) {
        &[("py", &["-3.12"]), ("py", &["-3.11"]), ("py", &["-3.10"]), ("python", &[]), ("python3", &[])]
    } else {
        &[("python3.12", &[]), ("python3.11", &[]), ("python3.10", &[]), ("python3", &[]), ("python", &[])]
    };
    candidates.iter().find_map(|&(program, args)| {
        let mut probe = Command::new(program);
        probe.args(args).args(["-c", "import sys; print(*sys.version_info[:2])"]).stdin(Stdio::null()).stderr(Stdio::null());
        platform::tie_to_app(&mut probe);
        let out = probe.output().ok().filter(|o| o.status.success())?;
        let version = parse_version(&String::from_utf8_lossy(&out.stdout))?;
        (version.0 == 3 && PYTHONS.contains(&version.1)).then_some(Python { program, args, version })
    })
}

/// What makes PersonaPlex's environment: uv, or else pip with a Python already installed.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Installer {
    Uv(PathBuf),
    Pip(Python),
}

fn installer() -> Result<Installer, String> {
    if let Some(uv) = find_uv() {
        return Ok(Installer::Uv(uv));
    }
    find_python().map(Installer::Pip).ok_or_else(|| {
        format!(
            "PersonaPlex is installed with uv, or with pip and Python 3.{}–3.{}; this computer has neither: install uv ({UV_HELP}), then try again.",
            PYTHONS.start(),
            PYTHONS.end()
        )
    })
}

/// The last line in `text` with something on it: progress bars redraw theirs with `\r`.
fn last_line(text: &str) -> &str {
    text.rsplit(['\n', '\r']).map(str::trim).find(|l| !l.is_empty()).unwrap_or("")
}

/// The end of a file that is still being written.
fn end_of(path: &Path) -> String {
    let read = || -> io::Result<String> {
        let mut file = fs::File::open(path)?;
        let len = file.metadata()?.len();
        file.seek(SeekFrom::Start(len.saturating_sub(TAIL)))?;
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)?;
        Ok(String::from_utf8_lossy(&bytes).into_owned())
    };
    read().unwrap_or_default()
}

/// The last line of a file that is still being written.
fn tail(path: &Path) -> String {
    last_line(&end_of(path)).to_string()
}

/// Its last `n` lines with something on them, each as a progress bar last drew it.
fn last_lines(text: &str, n: usize) -> String {
    let lines: Vec<&str> = text.lines().map(last_line).filter(|l| !l.is_empty()).collect();
    lines[lines.len().saturating_sub(n)..].join("\n")
}

/// Keeps `line` on the last line `stream` wrote: lines end with `\n`, or `\r` where a progress
/// bar redraws its own.
fn follow(stream: impl Read + Send + 'static, line: &Arc<Mutex<String>>) -> thread::JoinHandle<()> {
    let line = Arc::clone(line);
    thread::spawn(move || {
        let mut piece = Vec::new();
        for byte in BufReader::new(stream).bytes().map_while(Result::ok) {
            if byte != b'\n' && byte != b'\r' {
                piece.push(byte);
                continue;
            }
            let text = String::from_utf8_lossy(&piece);
            if !text.trim().is_empty() {
                *lock(&line) = text.trim().to_string();
            }
            piece.clear();
        }
    })
}

/// After this long without a word from a helper, say it's still at work, and for how long.
const QUIET: Duration = Duration::from_secs(3);

/// "3:07": how long a step has taken.
fn clock(took: Duration) -> String {
    let secs = took.as_secs();
    format!("{}:{:02}", secs / 60, secs % 60)
}

/// What to show of a step: its helper's last line, or, once it has said nothing new for a while,
/// what the step is doing and for how long, so a long quiet download (uv says nothing while it
/// fetches PyTorch) doesn't look stuck.
fn step_line(doing: &str, last: &str, quiet: Duration, took: Duration) -> String {
    if quiet >= QUIET { format!("{doing} {}", clock(took)) } else { last.to_string() }
}

/// Runs `what` (uv, pip or Python) for a step `doing` something, reporting its last line of output
/// (pip writes its progress to stdout, the others to stderr), until it ends or is cancelled. It ends
/// with the app too, should the app end first.
fn run(mut command: Command, what: &str, doing: &str, cancel: &AtomicBool, report: &mut dyn FnMut(&str)) -> Result<(), String> {
    command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    platform::tie_to_app(&mut command);
    let mut child = command.spawn().map_err(|e| format!("couldn't start {what}: {e}"))?;
    platform::end_with_app(&child);
    let line = Arc::new(Mutex::new(String::new()));
    let readers = [child.stdout.take().map(|s| follow(s, &line)), child.stderr.take().map(|s| follow(s, &line))];
    let (started, mut since) = (Instant::now(), Instant::now());
    let (mut last, mut said) = (String::new(), String::new());
    let mut show = || {
        let now = lock(&line).clone();
        if now != last {
            last = now;
            since = Instant::now();
        }
        let text = step_line(doing, &last, since.elapsed(), started.elapsed());
        if text != said {
            report(&text);
            said = text;
        }
    };
    let status = loop {
        if cancel.load(Ordering::SeqCst) {
            let _ = child.kill();
            let _ = child.wait();
            return Err("cancelled".into());
        }
        show();
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(status) => break status,
            None => thread::sleep(POLL),
        }
    };
    // Its last words, once all read.
    for reader in readers.into_iter().flatten() {
        let _ = reader.join();
    }
    show();
    if status.success() { Ok(()) } else { Err(format!("{what} failed ({status}): {last}")) }
}

/// Installs PersonaPlex into `place`, from scratch, from the bundled `wheel`: with uv, or else with pip.
fn install(place: &Place, wheel: &Path, cancel: &AtomicBool, report: &mut dyn FnMut(&str)) -> Result<(), String> {
    if !wheel.is_file() {
        return Err(format!("PersonaPlex's package is missing from the app ({}): reinstall the app.", wheel.display()));
    }
    let installer = installer()?;
    let _ = fs::remove_file(place.marker());
    download::remove(&place.venv()).map_err(|e| e.to_string())?;
    fs::create_dir_all(&place.0).map_err(|e| e.to_string())?;
    match installer {
        Installer::Uv(uv) => {
            let mut venv = Command::new(&uv);
            venv.args(["venv", "--python", PYTHON]).arg(place.venv());
            run(venv, "uv", "Making its Python environment…", cancel, report)?;
            {
                let index = torch_index();
                report("Installing PyTorch for NVIDIA GPUs (about 2.5 GB)…");
                let mut torch = Command::new(&uv);
                torch.args(["pip", "install", "--python"]).arg(place.python()).args([TORCH, "--index-url", &index]);
                run(torch, "uv", "Installing PyTorch for NVIDIA GPUs (about 2.5 GB)…", cancel, report)?;
            }
            let mut pip = Command::new(&uv);
            pip.args(["pip", "install", "--python"]).arg(place.python()).arg(wheel).args(EXTRAS);
            run(pip, "uv", "Installing PersonaPlex and its libraries…", cancel, report)?;
        }
        Installer::Pip(python) => {
            report(&format!("No uv here: installing with pip, on Python {}.{}…", python.version.0, python.version.1));
            let mut venv = python.command();
            venv.args(["-m", "venv"]).arg(place.venv());
            run(venv, "Python", "Making its Python environment…", cancel, report)?;
            {
                let index = torch_index();
                report("Installing PyTorch for NVIDIA GPUs (about 2.5 GB)…");
                let mut torch = Command::new(place.python());
                torch
                    .args(["-m", "pip", "install", "--disable-pip-version-check", TORCH, "--index-url", &index])
                    .env("PYTHONUNBUFFERED", "1");
                run(torch, "pip", "Installing PyTorch for NVIDIA GPUs (about 2.5 GB)…", cancel, report)?;
            }
            let mut pip = Command::new(place.python());
            pip.args(["-m", "pip", "install", "--disable-pip-version-check"]).arg(wheel).args(EXTRAS).env("PYTHONUNBUFFERED", "1");
            run(pip, "pip", "Installing PersonaPlex and its libraries…", cancel, report)?;
        }
    }
    fs::write(place.marker(), build()).map_err(|e| e.to_string())
}

/// Bytes received and in all, from a `progress <received> <total>` line of `FETCH`.
fn progress_of(line: &str) -> Option<(u64, u64)> {
    let mut words = line.strip_prefix("progress ")?.split_whitespace().map(str::parse);
    match (words.next(), words.next()) {
        (Some(Ok(received)), Some(Ok(total))) => Some((received, total)),
        _ => None,
    }
}

/// Downloads the model's weights into `place`'s cache, with PersonaPlex's own Python, reporting
/// `FETCH`'s lines; an interrupted download resumes where it stopped.
fn fetch_weights(place: &Place, token: Option<&str>, cancel: &AtomicBool, report: &mut dyn FnMut(&str)) -> Result<(), String> {
    if !place.installed() {
        return Err("PersonaPlex isn't installed: install it first.".into());
    }
    let token = token.ok_or_else(|| {
        format!("the model needs your Hugging Face token: accept its license on huggingface.co/{REPO}, then paste a token above.")
    })?;
    let mut fetch = Command::new(place.python());
    fetch.args(["-c", FETCH, REPO]).args(FILES).env("HF_HOME", place.hf()).env("HF_TOKEN", token).env("PYTHONUNBUFFERED", "1");
    // Without links (Windows without developer mode), the cache only copies: nothing to warn about.
    fetch.env("HF_HUB_DISABLE_SYMLINKS_WARNING", "1");
    hf_endpoint(&mut fetch);
    run(fetch, "the download", "Downloading the model…", cancel, report)?;
    if place.downloaded() { Ok(()) } else { Err("the download ended without every file.".into()) }
}

/// Why a server stopped, with what to do first when its cause is a known one.
fn explained(why: String) -> String {
    let hints = [
        (
            &["Torch not compiled with CUDA enabled"][..],
            "Its PyTorch can't use the GPU: remove PersonaPlex in Settings, then install it again.",
        ),
        (
            &["CUDA out of memory", "OutOfMemoryError"][..],
            "The GPU ran out of memory: PersonaPlex needs one with 24 GB. Close what else uses it, or talk through an AI provider's server.",
        ),
        // accelerate's offload leaves the layers in RAM empty outside their turn, and PersonaPlex makes
        // its streaming state on its layers' device: empty too. Its --cpu-offload can't work.
        (
            &["Cannot copy out of meta tensor"][..],
            "Offload to the CPU doesn't work with PersonaPlex: turn it off. It needs a GPU with 24 GB, or talk through an AI provider's server.",
        ),
        (
            &["Found no NVIDIA driver", "no CUDA GPUs are available"][..],
            "No NVIDIA GPU could be used: PersonaPlex needs one, with its driver installed.",
        ),
        (
            &["GatedRepoError", "401 Client Error", "403 Client Error"][..],
            "Hugging Face refused the model: accept its license on huggingface.co/nvidia/personaplex-7b-v1, then check the token.",
        ),
    ];
    match hints.iter().find(|(causes, _)| causes.iter().any(|c| why.contains(c))) {
        Some((_, hint)) => format!("{hint}\n\n{why}"),
        None => why,
    }
}

/// A port on localhost that nothing listens on now.
fn free_port() -> io::Result<u16> {
    Ok(TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?.local_addr()?.port())
}

/// How the server starts: with the user's token, and its layers partly on the CPU when asked.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Launch {
    pub token: Option<String>,
    pub cpu_offload: bool,
}

/// PersonaPlex's server running on localhost; stopped when dropped.
struct Server {
    child: Child,
    port: u16,
    place: Place,
}

impl Server {
    fn start(program: &Path, place: &Place, launch: &Launch) -> Result<Self, String> {
        let port = free_port().map_err(|e| e.to_string())?;
        let log = fs::File::create(place.log()).map_err(|e| e.to_string())?;
        let mut command = Command::new(program);
        // No web page to serve: the app is its client. Plain ws, since it only listens on localhost.
        command.args(["-m", "moshi.server", "--host", "127.0.0.1", "--port", &port.to_string(), "--static", "none"]);
        // In its folder: what it writes beside itself (accelerate's offload folder) stays there.
        command.current_dir(&place.0);
        if launch.cpu_offload {
            command.arg("--cpu-offload");
        }
        command.env("HF_HOME", place.hf()).env("PYTHONUNBUFFERED", "1");
        hf_endpoint(&mut command);
        if let Some(token) = &launch.token {
            command.env("HF_TOKEN", token);
        }
        command.stdin(Stdio::null()).stdout(log.try_clone().map_err(|e| e.to_string())?).stderr(log);
        platform::tie_to_app(&mut command);
        let child = command.spawn().map_err(|e| format!("couldn't start PersonaPlex: {e}"))?;
        // Holding the GPU, it ends with the app, however the app ends.
        platform::end_with_app(&child);
        Ok(Self { child, port, place: place.clone() })
    }

    fn alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    /// Waits until it listens (it loads the model first), reporting its log's last line.
    fn wait_ready(&mut self, log: &Path, within: Duration, go_on: &dyn Fn() -> bool, report: &mut dyn FnMut(&str)) -> Result<(), String> {
        let address = SocketAddr::from((Ipv4Addr::LOCALHOST, self.port));
        let start = Instant::now();
        loop {
            if TcpStream::connect_timeout(&address, POLL).is_ok() {
                return Ok(());
            }
            if let Some(status) = self.child.try_wait().map_err(|e| e.to_string())? {
                return Err(explained(format!("PersonaPlex stopped ({status}):\n{}", last_lines(&end_of(log), WHY_LINES))));
            }
            if !go_on() {
                return Err("cancelled".into());
            }
            if start.elapsed() > within {
                return Err(explained(format!(
                    "PersonaPlex didn't start within {} minutes:\n{}",
                    within.as_secs() / 60,
                    last_lines(&end_of(log), WHY_LINES)
                )));
            }
            report(&tail(log));
            thread::sleep(POLL);
        }
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// PersonaPlex on this computer: its install, and its server while in use.
pub struct Local {
    /// The bundled package it is installed from.
    wheel: PathBuf,
    setup: Live<Setup>,
    server: Mutex<Option<Server>>,
    /// One start at a time; held while the server loads, apart from `server` so that checking on
    /// it never waits for a start.
    starting: Mutex<()>,
    used: Mutex<Instant>,
    installing: AtomicBool,
    cancel: AtomicBool,
    weights: Live<Weights>,
    downloading: AtomicBool,
    /// Apart from `cancel`: stopping a download keeps the install.
    stop_download: AtomicBool,
    /// Tells the windows what changed.
    changed: Box<dyn Fn(LocalInfo) + Send + Sync>,
}

impl Local {
    pub fn new(place: &Place, wheel: PathBuf, changed: impl Fn(LocalInfo) + Send + Sync + 'static) -> Self {
        Self {
            wheel,
            setup: Live::new(if place.installed() { Setup::Ready } else { Setup::Missing }),
            server: Mutex::new(None),
            starting: Mutex::new(()),
            used: Mutex::new(Instant::now()),
            installing: AtomicBool::new(false),
            cancel: AtomicBool::new(false),
            weights: Live::new(if place.downloaded() { Weights::Ready } else { Weights::Missing }),
            downloading: AtomicBool::new(false),
            stop_download: AtomicBool::new(false),
            changed: Box::new(changed),
        }
    }

    pub fn info(&self, place: &Place) -> LocalInfo {
        let running = lock(&self.server).as_mut().is_some_and(Server::alive);
        let setup = match self.setup.get() {
            // Installed or removed by hand, or another folder chosen.
            Setup::Missing | Setup::Ready if !self.installing.load(Ordering::SeqCst) => {
                if place.installed() {
                    Setup::Ready
                } else {
                    Setup::Missing
                }
            }
            setup => setup,
        };
        let model = match self.weights.get() {
            // Downloaded by the server's first start, removed by hand, or another folder chosen.
            Weights::Missing | Weights::Ready if !self.downloading.load(Ordering::SeqCst) => {
                if place.downloaded() {
                    Weights::Ready
                } else {
                    Weights::Missing
                }
            }
            model => model,
        };
        LocalInfo { dir: place.0.to_string_lossy().into_owned(), running, model, setup }
    }

    fn announce(&self, place: &Place) {
        (self.changed)(self.info(place));
    }

    fn set(&self, place: &Place, setup: Setup) {
        if self.setup.set(setup) {
            self.announce(place);
        }
    }

    /// Installs it in the background; does nothing while an install runs.
    pub fn install(self: &Arc<Self>, place: Place) -> io::Result<()> {
        if self.installing.swap(true, Ordering::SeqCst) {
            return Ok(());
        }
        self.cancel.store(false, Ordering::SeqCst);
        let this = Arc::clone(self);
        let work = move || {
            this.set(&place, Setup::Installing { line: "Getting ready…".into() });
            let result = install(&place, &this.wheel, &this.cancel, &mut |line| this.set(&place, Setup::Installing { line: line.into() }));
            this.installing.store(false, Ordering::SeqCst);
            this.set(
                &place,
                match result {
                    Ok(()) => Setup::Ready,
                    Err(_) if this.cancel.load(Ordering::SeqCst) => Setup::Missing,
                    Err(message) => Setup::Error { message },
                },
            );
        };
        thread::Builder::new()
            .name("persona-install".into())
            .spawn(work)
            .map(drop)
            .inspect_err(|_| self.installing.store(false, Ordering::SeqCst))
    }

    fn set_weights(&self, place: &Place, weights: Weights) {
        if self.weights.set(weights) {
            self.announce(place);
        }
    }

    /// Downloads the model's weights in the background, with the user's Hugging Face token; does
    /// nothing while a download runs.
    pub fn download(self: &Arc<Self>, place: Place, token: Option<String>) -> io::Result<()> {
        if self.downloading.swap(true, Ordering::SeqCst) {
            return Ok(());
        }
        self.stop_download.store(false, Ordering::SeqCst);
        let this = Arc::clone(self);
        let work = move || {
            this.set_weights(&place, Weights::Downloading { received: 0, total: 0 });
            let mut report = |line: &str| {
                if let Some((received, total)) = progress_of(line) {
                    this.set_weights(&place, Weights::Downloading { received, total });
                }
            };
            let result = fetch_weights(&place, token.as_deref(), &this.stop_download, &mut report);
            this.downloading.store(false, Ordering::SeqCst);
            this.set_weights(
                &place,
                match result {
                    Ok(()) => Weights::Ready,
                    Err(_) if this.stop_download.load(Ordering::SeqCst) => Weights::Missing,
                    Err(message) => Weights::Error { message },
                },
            );
        };
        thread::Builder::new()
            .name("persona-download".into())
            .spawn(work)
            .map(drop)
            .inspect_err(|_| self.downloading.store(false, Ordering::SeqCst))
    }

    /// Stops a download; what it fetched stays, for the next one to resume.
    pub fn cancel_download(&self) {
        self.stop_download.store(true, Ordering::SeqCst);
    }

    /// Stops an install, a download or the server, and deletes the folder with its weights.
    pub fn remove(&self, place: &Place) -> io::Result<()> {
        self.cancel.store(true, Ordering::SeqCst);
        self.stop_download.store(true, Ordering::SeqCst);
        // Let them see it and end their uv or Python before the folder goes.
        while self.installing.load(Ordering::SeqCst) || self.downloading.load(Ordering::SeqCst) {
            thread::sleep(POLL);
        }
        lock(&self.server).take();
        let removed = download::remove(&place.0);
        self.weights.set(Weights::Missing);
        self.set(place, Setup::Missing);
        self.announce(place);
        removed
    }

    /// The server's port, once it listens: started (and loaded) first when it isn't running.
    /// `go_on` ends the wait when it turns false; `report` gets the server's progress.
    pub fn serve(&self, place: &Place, launch: &Launch, go_on: &dyn Fn() -> bool, report: &mut dyn FnMut(&str)) -> Result<u16, String> {
        self.serve_with(&place.python(), place, launch, go_on, report)
    }

    fn serve_with(
        &self,
        program: &Path,
        place: &Place,
        launch: &Launch,
        go_on: &dyn Fn() -> bool,
        report: &mut dyn FnMut(&str),
    ) -> Result<u16, String> {
        let _one = lock(&self.starting);
        self.touch();
        if let Some(server) = lock(&self.server).as_mut()
            && server.alive()
        {
            return Ok(server.port);
        }
        if !place.installed() {
            return Err(
                "PersonaPlex isn't installed on this computer: install it in Settings → Conversation, or pick an AI provider there.".into(),
            );
        }
        let mut server = Server::start(program, place, launch)?;
        server.wait_ready(&place.log(), READY_WITHIN, go_on, report)?;
        let port = server.port;
        *lock(&self.server) = Some(server);
        self.touch();
        self.announce(place);
        Ok(port)
    }

    /// In use: the server stays up.
    pub fn touch(&self) {
        *lock(&self.used) = Instant::now();
    }

    /// Stops the server once unused for `idle`, or lets it go when it has ended by itself.
    pub fn let_cold_go(&self, idle: Duration) {
        let mut server = lock(&self.server);
        let Some(running) = server.as_mut() else { return };
        if running.alive() && lock(&self.used).elapsed() < idle {
            return;
        }
        let place = running.place.clone();
        server.take();
        drop(server);
        self.announce(&place);
    }

    /// Stops the server now: the app is quitting.
    pub fn stop(&self) {
        lock(&self.server).take();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> Place {
        let dir = std::env::temp_dir().join(format!("ain-persona-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        Place(dir)
    }

    fn fake_install(place: &Place) {
        fs::create_dir_all(place.python().parent().unwrap()).unwrap();
        fs::write(place.python(), "").unwrap();
        fs::write(place.marker(), build()).unwrap();
    }

    #[test]
    fn redoes_an_install_without_the_pytorch_it_needs() {
        let place = temp("torch");
        fake_install(&place);
        assert!(place.installed());
        // Before PyTorch came from its own index: the package alone, PyPI's PyTorch under it.
        fs::write(place.marker(), PACKAGE).unwrap();
        assert!(!place.installed());
        assert!(build().starts_with(PACKAGE) && build().contains(TORCH));
        if cfg!(windows) {
            assert!(build().contains("download.pytorch.org/whl/cu124"), "{}", build());
        }
    }

    #[test]
    fn says_what_to_do_about_a_known_cause() {
        let why = |last: &str| explained(format!("PersonaPlex stopped (exit code: 1):\nTraceback (most recent call last):\n{last}"));
        let cuda = why("AssertionError: Torch not compiled with CUDA enabled");
        assert!(cuda.starts_with("Its PyTorch can't use the GPU: remove PersonaPlex"), "{cuda}");
        assert!(cuda.ends_with("AssertionError: Torch not compiled with CUDA enabled"), "the log stays: {cuda}");
        assert!(why("torch.OutOfMemoryError: CUDA out of memory").starts_with("The GPU ran out of memory"));
        assert!(
            why("NotImplementedError: Cannot copy out of meta tensor; no data!")
                .starts_with("Offload to the CPU doesn't work with PersonaPlex")
        );
        assert!(why("huggingface_hub.errors.GatedRepoError: 403 Client Error").starts_with("Hugging Face refused the model"));
        assert_eq!(why("ValueError: odd"), "PersonaPlex stopped (exit code: 1):\nTraceback (most recent call last):\nValueError: odd");
    }

    #[test]
    fn keeps_the_last_lines_as_their_progress_bars_last_drew_them() {
        let log = "boot\n\nloading  10%\rloading 100%\nTraceback (most recent call last):\n  File \"server.py\"\nRuntimeError: CUDA out of memory\n";
        assert_eq!(last_lines(log, 3), "Traceback (most recent call last):\nFile \"server.py\"\nRuntimeError: CUDA out of memory");
        assert_eq!(last_lines(log, 99).lines().collect::<Vec<_>>()[..2], ["boot", "loading 100%"]);
        assert_eq!(last_lines("", 3), "");
    }

    #[test]
    fn reads_the_last_line_progress_bars_redraw() {
        assert_eq!(last_line("loading\nweights  10%\rweights  55%\r\n\n"), "weights  55%");
        assert_eq!(last_line(" \n"), "");
        let place = temp("tail");
        assert_eq!(tail(&place.log()), "", "no log yet");
        fs::write(place.log(), format!("{}\nINFO: ready\n", "x".repeat(10_000))).unwrap();
        assert_eq!(tail(&place.log()), "INFO: ready");
    }

    #[test]
    fn is_installed_only_with_the_package_it_speaks_to() {
        let place = temp("installed");
        let local = Local::new(&place, PathBuf::new(), |_| {});
        assert_eq!(local.info(&place).setup, Setup::Missing);
        fake_install(&place);
        assert!(place.installed());
        let info = local.info(&place);
        assert_eq!((info.setup, info.running), (Setup::Ready, false));
        fs::write(place.marker(), "moshi-personaplex @ an older commit").unwrap();
        assert!(!place.installed(), "an install of another version is redone");
        assert!(place.hf().starts_with(&place.0), "the weights go with the folder");
    }

    #[test]
    fn says_what_is_missing_before_starting() {
        let place = temp("missing");
        let local = Local::new(&place, PathBuf::new(), |_| {});
        let error = local.serve(&place, &Launch::default(), &|| true, &mut |_| {}).unwrap_err();
        assert!(error.contains("install it in Settings"), "{error}");
    }

    #[test]
    fn removes_the_folder_and_says_so() {
        let place = temp("remove");
        fake_install(&place);
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = Arc::clone(&seen);
        let local = Local::new(&place, PathBuf::new(), move |info| lock(&log).push(info.setup));
        local.remove(&place).unwrap();
        assert!(!place.0.exists());
        assert_eq!(lock(&seen).last(), Some(&Setup::Missing));
    }

    #[test]
    fn finds_a_free_port() {
        let port = free_port().unwrap();
        assert!(TcpListener::bind((Ipv4Addr::LOCALHOST, port)).is_ok());
    }

    /// A stand-in for Python: `sh` runs the "module" given after `-m` as a script.
    #[cfg(unix)]
    fn fake_server(place: &Place, script: &str) -> PathBuf {
        let program = place.0.join("fake-python");
        fs::write(&program, format!("#!/bin/sh\n{script}\n")).unwrap();
        fs::set_permissions(&program, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
        program
    }

    #[cfg(unix)]
    #[test]
    fn reports_why_the_server_stopped() {
        let place = temp("crash");
        fake_install(&place);
        let program = fake_server(&place, "echo 'downloading 10%'; echo \"token=$HF_TOKEN offload=$*\" >&2; exit 3");
        let local = Local::new(&place, PathBuf::new(), |_| {});
        let launch = Launch { token: Some("hf_abc".into()), cpu_offload: true };
        let error = local.serve_with(&program, &place, &launch, &|| true, &mut |_| {}).unwrap_err();
        assert!(error.contains("token=hf_abc") && error.contains("--cpu-offload"), "{error}");
        assert!(error.contains("--host 127.0.0.1"), "only on localhost: {error}");
    }

    #[cfg(unix)]
    #[test]
    fn starts_once_then_lets_the_cold_server_go() {
        let place = temp("serve");
        fake_install(&place);
        // Listens on the port it is given, like the real server once loaded.
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let program = fake_server(&place, "echo loading; sleep 30");
        let local = Local::new(&place, PathBuf::new(), |_| {});
        let mut server = Server::start(&program, &place, &Launch::default()).unwrap();
        server.port = port;
        server.wait_ready(&place.log(), Duration::from_secs(5), &|| true, &mut |_| {}).unwrap();
        *lock(&local.server) = Some(server);
        assert!(local.info(&place).running);
        let again = local.serve_with(&program, &place, &Launch::default(), &|| true, &mut |_| {}).unwrap();
        assert_eq!(again, port, "a running server is reused");
        local.let_cold_go(Duration::from_secs(60));
        assert!(local.info(&place).running, "still warm");
        local.let_cold_go(Duration::ZERO);
        assert!(!local.info(&place).running);
    }

    #[cfg(unix)]
    #[test]
    fn stops_waiting_when_told_or_too_long() {
        let place = temp("wait");
        fake_install(&place);
        let program = fake_server(&place, "echo loading; sleep 30");
        let mut server = Server::start(&program, &place, &Launch::default()).unwrap();
        let log = place.log();
        assert_eq!(server.wait_ready(&log, Duration::from_secs(5), &|| false, &mut |_| {}).unwrap_err(), "cancelled");
        let error = server.wait_ready(&log, Duration::ZERO, &|| true, &mut |_| {}).unwrap_err();
        assert!(error.contains("didn't start"), "{error}");
    }

    #[cfg(unix)]
    #[test]
    fn install_steps_report_and_fail_with_their_output() {
        let cancel = AtomicBool::new(false);
        let mut lines = Vec::new();
        let mut ok = Command::new("sh");
        ok.args(["-c", "echo 'Resolved 40 packages' >&2"]);
        run(ok, "uv", "Testing…", &cancel, &mut |l| lines.push(l.to_string())).unwrap();
        let mut bar = Command::new("sh");
        bar.args(["-c", "printf 'model.safetensors:  10%%\\rmodel.safetensors:  55%%\\r' >&2"]);
        run(bar, "the download", "Testing…", &cancel, &mut |l| lines.push(l.to_string())).unwrap();
        assert_eq!(lines.last().map(String::as_str), Some("model.safetensors:  55%"), "a redrawn progress bar reads as its last state");
        let mut bad = Command::new("sh");
        bad.args(["-c", "echo 'no torch for this Python' >&2; sleep 0.5; exit 2"]);
        let error = run(bad, "uv", "Testing…", &cancel, &mut |_| {}).unwrap_err();
        assert!(error.starts_with("uv failed") && error.contains("no torch for this Python"), "{error}");
        cancel.store(true, Ordering::SeqCst);
        let mut long = Command::new("sh");
        long.args(["-c", "sleep 30"]);
        assert_eq!(run(long, "uv", "Testing…", &cancel, &mut |_| {}).unwrap_err(), "cancelled");
        assert!(lines.contains(&"Resolved 40 packages".to_string()));
    }

    #[test]
    fn bundles_the_package_it_installs() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR"));
        let wheel = dir.join("resources").join("personaplex").join(WHEEL);
        assert!(wheel.is_file(), "missing {}: run `python -I scripts/personaplex-wheel.py`", wheel.display());
        let config: serde_json::Value = serde_json::from_str(&fs::read_to_string(dir.join("tauri.conf.json")).unwrap()).unwrap();
        let bundled = &config["bundle"]["resources"][format!("resources/personaplex/{WHEEL}")];
        assert_eq!(bundled, &serde_json::json!(format!("personaplex/{WHEEL}")), "where `init` looks for it");
    }

    #[test]
    fn says_when_the_app_lacks_its_package() {
        let place = temp("no-wheel");
        let error = install(&place, &place.0.join(WHEEL), &AtomicBool::new(false), &mut |_| {}).unwrap_err();
        assert!(error.contains("reinstall the app"), "{error}");
        assert!(!place.venv().exists(), "nothing was made");
    }

    #[test]
    fn reads_the_download_s_progress() {
        assert_eq!(progress_of("progress 6900000000 16700000000"), Some((6_900_000_000, 16_700_000_000)));
        assert_eq!(progress_of("progress 0 0"), Some((0, 0)));
        assert_eq!(progress_of("huggingface_hub.errors.GatedRepoError: 403 Client Error"), None);
        assert_eq!(progress_of("progress soon"), None);
        assert!(FETCH.contains("progress {now} {total}"), "what progress_of reads");
    }

    #[test]
    fn says_a_quiet_step_is_still_at_work() {
        let (now, soon) = (Duration::from_millis(500), Duration::from_secs(4));
        assert_eq!(step_line("Installing PyTorch…", "Resolved 10 packages", now, soon), "Resolved 10 packages");
        assert_eq!(step_line("Installing PyTorch…", "Resolved 10 packages", soon, Duration::from_secs(187)), "Installing PyTorch… 3:07");
        assert_eq!(clock(Duration::from_secs(3600 + 5)), "60:05");
    }

    #[test]
    fn reads_the_version_python_prints() {
        assert_eq!(parse_version("3 12\r\n"), Some((3, 12)));
        assert_eq!(parse_version("3"), None);
        assert_eq!(parse_version("Python was not found; run without arguments to install from the Microsoft Store"), None);
    }

    #[test]
    fn falls_back_to_pip_only_with_a_python_torch_supports() {
        match installer() {
            Ok(Installer::Uv(uv)) => assert!(uv.is_file()),
            Ok(Installer::Pip(python)) => {
                assert_eq!(python.version.0, 3);
                assert!(PYTHONS.contains(&python.version.1), "{python:?}");
            }
            Err(message) => assert!(message.contains("uv") && message.contains("pip"), "{message}"),
        }
        assert!(!PYTHONS.contains(&13), "torch < 2.5 has no wheels for Python 3.13");
    }

    #[cfg(unix)]
    #[test]
    fn reports_what_pip_writes_to_stdout() {
        let cancel = AtomicBool::new(false);
        let mut lines = Vec::new();
        let mut pip = Command::new("sh");
        pip.args(["-c", "echo 'Collecting torch<2.5'; sleep 0.3; echo 'Downloading torch-2.4.1.whl (797 MB)'"]);
        run(pip, "pip", "Testing…", &cancel, &mut |l| lines.push(l.to_string())).unwrap();
        assert_eq!(lines.last().map(String::as_str), Some("Downloading torch-2.4.1.whl (797 MB)"));
    }

    fn fake_weights(place: &Place) {
        let snapshot = place.hf().join("hub").join("models--nvidia--personaplex-7b-v1").join("snapshots").join("abc123");
        fs::create_dir_all(&snapshot).unwrap();
        for file in FILES {
            fs::write(snapshot.join(file), "").unwrap();
        }
    }

    #[test]
    fn has_the_model_only_with_every_file_the_server_needs() {
        let place = temp("weights");
        let local = Local::new(&place, PathBuf::new(), |_| {});
        assert_eq!(local.info(&place).model, Weights::Missing);
        fake_weights(&place);
        assert!(place.downloaded());
        assert_eq!(local.info(&place).model, Weights::Ready, "downloaded elsewhere, by the server's first start");
        let snapshots = place.hf().join("hub").join("models--nvidia--personaplex-7b-v1").join("snapshots");
        fs::remove_file(snapshots.join("abc123").join("model.safetensors")).unwrap();
        assert!(!place.downloaded(), "a download cut short isn't the model");
        let info = serde_json::to_value(local.info(&place)).unwrap();
        assert_eq!(info["model"], serde_json::json!({ "state": "missing" }));
        assert_eq!(info["state"], "missing");
    }

    #[test]
    fn says_what_the_download_lacks_before_starting() {
        let place = temp("fetch");
        let cancel = AtomicBool::new(false);
        let error = fetch_weights(&place, Some("hf_abc"), &cancel, &mut |_| {}).unwrap_err();
        assert!(error.contains("install it first"), "{error}");
        fake_install(&place);
        let error = fetch_weights(&place, None, &cancel, &mut |_| {}).unwrap_err();
        assert!(error.contains("Hugging Face token") && error.contains(REPO), "{error}");
    }

    #[test]
    fn reports_a_download_that_fails_then_forgets_it_with_the_folder() {
        let place = temp("download");
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = Arc::clone(&seen);
        let local = Arc::new(Local::new(&place, PathBuf::new(), move |info| lock(&log).push(info.model)));
        local.download(place.clone(), None).unwrap();
        let start = Instant::now();
        while !matches!(local.info(&place).model, Weights::Error { .. }) {
            assert!(start.elapsed() < Duration::from_secs(5), "the download never ended");
            thread::sleep(Duration::from_millis(10));
        }
        assert!(matches!(lock(&seen).first(), Some(Weights::Downloading { .. })));
        local.remove(&place).unwrap();
        assert_eq!(local.info(&place).model, Weights::Missing);
    }
}
