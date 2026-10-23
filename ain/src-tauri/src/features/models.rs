//! The model a feature runs on this machine (dictation's speech model, read aloud's voice): which
//! one the settings pick and where it is stored, its download, and its loaded engine, kept warm
//! while in use. Each feature lists its models (`Downloadable`) and loads them its own way.

use std::{
    io,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex, MutexGuard,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

use serde::Serialize;
use serde_json::Value;
use specta::Type;
use tauri::AppHandle;

use super::{
    download::{DownloadError, Status, base_in, remove},
    live::Live,
};
use crate::shell::settings;

/// A model a feature offers, downloaded on request into its own folder of the models folder.
pub trait Downloadable: Sync + 'static {
    /// What the feature's "model" setting stores.
    fn id(&self) -> &'static str;
    /// Its folder, inside the models folder.
    fn folder(&self) -> &'static str;
    /// Ready, or missing with its download size.
    fn status(&self, dir: &Path) -> Status;
    /// What a download starts at: its size, as known before it begins.
    fn size(&self) -> u64;
    /// Downloads it into the models folder `base`, calling `progress(received, total)` along the way.
    fn download(&self, base: &Path, cancel: &AtomicBool, progress: &mut dyn FnMut(u64, u64)) -> Result<(), DownloadError>;
}

/// The model with this id, or the first (the default).
pub fn find<M: Downloadable>(models: &'static [M], id: Option<&str>) -> &'static M {
    models.iter().find(|m| Some(m.id()) == id).unwrap_or(&models[0])
}

/// The ids of the models already downloaded in the models folder `base`.
pub fn installed_in<M: Downloadable>(models: &'static [M], base: &Path) -> Vec<&'static str> {
    models.iter().filter(|m| m.status(&base.join(m.folder())) == Status::Ready).map(|m| m.id()).collect()
}

/// The chosen model's status, the folder it is (or would be) stored in, and which models are downloaded.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
pub struct ModelInfo {
    model: &'static str,
    dir: String,
    installed: Vec<&'static str>,
    #[serde(flatten)]
    status: Status,
}

/// Which model the settings pick, and the models folder it goes in.
struct Place<M: 'static> {
    base: PathBuf,
    model: &'static M,
}

impl<M> Clone for Place<M> {
    fn clone(&self) -> Self {
        Self { base: self.base.clone(), model: self.model }
    }
}

impl<M: Downloadable> PartialEq for Place<M> {
    fn eq(&self, other: &Self) -> bool {
        self.base == other.base && self.model.id() == other.model.id()
    }
}

impl<M: Downloadable> Place<M> {
    fn dir(&self) -> PathBuf {
        self.base.join(self.model.folder())
    }
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// A feature's models of type `M`, run by engines of type `E`.
pub struct ModelStore<M: 'static, E> {
    feature: &'static str,
    models: &'static [M],
    /// The app's own data folder, used when no folder is chosen.
    default_dir: PathBuf,
    /// Follows the feature's "model" and "modelDir" settings.
    place: Mutex<Place<M>>,
    info: Live<ModelInfo>,
    /// Sends the feature's own "model changed" event.
    emit: fn(&AppHandle, ModelInfo),
    /// Loaded on first use, kept warm, let go once cold.
    engine: Mutex<Option<Arc<E>>>,
    last_used: Mutex<Instant>,
    downloading: AtomicBool,
    stop_download: AtomicBool,
}

impl<M: Downloadable, E: Send + Sync + 'static> ModelStore<M, E> {
    pub fn new(
        feature: &'static str,
        models: &'static [M],
        settings: &Value,
        default_dir: PathBuf,
        emit: fn(&AppHandle, ModelInfo),
    ) -> Self {
        let place = Self::read(feature, models, settings, &default_dir);
        Self {
            feature,
            models,
            info: Live::new(Self::describe(models, &place, place.model.status(&place.dir()))),
            place: Mutex::new(place),
            default_dir,
            emit,
            engine: Mutex::new(None),
            last_used: Mutex::new(Instant::now()),
            downloading: AtomicBool::new(false),
            stop_download: AtomicBool::new(false),
        }
    }

    fn read(feature: &str, models: &'static [M], settings: &Value, default: &Path) -> Place<M> {
        let option = |key: &str| settings::option(settings, feature, key).and_then(Value::as_str);
        Place { base: base_in(option("modelDir"), default), model: find(models, option("model")) }
    }

    fn describe(models: &'static [M], place: &Place<M>, status: Status) -> ModelInfo {
        ModelInfo {
            model: place.model.id(),
            dir: place.dir().to_string_lossy().into_owned(),
            installed: installed_in(models, &place.base),
            status,
        }
    }

    fn place(&self) -> Place<M> {
        lock(&self.place).clone()
    }

    /// The chosen model and its folder.
    pub fn chosen(&self) -> (&'static M, PathBuf) {
        let place = self.place();
        (place.model, place.dir())
    }

    pub fn ready(&self) -> bool {
        let (model, dir) = self.chosen();
        model.status(&dir) == Status::Ready
    }

    pub fn info(&self) -> ModelInfo {
        self.info.get()
    }

    fn publish(&self, app: &AppHandle, status: Status) {
        let info = Self::describe(self.models, &self.place(), status);
        if self.info.set(info.clone()) {
            (self.emit)(app, info);
        }
    }

    /// Re-reads the settings; when they pick another model or folder, that one is used from then
    /// on. A download in progress finishes first, then the new choice applies.
    pub fn follow_settings(&self, app: &AppHandle, settings: &Value) {
        let place = Self::read(self.feature, self.models, settings, &self.default_dir);
        if *lock(&self.place) == place || self.downloading.load(Ordering::SeqCst) {
            return;
        }
        *lock(&self.place) = place.clone();
        lock(&self.engine).take();
        self.publish(app, place.model.status(&place.dir()));
    }

    /// Starts downloading the chosen model in the background; progress goes out as it comes.
    pub fn download(self: &Arc<Self>, app: AppHandle) -> io::Result<()> {
        if self.downloading.swap(true, Ordering::SeqCst) {
            return Ok(());
        }
        self.stop_download.store(false, Ordering::SeqCst);
        let store = Arc::clone(self);
        let spawned = std::thread::Builder::new().name(format!("{}-download", self.feature)).spawn(move || {
            let place = store.place();
            store.publish(&app, Status::Downloading { received: 0, total: place.model.size() });
            let result = place.model.download(&place.base, &store.stop_download, &mut |received, total| {
                store.publish(&app, Status::Downloading { received, total });
            });
            let status = match result {
                Ok(()) => Status::Ready,
                Err(DownloadError::Cancelled) => place.model.status(&place.dir()),
                Err(e) => Status::Error { message: e.to_string() },
            };
            store.publish(&app, status);
            store.downloading.store(false, Ordering::SeqCst);
            // The user may have picked another model meanwhile.
            store.follow_settings(&app, &settings::current(&app));
        });
        if let Err(e) = spawned {
            self.downloading.store(false, Ordering::SeqCst);
            return Err(e);
        }
        Ok(())
    }

    /// Stops a download in progress, or deletes the downloaded model.
    pub fn remove(&self, app: &AppHandle) -> io::Result<()> {
        if self.downloading.load(Ordering::SeqCst) {
            self.stop_download.store(true, Ordering::SeqCst);
            return Ok(());
        }
        lock(&self.engine).take();
        let place = self.place();
        remove(&place.dir())?;
        self.publish(app, place.model.status(&place.dir()));
        Ok(())
    }

    /// The model's folder, or the nearest one that exists.
    pub fn existing_dir(&self) -> PathBuf {
        let dir = self.place().dir();
        dir.ancestors().find(|p| p.is_dir()).map(Path::to_path_buf).unwrap_or(dir)
    }

    /// The engine for the chosen model, loaded by `load` if needed (a caller waits while another loads it).
    pub fn engine(&self, load: impl FnOnce(&'static M, &Path) -> Result<E, String>) -> Result<Arc<E>, String> {
        let mut slot = lock(&self.engine);
        self.touch();
        if let Some(e) = &*slot {
            return Ok(Arc::clone(e));
        }
        let (model, dir) = self.chosen();
        let e = Arc::new(load(model, &dir)?);
        *slot = Some(Arc::clone(&e));
        Ok(e)
    }

    /// Notes the engine was just used, so it stays warm.
    pub fn touch(&self) {
        *lock(&self.last_used) = Instant::now();
    }

    /// Lets the engine go once unused for `keep`: it takes hundreds of MB of memory.
    pub fn let_cold_go(&self, keep: Duration) {
        if lock(&self.last_used).elapsed() >= keep {
            lock(&self.engine).take();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fake(&'static str);

    impl Downloadable for Fake {
        fn id(&self) -> &'static str {
            self.0
        }
        fn folder(&self) -> &'static str {
            self.0
        }
        fn status(&self, dir: &Path) -> Status {
            if dir.is_dir() { Status::Ready } else { Status::Missing { size: 1 } }
        }
        fn size(&self) -> u64 {
            1
        }
        fn download(&self, _: &Path, _: &AtomicBool, _: &mut dyn FnMut(u64, u64)) -> Result<(), DownloadError> {
            Ok(())
        }
    }

    const FAKES: &[Fake] = &[Fake("first"), Fake("second")];

    fn store(settings: Value, default: &Path) -> ModelStore<Fake, ()> {
        ModelStore::new("feature", FAKES, &settings, default.to_path_buf(), |_, _| {})
    }

    #[test]
    fn reads_the_chosen_model_and_folder() {
        let default = std::env::temp_dir().join("island-default");
        let chosen = std::env::temp_dir().join("island-chosen");
        let settings = serde_json::json!({ "options": { "feature": { "model": "second", "modelDir": chosen.to_str() } } });
        assert_eq!(store(settings, &default).chosen().1, chosen.join("second"));
        let (model, dir) = store(serde_json::json!({}), &default).chosen();
        assert_eq!((model.id(), dir), ("first", default.join("first")));
    }

    #[test]
    fn lists_the_downloaded_models() {
        let base = std::env::temp_dir().join(format!("island-models-test-{}", std::process::id()));
        remove(&base).unwrap();
        std::fs::create_dir_all(base.join("second")).unwrap();
        assert_eq!(installed_in(FAKES, &base), ["second"]);
        assert_eq!(find(FAKES, Some("gone")).id(), "first");
        remove(&base).unwrap();
    }

    #[test]
    fn keeps_the_engine_while_warm() {
        let store = store(serde_json::json!({}), &std::env::temp_dir());
        let first = store.engine(|_, _| Ok(())).unwrap();
        assert!(Arc::ptr_eq(&first, &store.engine(|_, _| Err("loaded again".into())).unwrap()));
        store.let_cold_go(Duration::ZERO);
        assert!(store.engine(|_, _| Err("cold".into())).is_err());
    }

    #[test]
    fn model_info_flattens_the_status() {
        let info = ModelInfo {
            model: "second",
            dir: "D:\\Models".into(),
            installed: vec!["first"],
            status: Status::Downloading { received: 1, total: 2 },
        };
        assert_eq!(
            serde_json::to_value(info).unwrap(),
            serde_json::json!({ "model": "second", "dir": "D:\\Models", "installed": ["first"], "state": "downloading", "received": 1, "total": 2 })
        );
    }
}
