//! An index of the user's files by name: the home folder (and any folders the settings add),
//! walked in the background a few levels deep, breadth-first, skipping hidden and generated
//! folders. Searching it never touches the disk; browsing a typed path reads just that folder.

use std::{
    collections::VecDeque,
    fs,
    path::{Path, PathBuf},
    sync::{
        Arc, RwLock,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::{Duration, Instant},
};

use serde::Serialize;
use specta::Type;

/// Walked again when searched after this long.
const FRESH: Duration = Duration::from_secs(5 * 60);
const MAX_ITEMS: usize = 60_000;
const MAX_DEPTH: usize = 6;
/// Folders that tools build, download or manage: many files, none the user is looking for.
const SKIPPED: &[&str] = &["node_modules", "__pycache__", "site-packages", "venv", "target", "AppData", "Library"];
/// Folders that are one document or app (macOS packages): listed, not entered.
const PACKAGES: &[&str] = &["app", "bundle", "framework", "photoslibrary", "musiclibrary", "tvlibrary", "xcodeproj", "xcworkspace"];

/// A file or folder found, as the palette shows it.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    pub path: String,
    pub name: String,
    /// The folder it is in, with `~` for the home folder.
    pub folder: String,
    pub dir: bool,
}

pub fn hit(path: &Path, dir: bool, home: Option<&Path>) -> Hit {
    let name = path.file_name().map_or_else(|| path.display().to_string(), |n| n.to_string_lossy().into_owned());
    let folder = path.parent().map_or_else(String::new, |parent| match home.and_then(|h| parent.strip_prefix(h).ok()) {
        Some(rest) if rest.as_os_str().is_empty() => "~".into(),
        Some(rest) => format!("~{}{}", std::path::MAIN_SEPARATOR, rest.display()),
        None => parent.display().to_string(),
    });
    Hit { path: path.display().to_string(), name, folder, dir }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Item {
    pub path: PathBuf,
    pub dir: bool,
    /// The name, lowercase, as searched.
    name: String,
    depth: usize,
}

fn hidden(name: &str, _entry: &fs::DirEntry) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const HIDDEN: u32 = 0x2;
        if _entry.metadata().is_ok_and(|m| m.file_attributes() & HIDDEN != 0) {
            return true;
        }
    }
    name.starts_with('.') || name.starts_with('$')
}

fn package(name: &str) -> bool {
    Path::new(name).extension().is_some_and(|ext| PACKAGES.iter().any(|p| ext.eq_ignore_ascii_case(p)))
}

/// Everything under `roots`, shallowest first, up to `max` items. Symbolic links are listed but
/// not followed, so a loop can't trap the walk.
pub fn walk(roots: &[PathBuf], max: usize) -> Vec<Item> {
    let mut items = Vec::new();
    let mut queue: VecDeque<(PathBuf, usize)> = roots.iter().map(|r| (r.clone(), 1)).collect();
    while let Some((dir, depth)) = queue.pop_front() {
        let Ok(read) = fs::read_dir(&dir) else { continue };
        for entry in read.flatten() {
            if items.len() >= max {
                return items;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if hidden(&name, &entry) || SKIPPED.contains(&name.as_str()) {
                continue;
            }
            let Ok(kind) = entry.file_type() else { continue };
            let path = entry.path();
            if kind.is_dir() && depth < MAX_DEPTH && !package(&name) {
                queue.push_back((path.clone(), depth + 1));
            }
            items.push(Item { path, dir: kind.is_dir(), name: name.to_lowercase(), depth });
        }
    }
    items
}

/// How well `name` (lowercase) matches the query's `words`, or `None` when a word is missing:
/// a word at the start counts most, then one starting a word, then one inside.
fn score(name: &str, words: &[&str], whole: &str) -> Option<u32> {
    let mut score = 0;
    for word in words {
        let at = name.find(word)?;
        let starts_word = name[..at].chars().next_back().is_some_and(|c| !c.is_alphanumeric());
        score += match at {
            0 => 30,
            _ if starts_word => 20,
            _ => 8,
        };
    }
    let stem = name.rsplit_once('.').map_or(name, |(stem, _)| stem);
    if name == whole || stem == whole {
        score += 60;
    }
    Some(score)
}

/// The items matching every word of `query`, best first: by score, then shallower, then shorter.
pub fn rank<'a>(items: &'a [Item], query: &str, limit: usize) -> Vec<&'a Item> {
    let whole = query.trim().to_lowercase();
    let words: Vec<&str> = whole.split_whitespace().collect();
    if words.is_empty() {
        return Vec::new();
    }
    let mut found: Vec<(u32, &Item)> = items.iter().filter_map(|item| Some((score(&item.name, &words, &whole)?, item))).collect();
    found.sort_by(|(a, x), (b, y)| b.cmp(a).then(x.depth.cmp(&y.depth)).then(x.name.len().cmp(&y.name.len())).then(x.name.cmp(&y.name)));
    found.into_iter().take(limit).map(|(_, item)| item).collect()
}

/// `input` as an absolute path, with a leading `~` meaning the home folder; `None` when relative.
pub fn expand(input: &str, home: Option<&Path>) -> Option<PathBuf> {
    let path = match input.strip_prefix('~') {
        Some("") => home?.to_path_buf(),
        Some(rest) if rest.starts_with(['/', '\\']) => home?.join(rest.trim_start_matches(['/', '\\'])),
        Some(_) => return None,
        None => PathBuf::from(input),
    };
    path.is_absolute().then_some(path)
}

/// What a path being typed points at: the entries of its folder whose name starts with its last
/// part (all of them after a trailing separator), folders first. Hidden ones only when the last
/// part starts with a dot.
pub fn browse(input: &str, home: Option<&Path>, limit: usize) -> Vec<(PathBuf, bool)> {
    let Some(path) = expand(input, home) else { return Vec::new() };
    let (dir, partial) = match input.ends_with(['/', '\\']) || input == "~" {
        true => (path.as_path(), String::new()),
        false => match (path.parent(), path.file_name()) {
            (Some(parent), Some(name)) => (parent, name.to_string_lossy().to_lowercase()),
            _ => (path.as_path(), String::new()),
        },
    };
    let Ok(read) = fs::read_dir(dir) else { return Vec::new() };
    let mut found: Vec<(PathBuf, bool, String)> = read
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            let lower = name.to_lowercase();
            let shown = lower.starts_with(&partial) && (partial.starts_with('.') || !hidden(&name, &entry));
            shown.then(|| (entry.path(), entry.file_type().is_ok_and(|t| t.is_dir()), lower))
        })
        .collect();
    found.sort_by(|(_, a, x), (_, b, y)| b.cmp(a).then(x.cmp(y)));
    found.into_iter().take(limit).map(|(path, dir, _)| (path, dir)).collect()
}

#[derive(Default)]
struct Snapshot {
    roots: Vec<PathBuf>,
    items: Arc<Vec<Item>>,
    built: Option<Instant>,
}

/// The index, shared between searches and the thread walking the folders.
#[derive(Default)]
pub struct Index {
    snapshot: RwLock<Snapshot>,
    walking: AtomicBool,
}

impl Index {
    pub fn new() -> Arc<Self> {
        Arc::default()
    }

    /// Sets the folders to index (none turns it off); a change is walked at the next search.
    pub fn set_roots(&self, roots: Vec<PathBuf>) {
        let mut snapshot = self.snapshot.write().unwrap_or_else(|e| e.into_inner());
        if snapshot.roots != roots {
            *snapshot = Snapshot { roots, ..Snapshot::default() };
        }
    }

    /// Up to `limit` items matching `query`, best first. Starts a walk in the background when the
    /// index is missing or old; until it ends, searches see the previous one.
    pub fn search(self: &Arc<Self>, query: &str, limit: usize) -> Vec<Item> {
        let (items, stale, roots) = {
            let s = self.snapshot.read().unwrap_or_else(|e| e.into_inner());
            (Arc::clone(&s.items), s.built.is_none_or(|at| at.elapsed() > FRESH), s.roots.clone())
        };
        if stale && !roots.is_empty() && !self.walking.swap(true, Ordering::SeqCst) {
            let index = Arc::clone(self);
            let spawned = thread::Builder::new().name("palette-files".into()).spawn(move || {
                let items = Arc::new(walk(&roots, MAX_ITEMS));
                let mut s = index.snapshot.write().unwrap_or_else(|e| e.into_inner());
                // The settings may have changed the folders meanwhile: then this walk is stale.
                if s.roots == roots {
                    s.items = items;
                    s.built = Some(Instant::now());
                }
                drop(s);
                index.walking.store(false, Ordering::SeqCst);
            });
            if spawned.is_err() {
                self.walking.store(false, Ordering::SeqCst);
            }
        }
        rank(&items, query, limit).into_iter().cloned().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A folder tree under the system's temporary folder, removed when dropped.
    struct Tree(PathBuf);

    impl Tree {
        fn new(name: &str, files: &[&str]) -> Self {
            let root = std::env::temp_dir().join(format!("ain-palette-{name}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&root);
            for file in files {
                let path = root.join(file);
                if file.ends_with('/') {
                    fs::create_dir_all(&path).unwrap();
                } else {
                    fs::create_dir_all(path.parent().unwrap()).unwrap();
                    fs::write(&path, "").unwrap();
                }
            }
            Self(root)
        }
    }

    impl Drop for Tree {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn names(items: &[&Item]) -> Vec<String> {
        items.iter().map(|i| i.name.clone()).collect()
    }

    #[test]
    fn walks_shallow_first_skipping_hidden_and_generated_folders() {
        let tree = Tree::new("walk", &["a/b/deep.txt", "top.txt", ".secret/key.txt", "node_modules/x/index.js", "Notes.app/Contents/x"]);
        let items = walk(std::slice::from_ref(&tree.0), MAX_ITEMS);
        let found: Vec<(&str, usize)> = items.iter().map(|i| (i.name.as_str(), i.depth)).collect();
        assert!(found.contains(&("top.txt", 1)) && found.contains(&("deep.txt", 3)));
        assert!(found.contains(&("notes.app", 1)), "a package is listed");
        for gone in ["key.txt", ".secret", "node_modules", "index.js", "contents"] {
            assert!(!found.iter().any(|(n, _)| *n == gone), "{gone} should be skipped");
        }
        let depths: Vec<usize> = items.iter().map(|i| i.depth).collect();
        assert!(depths.is_sorted(), "breadth-first: {depths:?}");
        assert_eq!(walk(std::slice::from_ref(&tree.0), 2).len(), 2, "stops at the limit");
    }

    fn item(name: &str, depth: usize) -> Item {
        Item { path: PathBuf::from(name), dir: false, name: name.to_lowercase(), depth }
    }

    #[test]
    fn ranks_whole_names_then_starts_then_shallow() {
        let items = [
            item("old-report.pdf", 1),
            item("report.pdf", 3),
            item("reports 2026.xlsx", 1),
            item("misreported.txt", 1),
            item("photo.jpg", 1),
        ];
        assert_eq!(names(&rank(&items, "report", 10)), ["report.pdf", "reports 2026.xlsx", "old-report.pdf", "misreported.txt"]);
        assert_eq!(names(&rank(&items, "REPORT 2026", 10)), ["reports 2026.xlsx"]);
        assert!(rank(&items, "  ", 10).is_empty());
        assert_eq!(rank(&items, "report", 2).len(), 2);
    }

    #[test]
    fn expands_home_and_refuses_relative_paths() {
        let home = std::env::temp_dir();
        assert_eq!(expand("~", Some(&home)), Some(home.clone()));
        assert_eq!(expand("~/Documents", Some(&home)), Some(home.join("Documents")));
        assert_eq!(expand("~someone", Some(&home)), None);
        assert_eq!(expand("Documents", Some(&home)), None);
        assert_eq!(expand("~", None), None);
    }

    #[test]
    fn browses_the_folder_a_typed_path_points_at() {
        let tree = Tree::new("browse", &["Documents/", "Downloads/", "draft.txt", ".hidden", "Music/"]);
        let typed = |s: &str| format!("{}{}{s}", tree.0.display(), std::path::MAIN_SEPARATOR);
        let found = |input: String| {
            browse(&input, None, 10)
                .into_iter()
                .map(|(p, dir)| (p.file_name().unwrap().to_string_lossy().into_owned(), dir))
                .collect::<Vec<_>>()
        };
        assert_eq!(found(typed("d")), [("Documents".into(), true), ("Downloads".into(), true), ("draft.txt".into(), false)]);
        assert_eq!(found(typed("")).len(), 4, "all but the hidden one");
        assert_eq!(found(typed(".h")), [(".hidden".into(), false)]);
        assert!(found("relative/path".into()).is_empty());
    }

    #[test]
    fn shows_folders_relative_to_home() {
        let home = std::env::temp_dir().join("me");
        let file = home.join("Documents").join("cv.pdf");
        let hit = hit(&file, false, Some(&home));
        assert_eq!((hit.name.as_str(), hit.folder), ("cv.pdf", format!("~{}Documents", std::path::MAIN_SEPARATOR)));
        assert_eq!(super::hit(&home.join("x.txt"), false, Some(&home)).folder, "~");
    }

    #[test]
    fn searches_after_walking_in_the_background() {
        let tree = Tree::new("index", &["Projects/plan.md", "plan-b.txt"]);
        let index = Index::new();
        index.set_roots(vec![tree.0.clone()]);
        let mut found = Vec::new();
        for _ in 0..200 {
            found = index.search("plan", 10);
            if found.len() == 2 {
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(found.len(), 2, "both plans, once walked");
        index.set_roots(Vec::new());
        assert!(index.search("plan", 10).is_empty(), "no folders, nothing indexed");
    }
}
