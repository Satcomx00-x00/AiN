//! Windows: apps are what the Start menu's "All apps" lists (the shell's Applications folder,
//! desktop and Store apps alike), started through the shell; commands run in a PowerShell window;
//! system actions go through the shell, `shutdown.exe` and the power API.

use std::{ffi::OsString, io, os::windows::process::CommandExt, path::Path, process::Command};

use base64::{Engine, engine::general_purpose::STANDARD};
use windows::{
    Win32::{
        Foundation::E_UNEXPECTED,
        System::{Com::CoTaskMemFree, Power::SetSuspendState},
        UI::Shell::{
            BHID_EnumItems, FOLDERID_AppsFolder, IEnumShellItems, IShellItem, KF_FLAG_DEFAULT, SHERB_NOCONFIRMATION, SHEmptyRecycleBinW,
            SHGetKnownFolderItem, SIGDN, SIGDN_NORMALDISPLAY, SIGDN_PARENTRELATIVEPARSING,
        },
    },
    core::PCWSTR,
};

use super::{App, SystemAction};
use crate::platform::{
    on_path,
    windows::{exe_stem, init_com, shell_open},
};

/// The app's parsing name in the Applications folder: a program's path, or a Store app's id.
pub struct Launch(String);

const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
/// What the Start menu lists beside apps: documentation, links, uninstallers.
const NOT_APPS: &[&str] = &["chm", "htm", "html", "pdf", "rtf", "txt", "url"];

fn display_name(item: &IShellItem, kind: SIGDN) -> Option<String> {
    // SAFETY: the shell allocates the string; it is copied, then freed with CoTaskMemFree.
    unsafe {
        let name = item.GetDisplayName(kind).ok()?;
        let text = name.to_string().ok();
        CoTaskMemFree(Some(name.0 as *const _));
        text
    }
}

/// Whether an entry of the Applications folder is a document, a link or an uninstaller.
fn not_an_app(name: &str, parsing: &str) -> bool {
    let ext = Path::new(parsing).extension().map(|e| e.to_string_lossy().to_ascii_lowercase());
    name.to_lowercase().starts_with("uninstall") || ext.is_some_and(|e| NOT_APPS.contains(&e.as_str())) || parsing.starts_with("http")
}

/// A program's file name, or a Store app's package name ("Microsoft.WindowsCalculator").
fn program(parsing: &str) -> &str {
    match parsing.split_once('!') {
        Some((package, _)) => package.split('_').next().unwrap_or(package),
        None => exe_stem(parsing),
    }
}

pub fn apps() -> Vec<(App, Launch)> {
    init_com();
    let mut out = Vec::new();
    // SAFETY: COM is initialized on this thread; each interface is released when dropped.
    let items: windows::core::Result<IEnumShellItems> = unsafe {
        SHGetKnownFolderItem::<IShellItem>(&FOLDERID_AppsFolder, KF_FLAG_DEFAULT, None)
            .and_then(|folder| folder.BindToHandler(None, &BHID_EnumItems))
    };
    let Ok(items) = items else { return out };
    loop {
        let mut item = [None];
        let mut fetched = 0;
        // SAFETY: room for one item; `fetched` says whether it was filled.
        if unsafe { items.Next(&mut item, Some(&mut fetched)) }.is_err() || fetched == 0 {
            break;
        }
        let Some(item) = item[0].take() else { break };
        let (Some(name), Some(parsing)) = (display_name(&item, SIGDN_NORMALDISPLAY), display_name(&item, SIGDN_PARENTRELATIVEPARSING))
        else {
            continue;
        };
        if not_an_app(&name, &parsing) {
            continue;
        }
        let keywords = program(&parsing).to_string();
        let detail = if parsing.contains('!') { "App".to_string() } else { format!("{keywords}.exe") };
        out.push((App { id: parsing.clone(), name, keywords, detail }, Launch(parsing)));
    }
    out
}

pub fn launch(launch: &Launch) -> io::Result<()> {
    shell_open(format!(r"shell:AppsFolder\{}", launch.0).as_ref())
}

/// PowerShell's `-EncodedCommand`: UTF-16LE in base64, so no quote is lost on the command line.
fn encoded(command: &str) -> String {
    STANDARD.encode(command.encode_utf16().flat_map(u16::to_le_bytes).collect::<Vec<u8>>())
}

/// Runs `command` in a new PowerShell window (7 when installed), which stays open after it.
pub fn terminal(command: &str) -> io::Result<()> {
    let shell = if on_path("pwsh") { "pwsh.exe" } else { "powershell.exe" };
    let mut run = Command::new(shell);
    run.args(["-NoLogo", "-NoExit", "-EncodedCommand", &encoded(command)]).creation_flags(CREATE_NEW_CONSOLE);
    if let Some(home) = dirs::home_dir() {
        run.current_dir(home);
    }
    run.spawn().map(drop)
}

pub fn reveal(path: &Path) -> io::Result<()> {
    let mut select = OsString::from("/select,\"");
    select.push(path);
    select.push("\"");
    Command::new("explorer.exe").raw_arg(select).spawn().map(drop)
}

fn quietly(program: &str, args: &[&str]) -> io::Result<()> {
    Command::new(program).args(args).creation_flags(CREATE_NO_WINDOW).spawn().map(drop)
}

pub fn system(action: SystemAction) -> io::Result<()> {
    match action {
        SystemAction::Lock => quietly("rundll32.exe", &["user32.dll,LockWorkStation"]),
        // SAFETY: a plain call: sleep (not hibernate), not forced, wake-up events kept.
        SystemAction::Sleep => match unsafe { SetSuspendState(false, false, false) } {
            true => Ok(()),
            false => Err(io::Error::last_os_error()),
        },
        SystemAction::SignOut => quietly("shutdown.exe", &["/l"]),
        SystemAction::Restart => quietly("shutdown.exe", &["/r", "/t", "0"]),
        SystemAction::ShutDown => quietly("shutdown.exe", &["/s", "/t", "0"]),
        // SAFETY: no window and every drive's bin; the palette already asked.
        SystemAction::EmptyTrash => match unsafe { SHEmptyRecycleBinW(None, PCWSTR::null(), SHERB_NOCONFIRMATION) } {
            // Said when the bin is already empty.
            Err(e) if e.code() == E_UNEXPECTED => Ok(()),
            done => done.map_err(io::Error::other),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_apps_and_drops_documents_links_and_uninstallers() {
        assert!(!not_an_app("Visual Studio Code", r"C:\Users\me\AppData\Local\Programs\Microsoft VS Code\Code.exe"));
        assert!(!not_an_app("Calculator", "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App"));
        assert!(not_an_app("Uninstall Foo", r"C:\Program Files\Foo\uninstall.exe"));
        assert!(not_an_app("Foo manual", r"C:\Program Files\Foo\manual.PDF"));
        assert!(not_an_app("Foo website", "https://foo.example"));
    }

    #[test]
    fn names_the_program_behind_an_app() {
        assert_eq!(program(r"{6D809377-6AF0-444B-8957-A3773F02200E}\Microsoft VS Code\Code.exe"), "Code");
        assert_eq!(program("Microsoft.WindowsCalculator_8wekyb3d8bbwe!App"), "Microsoft.WindowsCalculator");
    }

    #[test]
    fn encodes_commands_for_powershell() {
        // "ls" in UTF-16LE is 6C 00 73 00.
        assert_eq!(encoded("ls"), "bABzAA==");
    }
}
