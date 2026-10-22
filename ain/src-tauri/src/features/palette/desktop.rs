//! Desktop entries (`.desktop` files), as the freedesktop.org Desktop Entry Specification has
//! them: the name to show in the user's language, the command line to start, and where the entry
//! may be shown.

use std::{collections::HashMap, path::Path};

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Entry {
    pub name: String,
    pub generic: Option<String>,
    pub comment: Option<String>,
    pub keywords: Vec<String>,
    /// The `Exec` line, unescaped; `argv` splits it.
    pub exec: String,
    /// A program that must be installed for the entry to be shown.
    pub try_exec: Option<String>,
    /// The folder to start it in.
    pub path: Option<String>,
    pub terminal: bool,
    hidden: bool,
    only_show_in: Vec<String>,
    not_show_in: Vec<String>,
}

impl Entry {
    /// Whether a menu in `desktops` (`XDG_CURRENT_DESKTOP`'s names) lists it.
    pub fn shown(&self, desktops: &[String]) -> bool {
        let here = |list: &[String]| list.iter().any(|d| desktops.contains(d));
        !self.hidden && (self.only_show_in.is_empty() || here(&self.only_show_in)) && !here(&self.not_show_in)
    }
}

/// The locales to look up localized keys with, most specific first: `fr_FR.UTF-8@euro` gives
/// `fr_FR@euro`, `fr_FR`, `fr@euro`, `fr`.
pub fn locales(lang: &str) -> Vec<String> {
    let (rest, modifier) = lang.split_once('@').map_or((lang, None), |(r, m)| (r, Some(m)));
    let rest = rest.split_once('.').map_or(rest, |(r, _)| r);
    let (language, country) = rest.split_once('_').map_or((rest, None), |(l, c)| (l, Some(c)));
    if language.is_empty() || language == "C" || language == "POSIX" {
        return Vec::new();
    }
    let with = |base: String| [modifier.map(|m| format!("{base}@{m}")), Some(base)];
    country.map(|c| with(format!("{language}_{c}"))).into_iter().flatten().chain(with(language.to_string())).flatten().collect()
}

/// A string value with the specification's escapes (`\s`, `\n`, `\t`, `\r`, `\\`) undone.
fn unescape(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut chars = value.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('s') => out.push(' '),
            Some('n') => out.push('\n'),
            Some('t') => out.push('\t'),
            Some('r') => out.push('\r'),
            Some('\\') => out.push('\\'),
            // Not a string escape: kept for the Exec line's quoting rules (`\"`, `\$`…).
            Some(other) => out.extend(['\\', other]),
            None => out.push('\\'),
        }
    }
    out
}

/// A `;`-separated list, where `\;` is a semicolon inside an item.
fn list(value: &str) -> Vec<String> {
    let (mut items, mut item) = (Vec::new(), String::new());
    let mut chars = value.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\\' if chars.next_if_eq(&';').is_some() => item.push(';'),
            ';' => items.push(std::mem::take(&mut item)),
            c => item.push(c),
        }
    }
    items.push(item);
    items.into_iter().map(|i| unescape(i.trim())).filter(|i| !i.is_empty()).collect()
}

/// The `[Desktop Entry]` group of a `.desktop` file, if it is an application with a name and a
/// command. Localized keys are read in the first of `locales` they exist in.
pub fn parse(text: &str, locales: &[String]) -> Option<Entry> {
    let mut group = false;
    let mut keys: HashMap<&str, &str> = HashMap::new();
    for line in text.lines().map(str::trim) {
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if line.starts_with('[') {
            group = line == "[Desktop Entry]";
            continue;
        }
        if let (true, Some((key, value))) = (group, line.split_once('=')) {
            keys.entry(key.trim()).or_insert(value.trim());
        }
    }
    if keys.get("Type") != Some(&"Application") {
        return None;
    }
    let raw = |key: &str| keys.get(key).copied();
    let localized = |key: &str| locales.iter().find_map(|l| raw(&format!("{key}[{l}]"))).or_else(|| raw(key));
    let text = |value: Option<&str>| value.map(unescape).filter(|v| !v.is_empty());
    let flag = |key: &str| raw(key) == Some("true");
    Some(Entry {
        name: text(localized("Name"))?,
        generic: text(localized("GenericName")),
        comment: text(localized("Comment")),
        keywords: localized("Keywords").map(list).unwrap_or_default(),
        exec: text(raw("Exec"))?,
        try_exec: text(raw("TryExec")),
        path: text(raw("Path")),
        terminal: flag("Terminal"),
        hidden: flag("NoDisplay") || flag("Hidden"),
        only_show_in: raw("OnlyShowIn").map(list).unwrap_or_default(),
        not_show_in: raw("NotShowIn").map(list).unwrap_or_default(),
    })
}

/// The program and arguments of an (unescaped) `Exec` line, started without files: field codes
/// for files and URLs are dropped, `%c` is the name, `%k` the entry's file, `%%` a percent sign.
/// `None` when the line is empty or a quote isn't closed.
pub fn argv(exec: &str, name: &str, file: &Path) -> Option<Vec<String>> {
    let mut words = Vec::new();
    let mut chars = exec.chars().peekable();
    loop {
        while chars.next_if(|c| c.is_whitespace()).is_some() {}
        let Some(&first) = chars.peek() else { break };
        let mut word = String::new();
        if first == '"' {
            chars.next();
            loop {
                match chars.next()? {
                    '"' => break,
                    '\\' => match chars.next()? {
                        c @ ('"' | '`' | '$' | '\\') => word.push(c),
                        c => word.extend(['\\', c]),
                    },
                    c => word.push(c),
                }
            }
        } else {
            while let Some(c) = chars.next_if(|c| !c.is_whitespace()) {
                word.push(c);
            }
        }
        words.push(word);
    }
    let expand = |word: &str| {
        let mut out = String::with_capacity(word.len());
        let mut chars = word.chars();
        while let Some(c) = chars.next() {
            if c != '%' {
                out.push(c);
                continue;
            }
            match chars.next() {
                Some('%') => out.push('%'),
                Some('c') => out.push_str(name),
                Some('k') => out.push_str(&file.to_string_lossy()),
                _ => {}
            }
        }
        out
    };
    let lone_code = |w: &str| w.len() == 2 && w.starts_with('%') && w != "%%" && w != "%c" && w != "%k";
    let argv: Vec<String> = words.iter().filter(|w| !lone_code(w)).map(|w| expand(w)).collect();
    (!argv.is_empty()).then_some(argv)
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIREFOX: &str = r"[Desktop Entry]
Version=1.0
Name=Firefox Web Browser
Name[fr]=Navigateur Web Firefox
GenericName=Web Browser
Comment=Browse the World Wide Web
Comment[fr]=Naviguer sur le Web
Keywords=Internet;WWW;Browser;Web\;Explorer;
Exec=firefox %u
Terminal=false
Type=Application
Categories=GNOME;GTK;Network;WebBrowser;

[Desktop Action new-window]
Name=Open a New Window
Exec=firefox --new-window %u
";

    fn langs(lang: &str) -> Vec<String> {
        locales(lang)
    }

    #[test]
    fn reads_the_entry_in_the_users_language() {
        let entry = parse(FIREFOX, &langs("fr_FR.UTF-8")).unwrap();
        assert_eq!(entry.name, "Navigateur Web Firefox");
        assert_eq!(entry.comment.as_deref(), Some("Naviguer sur le Web"));
        assert_eq!(entry.generic.as_deref(), Some("Web Browser"), "no French generic name: the default");
        assert_eq!(entry.keywords, ["Internet", "WWW", "Browser", "Web;Explorer"]);
        assert_eq!(entry.exec, "firefox %u", "the first group's Exec, not an action's");
        assert!(!entry.terminal);
        assert_eq!(parse(FIREFOX, &[]).unwrap().name, "Firefox Web Browser");
    }

    #[test]
    fn orders_locales_most_specific_first() {
        assert_eq!(langs("fr_FR.UTF-8@euro"), ["fr_FR@euro", "fr_FR", "fr@euro", "fr"]);
        assert_eq!(langs("de_DE.UTF-8"), ["de_DE", "de"]);
        assert_eq!(langs("pt"), ["pt"]);
        assert!(langs("C.UTF-8").is_empty() && langs("").is_empty());
    }

    #[test]
    fn skips_what_is_not_an_application_or_has_no_command() {
        assert!(parse("[Desktop Entry]\nType=Link\nName=Site\nURL=https://example.com", &[]).is_none());
        assert!(parse("[Desktop Entry]\nType=Application\nName=Nothing", &[]).is_none());
        assert!(parse("[Other]\nType=Application\nName=X\nExec=x", &[]).is_none());
    }

    #[test]
    fn honours_where_an_entry_may_be_shown() {
        let entry = |extra: &str| parse(&format!("[Desktop Entry]\nType=Application\nName=X\nExec=x\n{extra}"), &[]).unwrap();
        let gnome = ["GNOME".to_string()];
        assert!(entry("").shown(&gnome));
        assert!(!entry("NoDisplay=true").shown(&gnome));
        assert!(!entry("Hidden=true").shown(&gnome));
        assert!(entry("OnlyShowIn=GNOME;Unity;").shown(&gnome));
        assert!(!entry("OnlyShowIn=KDE;").shown(&gnome));
        assert!(!entry("NotShowIn=GNOME;").shown(&gnome));
    }

    #[test]
    fn splits_exec_lines_and_drops_file_codes() {
        let file = Path::new("/usr/share/applications/x.desktop");
        let argv = |exec: &str| argv(&unescape(exec), "My App", file);
        assert_eq!(argv("firefox %u").unwrap(), ["firefox"]);
        assert_eq!(argv(r#""/opt/My App/run" --name=%c %F"#).unwrap(), ["/opt/My App/run", "--name=My App"]);
        assert_eq!(argv(r#"sh -c "echo \"hi\" \$HOME""#).unwrap(), ["sh", "-c", r#"echo "hi" $HOME"#]);
        assert_eq!(argv(r"app --file=%k --percent=100%%").unwrap(), ["app", "--file=/usr/share/applications/x.desktop", "--percent=100%"]);
        assert_eq!(argv(r#"say "a\\\\b""#).unwrap(), ["say", r"a\b"], "general escape, then quoting escape");
        assert_eq!(argv(r"run\sit"), Some(vec!["run".into(), "it".into()]), r"\s is a space");
        assert_eq!(argv(r#"broken "quote"#), None);
        assert_eq!(argv("%U"), None);
    }
}
