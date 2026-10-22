//! Global shortcuts on Wayland, which lets no app grab keys by itself: through the desktop portal
//! (`org.freedesktop.portal.GlobalShortcuts`), where the desktop asks the user to confirm the
//! shortcuts once and lets them change the keys in its settings.
//!
//! Recent portals refuse an app they can't name, so AiN first registers its application id, with
//! a hidden desktop entry of that name (packages and AppImages install theirs under the product
//! name). The portal's events carry an activation token, without which Wayland desktops don't
//! hand the focus to a window the app shows: the popup uses it.

use std::{
    collections::{BTreeMap, BTreeSet},
    env, fs, io,
    path::PathBuf,
    sync::{
        Arc, Mutex,
        mpsc::{self, Receiver, Sender, TryRecvError},
    },
    thread,
    time::{Duration, Instant},
};

use dbus::{
    Path,
    arg::{AppendAll, PropMap, RefArg, Variant},
    blocking::Connection,
    message::MatchRule,
};

const DESTINATION: &str = "org.freedesktop.portal.Desktop";
const OBJECT: &str = "/org/freedesktop/portal/desktop";
const SHORTCUTS: &str = "org.freedesktop.portal.GlobalShortcuts";
const REGISTRY: &str = "org.freedesktop.host.portal.Registry";
const TIMEOUT: Duration = Duration::from_secs(5);
/// How long the desktop's confirmation dialog may stay open.
const ANSWER: Duration = Duration::from_secs(300);
const TICK: Duration = Duration::from_millis(100);

/// Whether this is a Wayland session, where only the portal gives global shortcuts.
pub fn wanted() -> bool {
    env::var_os("WAYLAND_DISPLAY").is_some_and(|d| !d.is_empty())
}

/// A key code (`KeyboardEvent.code`) as the XDG shortcuts specification names keys: their XKB names.
fn key(code: &str) -> Option<String> {
    let named = match code {
        "Space" => "space",
        "Enter" => "Return",
        "Escape" => "Escape",
        "Tab" => "Tab",
        "Backspace" => "BackSpace",
        "Delete" => "Delete",
        "Insert" => "Insert",
        "Home" => "Home",
        "End" => "End",
        "PageUp" => "Page_Up",
        "PageDown" => "Page_Down",
        "ArrowLeft" => "Left",
        "ArrowRight" => "Right",
        "ArrowUp" => "Up",
        "ArrowDown" => "Down",
        "Backquote" => "grave",
        "Minus" => "minus",
        "Equal" => "equal",
        "BracketLeft" => "bracketleft",
        "BracketRight" => "bracketright",
        "Backslash" => "backslash",
        "Semicolon" => "semicolon",
        "Quote" => "apostrophe",
        "Comma" => "comma",
        "Period" => "period",
        "Slash" => "slash",
        _ => "",
    };
    if !named.is_empty() {
        return Some(named.into());
    }
    if let Some(letter) = code.strip_prefix("Key").filter(|l| l.len() == 1) {
        return Some(letter.to_ascii_lowercase());
    }
    if let Some(digit) = code.strip_prefix("Digit").filter(|d| d.len() == 1) {
        return Some(digit.into());
    }
    if let Some(digit) = code.strip_prefix("Numpad").filter(|d| d.len() == 1 && d.chars().all(|c| c.is_ascii_digit())) {
        return Some(format!("KP_{digit}"));
    }
    let function = code.strip_prefix('F').is_some_and(|n| n.parse::<u8>().is_ok_and(|n| (1..=24).contains(&n)));
    function.then(|| code.into())
}

/// A shortcut ("Ctrl+Alt+KeyD") as the portal's preferred trigger ("CTRL+ALT+d"); `None` when a
/// part has no name there.
pub fn trigger(shortcut: &str) -> Option<String> {
    let parts: Option<Vec<String>> = shortcut
        .split('+')
        .map(|part| match part {
            "Ctrl" => Some("CTRL".into()),
            "Alt" => Some("ALT".into()),
            "Shift" => Some("SHIFT".into()),
            "Super" => Some("LOGO".into()),
            code => key(code),
        })
        .collect();
    parts.filter(|p| !p.is_empty()).map(|p| p.join("+"))
}

/// A shortcut to bind: its id, what the desktop's dialog says it does, and the keys asked for.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct Shortcut {
    pub id: String,
    pub description: String,
    pub trigger: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    /// Its keys went down; with the token to focus a window by, when the portal sends one.
    Pressed {
        id: String,
        token: Option<String>,
    },
    Released {
        id: String,
    },
}

/// Shortcut id → why it isn't bound.
pub type Failures = BTreeMap<String, String>;

enum Job {
    Bind(Vec<Shortcut>, Sender<Failures>),
}

/// The portal client: a thread that owns the connection and hears the shortcuts.
pub struct Portal {
    jobs: Sender<Job>,
}

impl Portal {
    /// Starts the client for the app `app_id`; `on_event` is called on its thread.
    pub fn start(app_id: String, on_event: impl FnMut(Event) + Send + 'static) -> io::Result<Self> {
        let (jobs, rx) = mpsc::channel();
        thread::Builder::new().name("portal-shortcuts".into()).spawn(move || run(&app_id, rx, on_event))?;
        Ok(Self { jobs })
    }

    /// Binds `shortcuts`, replacing the ones bound before; returns those that aren't bound, and
    /// why. Blocks while the desktop asks the user to confirm them.
    pub fn bind(&self, shortcuts: Vec<Shortcut>) -> Failures {
        let everything = |why: &str| shortcuts.iter().map(|s| (s.id.clone(), why.to_string())).collect();
        let (tx, rx) = mpsc::channel();
        if self.jobs.send(Job::Bind(shortcuts.clone(), tx)).is_err() {
            return everything("The desktop's shortcut service stopped");
        }
        rx.recv().unwrap_or_else(|_| everything("The desktop's shortcut service stopped"))
    }
}

/// A hidden desktop entry under the application id, so the portal can tell who is asking.
fn desktop_entry(app_id: &str) -> io::Result<()> {
    let folder = dirs::data_dir().ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "no data folder"))?.join("applications");
    // An AppImage is started through its own file, not the program unpacked from it.
    let program = env::var_os("APPIMAGE").map(PathBuf::from).map_or_else(env::current_exe, Ok)?;
    let quoted = program.to_string_lossy().replace('\\', "\\\\").replace('"', "\\\"").replace('`', "\\`").replace('$', "\\$");
    let text = format!(
        "[Desktop Entry]\nType=Application\nName=AiN\nComment=A dynamic-island style widget bar for the desktop\nExec=\"{quoted}\"\nIcon=ain\nNoDisplay=true\n"
    );
    let path = folder.join(format!("{app_id}.desktop"));
    if fs::read_to_string(&path).is_ok_and(|current| current == text) {
        return Ok(());
    }
    fs::create_dir_all(&folder)?;
    fs::write(path, text)
}

/// The ids in a `BindShortcuts` answer's `shortcuts` (an array of (id, properties)).
fn ids(shortcuts: &dyn RefArg) -> BTreeSet<String> {
    let Some(items) = shortcuts.as_iter() else { return BTreeSet::new() };
    items
        .flat_map(|item| item.as_iter().into_iter().flatten().take(1).filter_map(|id| id.as_str().map(String::from)).collect::<Vec<_>>())
        .collect()
}

fn text(value: &str) -> Variant<Box<dyn RefArg>> {
    Variant(Box::new(value.to_string()))
}

struct Client {
    conn: Connection,
    /// The connection's unique name as request paths spell it: ":1.42" → "1_42".
    sender: String,
    tokens: u32,
    session: Arc<Mutex<Option<String>>>,
    /// The shortcuts bound last, and the answer then.
    bound: Option<(Vec<Shortcut>, Failures)>,
}

impl Client {
    fn token(&mut self) -> String {
        self.tokens += 1;
        format!("ain{}_{}", std::process::id(), self.tokens)
    }

    /// Calls a portal method that answers through a request object, and waits for the answer.
    fn request(&mut self, method: &str, args: impl AppendAll, token: &str) -> Result<PropMap, String> {
        let path = format!("{OBJECT}/request/{}/{token}", self.sender);
        let answer: Arc<Mutex<Option<(u32, PropMap)>>> = Arc::default();
        let slot = Arc::clone(&answer);
        let rule = MatchRule::new_signal("org.freedesktop.portal.Request", "Response").with_path(path);
        // Listened to before the call, so an answer can't come first.
        let matched = self
            .conn
            .add_match(rule, move |(code, results): (u32, PropMap), _, _| {
                *slot.lock().unwrap_or_else(|e| e.into_inner()) = Some((code, results));
                false
            })
            .map_err(|e| e.to_string())?;
        let proxy = self.conn.with_proxy(DESTINATION, OBJECT, TIMEOUT);
        if let Err(e) = proxy.method_call::<(Path,), _, _, _>(SHORTCUTS, method, args) {
            let _ = self.conn.remove_match(matched);
            return Err(match e.name() {
                Some(
                    "org.freedesktop.DBus.Error.UnknownMethod"
                    | "org.freedesktop.DBus.Error.UnknownInterface"
                    | "org.freedesktop.DBus.Error.ServiceUnknown",
                ) => "This desktop offers apps no global shortcuts".into(),
                _ => e.message().unwrap_or("The desktop refused it").to_string(),
            });
        }
        let deadline = Instant::now() + ANSWER;
        loop {
            if let Some((code, results)) = answer.lock().unwrap_or_else(|e| e.into_inner()).take() {
                return match code {
                    0 => Ok(results),
                    1 => Err("Not confirmed in the desktop's dialog".into()),
                    _ => Err("The desktop refused it".into()),
                };
            }
            if Instant::now() > deadline {
                let _ = self.conn.remove_match(matched);
                return Err("The desktop didn't answer".into());
            }
            let _ = self.conn.process(TICK);
        }
    }

    fn close_session(&mut self) {
        let Some(session) = self.session.lock().unwrap_or_else(|e| e.into_inner()).take() else { return };
        let proxy = self.conn.with_proxy(DESTINATION, session, TIMEOUT);
        let _: Result<(), _> = proxy.method_call("org.freedesktop.portal.Session", "Close", ());
    }

    /// A new session with `shortcuts` bound in it; the ones the desktop didn't bind, and why.
    fn bind(&mut self, shortcuts: &[Shortcut]) -> Failures {
        self.close_session();
        let everything = |why: String| shortcuts.iter().map(|s| (s.id.clone(), why.clone())).collect();
        let (handle, session) = (self.token(), self.token());
        let options = PropMap::from([("handle_token".into(), text(&handle)), ("session_handle_token".into(), text(&session))]);
        let session = match self.request("CreateSession", (options,), &handle) {
            Ok(results) => match results.get("session_handle").and_then(|v| v.0.as_str()) {
                Some(path) => path.to_string(),
                None => return everything("The desktop didn't open a session".into()),
            },
            Err(why) => return everything(why),
        };
        *self.session.lock().unwrap_or_else(|e| e.into_inner()) = Some(session.clone());
        let list: Vec<(String, PropMap)> = shortcuts
            .iter()
            .map(|s| {
                let mut properties = PropMap::from([("description".into(), text(&s.description))]);
                if let Some(trigger) = &s.trigger {
                    properties.insert("preferred_trigger".into(), text(trigger));
                }
                (s.id.clone(), properties)
            })
            .collect();
        let handle = self.token();
        let options = PropMap::from([("handle_token".into(), text(&handle))]);
        let Ok(session) = Path::new(session) else { return everything("The desktop opened an invalid session".into()) };
        match self.request("BindShortcuts", (session, list, String::new(), options), &handle) {
            Ok(results) => {
                let bound = results.get("shortcuts").map(|v| ids(&*v.0)).unwrap_or_default();
                shortcuts
                    .iter()
                    .filter(|s| !bound.contains(&s.id))
                    .map(|s| (s.id.clone(), "Turned off in the desktop's settings".to_string()))
                    .collect()
            }
            Err(why) => everything(why),
        }
    }
}

fn run(app_id: &str, jobs: Receiver<Job>, on_event: impl FnMut(Event) + Send + 'static) {
    let Ok(conn) = Connection::new_session() else {
        // No session bus: say so to every request.
        for Job::Bind(shortcuts, reply) in jobs {
            let _ = reply.send(shortcuts.into_iter().map(|s| (s.id, "No session bus".into())).collect());
        }
        return;
    };
    if let Err(e) = desktop_entry(app_id) {
        eprintln!("island: shortcuts: desktop entry: {e}");
    }
    // Before any other portal call; portals older than the registry don't need it.
    let registry = conn.with_proxy(DESTINATION, OBJECT, TIMEOUT);
    let _: Result<(), _> = registry.method_call(REGISTRY, "Register", (app_id, PropMap::new()));
    let sender = conn.unique_name().trim_start_matches(':').replace('.', "_");
    let session: Arc<Mutex<Option<String>>> = Arc::default();
    let on_event = Arc::new(Mutex::new(on_event));
    for (member, pressed) in [("Activated", true), ("Deactivated", false)] {
        let (session, on_event) = (Arc::clone(&session), Arc::clone(&on_event));
        let rule = MatchRule::new_signal(SHORTCUTS, member);
        let _ = conn.add_match(rule, move |(from, id, _time, options): (Path, String, u64, PropMap), _, _| {
            if session.lock().unwrap_or_else(|e| e.into_inner()).as_deref() == Some(&*from) {
                let token = options.get("activation_token").and_then(|v| v.0.as_str()).map(String::from);
                let event = if pressed { Event::Pressed { id, token } } else { Event::Released { id } };
                (on_event.lock().unwrap_or_else(|e| e.into_inner()))(event);
            }
            true
        });
    }
    let mut client = Client { conn, sender, tokens: 0, session, bound: None };
    loop {
        match jobs.try_recv() {
            Ok(Job::Bind(mut shortcuts, reply)) => {
                shortcuts.sort();
                // The same shortcuts again (settings saved for another reason): nothing to ask.
                let failures = match &client.bound {
                    Some((bound, failures)) if *bound == shortcuts => failures.clone(),
                    _ => client.bind(&shortcuts),
                };
                client.bound = Some((shortcuts, failures.clone()));
                let _ = reply.send(failures);
            }
            Err(TryRecvError::Empty) => {}
            Err(TryRecvError::Disconnected) => return,
        }
        let _ = client.conn.process(TICK);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_keys_as_the_portal_does() {
        assert_eq!(trigger("Ctrl+Alt+KeyD").as_deref(), Some("CTRL+ALT+d"));
        assert_eq!(trigger("Super+Alt+Space").as_deref(), Some("LOGO+ALT+space"));
        assert_eq!(trigger("Ctrl+Alt+Super+ArrowLeft").as_deref(), Some("CTRL+ALT+LOGO+Left"));
        assert_eq!(trigger("Super+Shift+Digit1").as_deref(), Some("LOGO+SHIFT+1"));
        assert_eq!(trigger("Alt+Backquote").as_deref(), Some("ALT+grave"));
        assert_eq!(trigger("F12").as_deref(), Some("F12"));
        assert_eq!(trigger("Ctrl+Numpad5").as_deref(), Some("CTRL+KP_5"));
        assert_eq!(trigger("Ctrl+IntlRo"), None, "no name for it: the desktop's dialog picks");
        assert_eq!(trigger("F99"), None);
    }

    /// Against a portal on the session bus that has `dev.test.Portal.Press` to press shortcuts
    /// (the scratch mock): `AIN_PORTAL_TEST=1 cargo test portal -- --ignored`.
    #[test]
    #[ignore]
    fn binds_and_hears_shortcuts_through_the_portal() {
        let (tx, events) = mpsc::channel();
        let portal = Portal::start("dev.satcom.ain".into(), move |e| drop(tx.send(e))).unwrap();
        let shortcut = |id: &str, keys: &str| Shortcut { id: id.into(), description: format!("{id} described"), trigger: trigger(keys) };
        let wanted = vec![shortcut("palette.open", "Super+Alt+Space"), shortcut("refused.one", "Ctrl+KeyR")];
        let failures = portal.bind(wanted.clone());
        assert_eq!(failures.keys().collect::<Vec<_>>(), ["refused.one"], "only the one the desktop turned off");
        assert_eq!(portal.bind(wanted), failures, "the same shortcuts again: nothing asked");
        let press = |id: &str, down: bool| {
            let conn = Connection::new_session().unwrap();
            let proxy = conn.with_proxy(DESTINATION, OBJECT, TIMEOUT);
            let _: () = proxy.method_call("dev.test.Portal", "Press", (id, down)).unwrap();
        };
        press("palette.open", true);
        let pressed = events.recv_timeout(Duration::from_secs(3)).unwrap();
        assert_eq!(pressed, Event::Pressed { id: "palette.open".into(), token: Some("token-1".into()) });
        press("palette.open", false);
        assert_eq!(events.recv_timeout(Duration::from_secs(3)).unwrap(), Event::Released { id: "palette.open".into() });
        assert!(portal.bind(vec![shortcut("dictation.toggle", "Ctrl+Alt+KeyD")]).is_empty(), "a new set, in a new session");
        let entry = dirs::data_dir().unwrap().join("applications/dev.satcom.ain.desktop");
        assert!(fs::read_to_string(entry).unwrap().contains("NoDisplay=true"));
    }

    #[test]
    fn reads_the_ids_the_desktop_bound() {
        let entry = |id: &str| (id.to_string(), PropMap::from([("trigger_description".to_string(), text("Ctrl+Alt+D"))]));
        let answer: Vec<(String, PropMap)> = vec![entry("dictation.toggle"), entry("palette.open")];
        assert_eq!(ids(&answer), BTreeSet::from(["dictation.toggle".to_string(), "palette.open".to_string()]));
        assert!(ids(&Vec::<(String, PropMap)>::new()).is_empty());
    }
}
