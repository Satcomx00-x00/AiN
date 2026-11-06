//! The community plugin store: `store.yaml` catalogs read over the internet, never bundled, so
//! plugins can be listed without a new release. The official one is kept on the repository's
//! `store` branch (`AIN_STORE_URL` replaces it); users add their own in Settings → Plugins
//! (`general.storeSources`) and can turn the official one off (`general.officialStore`). Each entry
//! names a plugin and the git repository it lives in; installing downloads its entry file from
//! GitHub into the plugins folder, where it shows up off, like any plugin the user drops there.
//! When two stores list the same id, the first one read wins: the official store, then the user's
//! in their order.

use std::{collections::HashSet, fs, path::Path, thread};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use specta::Type;
use tauri::{AppHandle, Wry, async_runtime::spawn_blocking, plugin::TauriPlugin};

use crate::{
    Error, Res, config,
    shell::{extensions, settings},
};

/// The store and the plugins it lists are small text files.
const MAX_BYTES: u64 = 1024 * 1024;
/// More stores of the user's than this are ignored: each one is a request every time the store is read.
pub const MAX_SOURCES: usize = 16;

/// One plugin as written in `store.yaml`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
struct Listed {
    id: String,
    name: String,
    description: String,
    repo: String,
    /// The branch, tag or commit to install from; the repository's default branch if left out.
    #[serde(default)]
    branch: Option<String>,
    /// The plugin's file in the repository; `index.js` if left out.
    #[serde(default)]
    entry: Option<String>,
    /// The plugin's options, declared as its code declares them, so Settings can show them before
    /// it is turned on (its code doesn't run until then). The frontend checks them.
    #[serde(default)]
    options: Value,
}

#[derive(Debug, Deserialize)]
struct Catalog {
    version: u32,
    #[serde(default)]
    plugins: Vec<Listed>,
}

/// A plugin offered by the store, as the settings page shows it.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
pub struct Offer {
    pub id: String,
    pub name: String,
    pub description: String,
    /// The plugin's git repository, for people to read before installing.
    pub repo: String,
    /// Where it is installed in the plugins folder, e.g. "orbit-clock/index.js".
    pub file: String,
    /// Why it can't be installed from the app, e.g. a repository outside GitHub; `None` if it can.
    pub problem: Option<String>,
    /// Its options as the store declares them (`null` for none); the settings page checks them.
    #[specta(type = Option<specta_typescript::Unknown>)]
    pub options: Value,
    /// The store that lists it.
    pub source: String,
}

/// One store that was read, and why it couldn't be, if so.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
pub struct Source {
    pub url: String,
    /// Whether it's the official store, rather than one the user added.
    pub official: bool,
    /// Why it couldn't be read; `None` if it was.
    pub problem: Option<String>,
}

/// What the stores offer, and how reading each one went.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
pub struct Shelf {
    pub sources: Vec<Source>,
    pub plugins: Vec<Offer>,
}

/// Same rule as a plugin's id, so it is a safe folder name.
fn valid_id(id: &str) -> bool {
    (2..=32).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// A path inside a repository: plain names separated by `/`, ending in `.js`.
fn valid_entry(entry: &str) -> bool {
    entry.ends_with(".js")
        && entry.split('/').all(|part| {
            !part.is_empty() && part != "." && part != ".." && part.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
        })
}

/// A branch, tag or commit name usable in a URL.
fn valid_ref(git_ref: &str) -> bool {
    !git_ref.is_empty() && !git_ref.contains("..") && git_ref.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_./".contains(&b))
}

/// `owner/name` of a `https://github.com/owner/name` repository.
fn github(repo: &str) -> Option<(&str, &str)> {
    let path = repo.strip_prefix("https://github.com/")?.trim_end_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    let (owner, name) = path.split_once('/')?;
    let ok = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b));
    (ok(owner) && ok(name)).then_some((owner, name))
}

impl Listed {
    fn file(&self) -> String {
        format!("{}/index.js", self.id)
    }

    /// The raw URL of the plugin's file, or why it can't be installed.
    fn download_url(&self) -> Result<String, String> {
        let (owner, name) = github(&self.repo).ok_or("only GitHub repositories can be installed from the app")?;
        let git_ref = self.branch.as_deref().unwrap_or("HEAD");
        let entry = self.entry.as_deref().unwrap_or("index.js");
        if !valid_ref(git_ref) {
            return Err(format!("invalid branch \"{git_ref}\""));
        }
        if !valid_entry(entry) {
            return Err(format!("invalid entry \"{entry}\""));
        }
        Ok(format!("{}/{owner}/{name}/{git_ref}/{entry}", config::base(config::GITHUB_RAW_URL)))
    }

    fn offer(&self, source: &str) -> Offer {
        Offer {
            id: self.id.clone(),
            name: self.name.clone(),
            description: self.description.clone(),
            repo: self.repo.clone(),
            file: self.file(),
            problem: self.download_url().err(),
            options: self.options.clone(),
            source: source.to_owned(),
        }
    }
}

/// The plugins a `store.yaml` lists, without those with an unusable id or repository link.
fn parse(yaml: &str) -> Res<Vec<Listed>> {
    let catalog: Catalog = serde_yaml_ng::from_str(yaml).map_err(|e| Error::msg(format!("the store is malformed: {e}")))?;
    if catalog.version != 1 {
        return Err(Error::msg("the store needs a newer version of AiN"));
    }
    let mut seen = HashSet::new();
    Ok(catalog.plugins.into_iter().filter(|p| valid_id(&p.id) && p.repo.starts_with("https://") && seen.insert(p.id.clone())).collect())
}

fn get(url: &str) -> Res<String> {
    let mut response = super::net::agent().get(url).call().map_err(|e| Error::msg(format!("couldn't reach {url}: {e}")))?;
    response.body_mut().with_config().limit(MAX_BYTES).read_to_string().map_err(|e| Error::msg(format!("couldn't read {url}: {e}")))
}

/// A store's address as typed: trimmed, and only `http(s)`.
fn store_url(url: &str) -> Option<String> {
    let url = url.trim();
    (url.starts_with("https://") || url.starts_with("http://")).then(|| url.to_owned())
}

/// The stores to read, in order, from the saved settings: the official one unless turned off, then
/// at most `MAX_SOURCES` of the user's, without blanks, repeats, or anything but `http(s)`.
fn sources(settings: &Value) -> Vec<(String, bool)> {
    let general = |key| settings.get("general").and_then(|g| g.get(key));
    let official = general("officialStore").and_then(Value::as_bool).unwrap_or(true).then(|| config::STORE_URL.get());
    let mut seen: HashSet<String> = official.iter().cloned().collect();
    let added = general("storeSources").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).filter_map(store_url);
    let added: Vec<String> = added.filter(|url| seen.insert(url.clone())).take(MAX_SOURCES).collect();
    official.into_iter().map(|url| (url, true)).chain(added.into_iter().map(|url| (url, false))).collect()
}

/// A store, read and parsed.
struct Read {
    source: Source,
    plugins: Vec<Listed>,
}

/// Reads one store; a failure is kept as its problem.
fn read(url: String, official: bool) -> Read {
    let (plugins, problem) = match get(&url).and_then(|yaml| parse(&yaml)) {
        Ok(plugins) => (plugins, None),
        Err(e) => (vec![], Some(e.to_string())),
    };
    Read { source: Source { url, official, problem }, plugins }
}

/// Reads every store at once; one that fails doesn't keep the others from being listed.
fn read_all(sources: Vec<(String, bool)>) -> Vec<Read> {
    thread::scope(|scope| {
        let reads: Vec<_> = sources.into_iter().map(|(url, official)| scope.spawn(move || read(url, official))).collect();
        reads.into_iter().map(|r| r.join().unwrap_or_else(|panic| std::panic::resume_unwind(panic))).collect()
    })
}

/// The plugins of every store read, each with its store's URL; the first store listing an id wins.
type Listing = (Vec<Source>, Vec<(Listed, String)>);

/// What the stores offer; an error only when there were stores and none could be read.
fn merge(reads: Vec<Read>) -> Res<Listing> {
    if !reads.is_empty() && reads.iter().all(|r| r.source.problem.is_some()) {
        return Err(Error::msg(reads.iter().filter_map(|r| r.source.problem.as_deref()).collect::<Vec<_>>().join("; ")));
    }
    let mut seen = HashSet::new();
    let mut plugins = vec![];
    let sources = reads
        .into_iter()
        .map(|Read { source, plugins: listed }| {
            plugins.extend(listed.into_iter().filter(|p| seen.insert(p.id.clone())).map(|p| (p, source.url.clone())));
            source
        })
        .collect();
    Ok((sources, plugins))
}

async fn fetch(app: &AppHandle) -> Res<Listing> {
    let sources = sources(&settings::current(app));
    spawn_blocking(move || merge(read_all(sources))).await.map_err(|_| Error::WorkerGone)?
}

/// The stores' entry for `id`.
fn find(plugins: Vec<(Listed, String)>, id: &str) -> Res<Listed> {
    plugins.into_iter().map(|(p, _)| p).find(|p| p.id == id).ok_or_else(|| Error::msg(format!("\"{id}\" is no longer in the store")))
}

async fn listed(app: &AppHandle, id: &str) -> Res<Listed> {
    find(fetch(app).await?.1, id)
}

/// Writes a downloaded plugin into the plugins folder `dir`, replacing an older copy; returns its file.
fn save(dir: &Path, plugin: &Listed, source: &str) -> Res<String> {
    let folder = dir.join(&plugin.id);
    fs::create_dir_all(&folder)?;
    fs::write(folder.join("index.js"), source)?;
    Ok(plugin.file())
}

/// The plugins the store offers, read afresh.
#[tauri::command]
#[specta::specta]
async fn catalog(app: AppHandle) -> Res<Shelf> {
    let (sources, plugins) = fetch(&app).await?;
    Ok(Shelf { sources, plugins: plugins.iter().map(|(p, source)| p.offer(source)).collect() })
}

/// Downloads a store plugin into the plugins folder (replacing an older copy), and returns its file.
/// It isn't turned on: the user does that, as for any plugin.
#[tauri::command]
#[specta::specta]
async fn install(app: AppHandle, id: String) -> Res<String> {
    // Looked up again rather than trusting a URL from the page.
    let plugin = listed(&app, &id).await?;
    let url = plugin.download_url().map_err(Error::msg)?;
    let source = spawn_blocking(move || get(&url)).await.map_err(|_| Error::WorkerGone)??;
    save(&extensions::dir(&app)?, &plugin, &source)
}

/// Opens a store plugin's repository in the browser.
#[tauri::command]
#[specta::specta]
async fn open_repo(app: AppHandle, id: String) -> Res<()> {
    let plugin = listed(&app, &id).await?;
    crate::platform::open_url(&plugin.repo)?;
    Ok(())
}

crate::ipc::store!();

pub fn init() -> TauriPlugin<Wry> {
    ipc().plugin(|_| Ok(()))
}

#[cfg(test)]
mod tests {
    use super::*;

    const STORE: &str = r#"
version: 1
plugins:
  - id: orbit-clock
    name: Orbit clock
    description: An analog clock.
    repo: https://github.com/Satcomx00-x00/AiN
    branch: plugin-template
  - id: elsewhere
    name: Elsewhere
    description: Hosted outside GitHub.
    repo: https://gitlab.com/someone/elsewhere
  - id: Bad_Id
    name: Bad
    description: Refused.
    repo: https://github.com/a/b
  - id: orbit-clock
    name: Duplicate
    description: Refused, the id is taken.
    repo: https://github.com/a/b
"#;

    #[test]
    fn lists_valid_plugins_once() {
        let plugins = parse(STORE).unwrap();
        let ids: Vec<&str> = plugins.iter().map(|p| p.id.as_str()).collect();
        assert_eq!(ids, ["orbit-clock", "elsewhere"]);
        assert_eq!(plugins[0].download_url().unwrap(), "https://raw.githubusercontent.com/Satcomx00-x00/AiN/plugin-template/index.js");
        assert_eq!(plugins[0].offer("s").file, "orbit-clock/index.js");
        assert!(plugins[1].offer("s").problem.is_some());
    }

    #[test]
    fn defaults_to_the_default_branch_and_index_js() {
        let plugins = parse("version: 1\nplugins:\n  - { id: ab, name: A, description: B, repo: https://github.com/o/r.git }").unwrap();
        assert_eq!(plugins[0].download_url().unwrap(), "https://raw.githubusercontent.com/o/r/HEAD/index.js");
    }

    #[test]
    fn refuses_paths_that_leave_the_repository() {
        assert!(!valid_entry("../secret.js"));
        assert!(!valid_entry("/abs.js"));
        assert!(!valid_entry("index.ts"));
        assert!(valid_entry("dist/plugin.js"));
        assert!(!valid_ref("a/../b"));
        assert!(github("https://github.com/only-owner").is_none());
        assert!(github("https://github.com.evil/o/r").is_none());
    }

    #[test]
    fn finds_a_plugin_by_id_or_says_it_is_gone() {
        let listed = || parse(STORE).unwrap().into_iter().map(|p| (p, String::new())).collect::<Vec<_>>();
        assert_eq!(find(listed(), "elsewhere").unwrap().name, "Elsewhere");
        let gone = find(listed(), "removed").unwrap_err().to_string();
        assert_eq!(gone, "\"removed\" is no longer in the store");
    }

    #[test]
    fn installs_where_the_plugins_folder_finds_it_and_replaces_an_older_copy() {
        let dir = std::env::temp_dir().join(format!("island-store-{}", std::process::id()));
        let plugin = &parse(STORE).unwrap()[0];
        assert_eq!(save(&dir, plugin, "export default () => 1").unwrap(), "orbit-clock/index.js");
        assert_eq!(save(&dir, plugin, "export default () => 2").unwrap(), "orbit-clock/index.js");
        let found: Vec<String> = extensions::entries(&dir).into_iter().map(|(file, _)| file).collect();
        assert_eq!(found, ["orbit-clock/index.js"]);
        assert_eq!(fs::read_to_string(dir.join("orbit-clock/index.js")).unwrap(), "export default () => 2");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn ignores_fields_it_does_not_know_and_links_that_are_not_https() {
        let yaml = "version: 1
plugins:
  - { id: ab, name: A, description: B, repo: https://github.com/o/r, author: someone }
  - { id: cd, name: C, description: D, repo: http://github.com/o/r }";
        let ids: Vec<String> = parse(yaml).unwrap().into_iter().map(|p| p.id).collect();
        assert_eq!(ids, ["ab"]);
    }

    #[test]
    fn passes_on_the_options_an_entry_declares() {
        let yaml = "version: 1
plugins:
  - id: weather
    name: Weather
    description: The forecast.
    repo: https://github.com/o/r
    options:
      city: { kind: text, label: City, default: Paris, required: true }
      apiKey: { kind: secret, label: API key, default: '' }
  - { id: ab, name: A, description: B, repo: https://github.com/o/r }";
        let offers: Vec<Offer> = parse(yaml).unwrap().iter().map(|p| p.offer("s")).collect();
        assert_eq!(offers[0].options["city"]["label"], "City");
        assert_eq!(offers[0].options["city"]["required"], true);
        assert_eq!(offers[0].options["apiKey"]["kind"], "secret");
        assert!(offers[1].options.is_null());
    }

    #[test]
    fn says_what_is_missing_from_an_entry() {
        let err = parse(
            "version: 1
plugins:
  - { id: ab, name: A }",
        )
        .unwrap_err()
        .to_string();
        assert!(err.starts_with("the store is malformed"), "{err}");
    }

    /// The published store parses and its plugins download. Needs the internet: `cargo test -- --ignored`.
    #[test]
    #[ignore]
    fn the_published_store_works() {
        let plugins = parse(&get(&config::STORE_URL.get()).unwrap()).unwrap();
        assert!(!plugins.is_empty());
        for plugin in plugins.iter().filter(|p| p.download_url().is_ok()) {
            let source = get(&plugin.download_url().unwrap()).unwrap();
            assert!(source.contains("export default"), "{} isn't a plugin", plugin.id);
        }
    }

    fn read_ok(url: &str, official: bool, yaml: &str) -> Read {
        Read { source: Source { url: url.into(), official, problem: None }, plugins: parse(yaml).unwrap() }
    }

    fn read_failed(url: &str) -> Read {
        Read { source: Source { url: url.into(), official: false, problem: Some(format!("couldn't reach {url}")) }, plugins: vec![] }
    }

    #[test]
    fn reads_the_official_store_then_the_users_once_each() {
        let official = config::STORE_URL.get();
        let settings = serde_json::json!({ "general": { "storeSources": [" https://a/store.yaml ", "ftp://b", "", 3, "https://a/store.yaml", official, "http://c/s.yaml"] } });
        assert_eq!(
            sources(&settings),
            [(official.clone(), true), ("https://a/store.yaml".into(), false), ("http://c/s.yaml".into(), false)]
        );
        assert_eq!(sources(&Value::Null), [(official, true)]);
        let off = serde_json::json!({ "general": { "officialStore": false, "storeSources": ["https://a/store.yaml"] } });
        assert_eq!(sources(&off), [("https://a/store.yaml".to_owned(), false)]);
        let many: Vec<String> = (0..40).map(|i| format!("https://s{i}/store.yaml")).collect();
        assert_eq!(sources(&serde_json::json!({ "general": { "officialStore": false, "storeSources": many } })).len(), MAX_SOURCES);
    }

    #[test]
    fn merges_stores_the_first_to_list_an_id_winning() {
        let first = "version: 1\nplugins:\n  - { id: ab, name: First, description: B, repo: https://github.com/o/r }";
        let second = "version: 1\nplugins:\n  - { id: ab, name: Second, description: B, repo: https://github.com/o/r }\n  - { id: cd, name: C, description: D, repo: https://github.com/o/r }";
        let (sources, plugins) =
            merge(vec![read_ok("https://one", true, first), read_failed("https://down"), read_ok("https://two", false, second)]).unwrap();
        let listed: Vec<(&str, &str, &str)> = plugins.iter().map(|(p, s)| (p.id.as_str(), p.name.as_str(), s.as_str())).collect();
        assert_eq!(listed, [("ab", "First", "https://one"), ("cd", "C", "https://two")]);
        assert_eq!(sources.iter().map(|s| s.problem.is_some()).collect::<Vec<_>>(), [false, true, false]);
    }

    #[test]
    fn fails_only_when_no_store_could_be_read() {
        let err = merge(vec![read_failed("https://a"), read_failed("https://b")]).unwrap_err().to_string();
        assert_eq!(err, "couldn't reach https://a; couldn't reach https://b");
        assert_eq!(merge(vec![]).unwrap(), (vec![], vec![]));
    }

    #[test]
    fn refuses_another_store_version_and_malformed_files() {
        assert!(parse("version: 2\nplugins: []").is_err());
        assert!(parse("plugins: [").is_err());
        assert!(parse("version: 1").unwrap().is_empty());
    }
}
