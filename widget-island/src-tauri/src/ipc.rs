//! Turns the manifest into Tauri plugins: one per entry, answering its commands, with its typed
//! events mounted, and able to export its TypeScript bindings.
//!
//! Commands stay private to their module, so each module expands its own manifest entry with
//! `crate::ipc::<name>!()`, which defines `ipc()` right there.

use tauri::{
    AppHandle, Wry,
    ipc::Invoke,
    plugin::{Builder, TauriPlugin},
};
use tauri_specta::{Commands, ErrorHandlingMode, Events};

/// One plugin's IPC: commands with bindings, raw commands, and events.
pub struct Ipc {
    pub name: &'static str,
    specta: tauri_specta::Builder<Wry>,
    raw: fn(Invoke<Wry>) -> bool,
    raw_names: &'static [&'static str],
}

type Failed = Box<dyn std::error::Error>;

impl Ipc {
    pub fn new(
        name: &'static str,
        commands: Commands<Wry>,
        events: Events,
        raw: fn(Invoke<Wry>) -> bool,
        raw_names: &'static [&'static str],
    ) -> Self {
        let specta = tauri_specta::Builder::<Wry>::new()
            .plugin_name(name)
            .commands(commands)
            .events(events)
            .error_handling(ErrorHandlingMode::Throw)
            // Timestamps and byte counts are u64 in Rust but stay far below 2^53.
            .dangerously_cast_bigints_to_number();
        Self { name, specta, raw, raw_names }
    }

    /// A plugin builder answering these commands; `setup` runs once the events are mounted, so
    /// it may emit them right away. Callers may add more (e.g. `on_window_ready`) before `build`.
    pub fn builder(self, setup: impl FnOnce(&AppHandle) -> Result<(), Failed> + Send + 'static) -> Builder<Wry> {
        let typed = self.specta.invoke_handler();
        let (raw, raw_names) = (self.raw, self.raw_names);
        Builder::new(self.name)
            .invoke_handler(move |invoke| match raw_names.contains(&invoke.message.command()) {
                true => raw(invoke),
                false => typed(invoke),
            })
            .setup(move |app, _| {
                self.specta.mount_events(app);
                setup(app)
            })
    }

    pub fn plugin(self, setup: impl FnOnce(&AppHandle) -> Result<(), Failed> + Send + 'static) -> TauriPlugin<Wry> {
        self.builder(setup).build()
    }
}

macro_rules! plugins {
    ($( $group:ident { $( $name:ident: $($path:ident)::+ {
        typed: [$($typed:ident),* $(,)?], raw: [$($raw:ident),* $(,)?], events: [$($event:ident),* $(,)?]
    } )* } )*) => {
        $($(
            /// Defines `ipc()` in the module this manifest entry names; called from inside it,
            /// where its private commands are in scope.
            macro_rules! $name {
                () => {
                    /// This module's IPC, as listed in `manifest.rs`.
                    pub(crate) fn ipc() -> crate::ipc::Ipc {
                        crate::ipc::Ipc::new(
                            stringify!($name),
                            tauri_specta::collect_commands![$($typed),*],
                            tauri_specta::collect_events![$($event),*],
                            tauri::generate_handler![$($raw),*],
                            &[$(stringify!($raw)),*],
                        )
                    }
                };
            }
            pub(crate) use $name;
        )*)*

        /// The manifest as data, for tests.
        #[cfg(test)]
        pub const ENTRIES: &[tests::Entry] = &[$($(tests::Entry {
            group: stringify!($group),
            name: stringify!($name),
            typed: &[$(stringify!($typed)),*],
            raw: &[$(stringify!($raw)),*],
            events: &[$(stringify!($event)),*],
        }),*),*];

        /// Every plugin, in manifest order.
        #[cfg(test)]
        pub fn all() -> Vec<Ipc> {
            vec![$($(crate::$($path)::+::ipc()),*),*]
        }
    };
}

manifest!(plugins);

#[cfg(test)]
pub mod tests {
    use std::{
        collections::BTreeSet,
        fs,
        path::{Path, PathBuf},
    };

    use specta_typescript::Typescript;

    use super::*;

    pub struct Entry {
        pub group: &'static str,
        pub name: &'static str,
        pub typed: &'static [&'static str],
        pub raw: &'static [&'static str],
        pub events: &'static [&'static str],
    }

    const HEADER: &str = "// Generated from src-tauri/src/manifest.rs by `cargo test`; do not edit.\n// @ts-nocheck";

    fn src() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../src")
    }

    /// Where the frontend keeps a plugin's bindings, under `src`; none when it has nothing typed.
    fn bindings_path(src: &Path, entry: &Entry) -> Option<PathBuf> {
        if entry.typed.is_empty() && entry.events.is_empty() {
            return None;
        }
        Some(match entry.group {
            "shell" => src.join("shell").join("bindings").join(format!("{}.ts", entry.name)),
            _ => src.join("features").join(entry.name).join("bindings.ts"),
        })
    }

    /// Same text, whatever line endings a Windows checkout gave the file.
    fn same_text(a: &str, b: &str) -> bool {
        a.replace("\r\n", "\n") == b.replace("\r\n", "\n")
    }

    /// Writes every `bindings.ts` that is missing or out of date, then fails if it had to: they
    /// were stale, and the fresh ones need committing. So `cargo test` keeps them current.
    #[test]
    fn exports_bindings() {
        let (src, scratch) = (src(), std::env::temp_dir().join(format!("island-bindings-{}", std::process::id())));
        let plugins = all();
        assert_eq!(plugins.len(), ENTRIES.len());
        let mut stale = Vec::new();
        for (entry, ipc) in ENTRIES.iter().zip(plugins) {
            assert_eq!(entry.name, ipc.name);
            let Some(path) = bindings_path(&src, entry) else { continue };
            let fresh = scratch.join(format!("{}.ts", entry.name));
            ipc.specta.export(Typescript::default().header(HEADER), &fresh).unwrap_or_else(|e| panic!("{} bindings: {e}", ipc.name));
            let fresh = fs::read_to_string(&fresh).unwrap();
            if !fs::read_to_string(&path).is_ok_and(|current| same_text(&current, &fresh)) {
                fs::create_dir_all(path.parent().unwrap()).unwrap();
                fs::write(&path, fresh).unwrap();
                stale.push(path.display().to_string());
            }
        }
        let _ = fs::remove_dir_all(&scratch);
        assert!(stale.is_empty(), "these bindings were out of date and have been regenerated; commit them:\n{}", stale.join("\n"));
    }

    #[test]
    fn compares_bindings_whatever_the_line_endings() {
        assert!(same_text("a\r\nb\n", "a\nb\n"));
        assert!(!same_text("a\nb", "a\nc"));
    }

    #[test]
    fn bindings_sit_beside_their_frontend_code() {
        let entry = |group, name, typed| Entry { group, name, typed, raw: &[], events: &[] };
        let src = Path::new("src");
        assert_eq!(bindings_path(src, &entry("features", "media", &["state"])), Some(PathBuf::from("src/features/media/bindings.ts")));
        assert_eq!(bindings_path(src, &entry("shell", "popup", &["bind"])), Some(PathBuf::from("src/shell/bindings/popup.ts")));
        assert_eq!(bindings_path(src, &entry("shell", "capture", &[])), None, "only raw commands: nothing to generate");
    }

    #[test]
    fn names_are_unique_and_commands_listed_once() {
        let names: BTreeSet<_> = ENTRIES.iter().map(|e| e.name).collect();
        assert_eq!(names.len(), ENTRIES.len(), "two manifest entries share a plugin name");
        for e in ENTRIES {
            let commands: BTreeSet<_> = e.typed.iter().chain(e.raw).collect();
            assert_eq!(commands.len(), e.typed.len() + e.raw.len(), "{}: a command is listed twice", e.name);
        }
    }

    /// `plugin:<name>|<command>` strings in `text`.
    pub fn invocations(text: &str) -> Vec<(String, String)> {
        let word = |s: &str| s.chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '_').collect::<String>();
        text.match_indices("plugin:")
            .filter_map(|(at, _)| {
                let rest = &text[at + "plugin:".len()..];
                let name = word(rest);
                let command = word(rest[name.len()..].strip_prefix('|')?);
                (!name.is_empty() && !command.is_empty()).then_some((name, command))
            })
            .collect()
    }

    fn sources(dir: &Path, out: &mut Vec<PathBuf>) {
        for entry in fs::read_dir(dir).into_iter().flatten().flatten() {
            let path = entry.path();
            if path.is_dir() {
                sources(&path, out);
            } else if path.extension().is_some_and(|x| x == "ts") {
                out.push(path);
            }
        }
    }

    #[test]
    fn finds_invocations() {
        assert_eq!(
            invocations(r#"invoke("plugin:capture|save_png", png); invoke(`plugin:clipboard|copy_image`); "plugin:"; "plugin:x|""#),
            [("capture".into(), "save_png".into()), ("clipboard".into(), "copy_image".into())]
        );
    }

    /// Commands the frontend calls by name (the raw ones, which have no bindings) must exist: a
    /// typo or a renamed command would otherwise only fail at runtime.
    #[test]
    fn every_command_the_frontend_names_exists() {
        let mut files = Vec::new();
        sources(&src(), &mut files);
        assert!(!files.is_empty(), "no frontend sources found");
        for file in files {
            let text = fs::read_to_string(&file).unwrap();
            for (name, command) in invocations(&text) {
                // Tauri's own plugins are called through their packages, never by name, so any
                // name here must be ours.
                let known = ENTRIES.iter().any(|e| e.name == name && e.typed.iter().chain(e.raw).any(|c| *c == command));
                assert!(known, "{} calls plugin:{name}|{command}, which the manifest doesn't list", file.display());
            }
        }
    }
}
