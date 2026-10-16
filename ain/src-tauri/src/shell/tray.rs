//! A tray icon: the way to reach settings and to quit, since the island has no window chrome.

use tauri::{
    Wry,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    plugin::{Builder, TauriPlugin},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};

use super::{settings, updater};

const SETTINGS: &str = "settings";
const UPDATES: &str = "updates";
const QUIT: &str = "quit";

/// No commands, so not in the manifest: a plain plugin that only sets the tray up.
pub fn init() -> TauriPlugin<Wry> {
    Builder::new("tray")
        .setup(|app, _| {
            let menu = Menu::with_items(
                app,
                &[
                    &MenuItem::with_id(app, SETTINGS, "Settings…", true, None::<&str>)?,
                    &MenuItem::with_id(app, UPDATES, "Check for Updates…", true, None::<&str>)?,
                    &PredefinedMenuItem::separator(app)?,
                    &MenuItem::with_id(app, QUIT, "Quit AiN", true, None::<&str>)?,
                ],
            )?;
            let mut tray = TrayIconBuilder::with_id("island")
                .tooltip("AiN")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    SETTINGS => _ = settings::show(app, None),
                    // Settings' About section shows the result as it comes.
                    UPDATES => {
                        _ = settings::show(app, Some("about"));
                        let app = app.clone();
                        tauri::async_runtime::spawn(async move { updater::check_now(&app).await });
                    }
                    QUIT => settings::quit_app(app),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                        _ = settings::show(tray.app_handle(), None);
                    }
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;
            Ok(())
        })
        .build()
}
