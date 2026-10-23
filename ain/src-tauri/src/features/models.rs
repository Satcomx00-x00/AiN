//! The model a feature runs on this machine (dictation's speech model, read aloud's voice): which
//! one the settings pick and where it is stored, its download, and its loaded engines. Each model
//! loaded stays warm while in use, side by side with the others (switching back costs no reload),
//! and the chosen one can be kept loaded for good. Each feature lists its models (`Downloadable`)
//! and loads them its own way (`Loader`).

use std::{
    collections::HashMap,
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

/// Loads a model's engine from its folder.
pub type Loader<M, E> = fn(&'static M, &Path) -> Result<E, String>;

/// The "keepLoaded" setting: the chosen model stays loaded instead of being let go once cold.
fn keep_loaded(feature: &str, settings: &Value) -> bool {
    settings::option(settings, feature, "keepLoaded").and_then(Value::as_bool).unwrap_or(false)
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

/// An engine in memory, and when it was last used.
struct Loaded<E> {
    engine: Arc<E>,
    used: Instant,
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
    load: Loader<M, E>,
    /// By model id: loaded on first use, kept warm, let go once cold (unless kept loaded).
    engines: Mutex<HashMap<&'static str, Loaded<E>>>,
    keep_loaded: AtomicBool,
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
        load: Loader<M, E>,
    ) -> Self {
        let place = Self::read(feature, models, settings, &default_dir);
        Self {
            feature,
            models,
            info: Live::new(Self::describe(models, &place, place.model.status(&place.dir()))),
            place: Mutex::new(place),
            default_dir,
            emit,
            load,
            engines: Mutex::default(),
            keep_loaded: AtomicBool::new(keep_loaded(feature, settings)),
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
    /// on, while the one before stays warm a while. A download in progress finishes first, then the
    /// new choice applies.
    pub fn follow_settings(self: &Arc<Self>, app: &AppHandle, settings: &Value) {
        self.keep_loaded.store(keep_loaded(self.feature, settings), Ordering::SeqCst);
        let place = Self::read(self.feature, self.models, settings, &self.default_dir);
        if *lock(&self.place) != place && !self.downloading.load(Ordering::SeqCst) {
            if lock(&self.place).base != place.base {
                // Same ids, other files: what is loaded no longer matches.
                lock(&self.engines).clear();
            }
            *lock(&self.place) = place.clone();
            self.publish(app, place.model.status(&place.dir()));
        }
        self.preload();
    }

    /// Loads the chosen model in the background when it is to stay loaded and isn't yet.
    pub fn preload(self: &Arc<Self>) {
        let wanted = self.keep_loaded.load(Ordering::SeqCst) && !self.downloading.load(Ordering::SeqCst) && self.ready();
        if !wanted || lock(&self.engines).contains_key(self.chosen().0.id()) {
            return;
        }
        let store = Arc::clone(self);
        let spawned = std::thread::Builder::new().name(format!("{}-preload", self.feature)).spawn(move || {
            if let Err(e) = store.engine() {
                eprintln!("island: {}: {e}", store.feature);
            }
        });
        if let Err(e) = spawned {
            eprintln!("island: {}: {e}", self.feature);
        }
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
            // The user may have picked another model meanwhile; this also preloads it if asked.
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
        let place = self.place();
        lock(&self.engines).remove(place.model.id());
        remove(&place.dir())?;
        self.publish(app, place.model.status(&place.dir()));
        Ok(())
    }

    /// The model's folder, or the nearest one that exists.
    pub fn existing_dir(&self) -> PathBuf {
        let dir = self.place().dir();
        dir.ancestors().find(|p| p.is_dir()).map(Path::to_path_buf).unwrap_or(dir)
    }

    /// The engine for the chosen model, loaded if needed (a caller waits while another loads one).
    pub fn engine(&self) -> Result<Arc<E>, String> {
        let mut engines = lock(&self.engines);
        let (model, dir) = self.chosen();
        if let Some(loaded) = engines.get_mut(model.id()) {
            loaded.used = Instant::now();
            return Ok(Arc::clone(&loaded.engine));
        }
        let engine = Arc::new((self.load)(model, &dir)?);
        engines.insert(model.id(), Loaded { engine: Arc::clone(&engine), used: Instant::now() });
        Ok(engine)
    }

    /// Notes the chosen model's engine was just used, so it stays warm.
    pub fn touch(&self) {
        if let Some(loaded) = lock(&self.engines).get_mut(self.chosen().0.id()) {
            loaded.used = Instant::now();
        }
    }

    /// The ids of the models loaded now.
    #[cfg(test)]
    pub fn loaded(&self) -> Vec<&'static str> {
        let mut ids: Vec<_> = lock(&self.engines).keys().copied().collect();
        ids.sort_unstable();
        ids
    }

    /// Lets each engine go once unused for `keep` (they take hundreds of MB of memory), but the
    /// chosen one when kept loaded. Skipped while one is loading, so the caller never waits.
    pub fn let_cold_go(&self, keep: Duration) {
        let Ok(mut engines) = self.engines.try_lock() else { return };
        let pinned = self.keep_loaded.load(Ordering::SeqCst).then(|| self.chosen().0.id());
        engines.retain(|id, loaded| Some(*id) == pinned || loaded.used.elapsed() < keep);
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

    fn store(settings: Value, default: &Path) -> ModelStore<Fake, &'static str> {
        ModelStore::new("feature", FAKES, &settings, default.to_path_buf(), |_, _| {}, |model, _| Ok(model.id()))
    }

    fn choose(store: &ModelStore<Fake, &'static str>, model: &'static str) {
        lock(&store.place).model = find(FAKES, Some(model));
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
        let first = store.engine().unwrap();
        assert!(Arc::ptr_eq(&first, &store.engine().unwrap()));
        store.let_cold_go(Duration::ZERO);
        assert!(store.loaded().is_empty());
    }

    #[test]
    fn keeps_several_models_loaded_side_by_side() {
        let store = store(serde_json::json!({}), &std::env::temp_dir());
        assert_eq!(*store.engine().unwrap(), "first");
        choose(&store, "second");
        assert_eq!(*store.engine().unwrap(), "second");
        assert_eq!(store.loaded(), ["first", "second"]);
        store.let_cold_go(Duration::from_secs(60));
        assert_eq!(store.loaded(), ["first", "second"]);
    }

    #[test]
    fn a_kept_model_outlives_the_cold() {
        let settings = serde_json::json!({ "options": { "feature": { "keepLoaded": true } } });
        let store = store(settings, &std::env::temp_dir());
        store.engine().unwrap();
        choose(&store, "second");
        store.engine().unwrap();
        store.let_cold_go(Duration::ZERO);
        assert_eq!(store.loaded(), ["second"]);
    }

    #[test]
    fn reads_keep_loaded() {
        assert!(keep_loaded("feature", &serde_json::json!({ "options": { "feature": { "keepLoaded": true } } })));
        assert!(!keep_loaded("feature", &serde_json::json!({})));
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
