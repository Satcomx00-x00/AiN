//! The community plugin store: a `store.yaml` kept on the repository's `store` branch and read over
//! the internet, never bundled, so plugins can be listed without a new release. Each entry names a
//! plugin and the git repository it lives in; installing downloads its entry file from GitHub into
//! the plugins folder, where it shows up off, like any plugin the user drops there.

use std::{fs, path::Path};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use specta::Type;
use tauri::{AppHandle, Wry, async_runtime::spawn_blocking, plugin::TauriPlugin};

use crate::{Error, Res, shell::extensions};

/// Where the store is read from.
pub const URL: &str = "https://raw.githubusercontent.com/Satcomx00-x00/AiN/store/store.yaml";
/// The store and the plugins it lists are small text files.
const MAX_BYTES: u64 = 1024 * 1024;

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
}

/// What the store offers, or why it couldn't be read.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
pub struct Shelf {
    pub url: String,
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
        Ok(format!("https://raw.githubusercontent.com/{owner}/{name}/{git_ref}/{entry}"))
    }

    fn offer(&self) -> Offer {
        Offer {
            id: self.id.clone(),
            name: self.name.clone(),
            description: self.description.clone(),
            repo: self.repo.clone(),
            file: self.file(),
            problem: self.download_url().err(),
            options: self.options.clone(),
        }
    }
}

/// The plugins a `store.yaml` lists, without those with an unusable id or repository link.
fn parse(yaml: &str) -> Res<Vec<Listed>> {
    let catalog: Catalog = serde_yaml_ng::from_str(yaml).map_err(|e| Error::msg(format!("the store is malformed: {e}")))?;
    if catalog.version != 1 {
        return Err(Error::msg("the store needs a newer version of AiN"));
    }
    let mut seen = std::collections::HashSet::new();
    Ok(catalog.plugins.into_iter().filter(|p| valid_id(&p.id) && p.repo.starts_with("https://") && seen.insert(p.id.clone())).collect())
}

fn get(url: &str) -> Res<String> {
    let mut response = super::net::agent().get(url).call().map_err(|e| Error::msg(format!("couldn't reach {url}: {e}")))?;
    response.body_mut().with_config().limit(MAX_BYTES).read_to_string().map_err(|e| Error::msg(format!("couldn't read {url}: {e}")))
}

async fn fetch() -> Res<Vec<Listed>> {
    spawn_blocking(|| parse(&get(URL)?)).await.map_err(|_| Error::WorkerGone)?
}

/// The store's entry for `id`.
fn find(plugins: Vec<Listed>, id: &str) -> Res<Listed> {
    plugins.into_iter().find(|p| p.id == id).ok_or_else(|| Error::msg(format!("\"{id}\" is no longer in the store")))
}

async fn listed(id: &str) -> Res<Listed> {
    find(fetch().await?, id)
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
async fn catalog() -> Res<Shelf> {
    Ok(Shelf { url: URL.into(), plugins: fetch().await?.iter().map(Listed::offer).collect() })
}

/// Downloads a store plugin into the plugins folder (replacing an older copy), and returns its file.
/// It isn't turned on: the user does that, as for any plugin.
#[tauri::command]
#[specta::specta]
async fn install(app: AppHandle, id: String) -> Res<String> {
    // Looked up again rather than trusting a URL from the page.
    let plugin = listed(&id).await?;
    let url = plugin.download_url().map_err(Error::msg)?;
    let source = spawn_blocking(move || get(&url)).await.map_err(|_| Error::WorkerGone)??;
    save(&extensions::dir(&app)?, &plugin, &source)
}

/// Opens a store plugin's repository in the browser.
#[tauri::command]
#[specta::specta]
async fn open_repo(id: String) -> Res<()> {
    let plugin = listed(&id).await?;
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
        assert_eq!(plugins[0].offer().file, "orbit-clock/index.js");
        assert!(plugins[1].offer().problem.is_some());
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
        assert_eq!(find(parse(STORE).unwrap(), "elsewhere").unwrap().name, "Elsewhere");
        let gone = find(parse(STORE).unwrap(), "removed").unwrap_err().to_string();
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
        let offers: Vec<Offer> = parse(yaml).unwrap().iter().map(Listed::offer).collect();
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
        let plugins = parse(&get(URL).unwrap()).unwrap();
        assert!(!plugins.is_empty());
        for plugin in plugins.iter().filter(|p| p.download_url().is_ok()) {
            let source = get(&plugin.download_url().unwrap()).unwrap();
            assert!(source.contains("export default"), "{} isn't a plugin", plugin.id);
        }
    }

    #[test]
    fn refuses_another_store_version_and_malformed_files() {
        assert!(parse("version: 2\nplugins: []").is_err());
        assert!(parse("plugins: [").is_err());
        assert!(parse("version: 1").unwrap().is_empty());
    }
}
