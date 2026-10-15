use tauri_build::{Attributes, DefaultPermissionRule, InlinedPlugin};

/// Each in-app plugin gets an `allow-<command>` permission per command and a `default` set allowing all of them.
fn plugin(commands: &'static [&'static str]) -> InlinedPlugin {
    InlinedPlugin::new().commands(commands).default_permission(DefaultPermissionRule::AllowAllCommands)
}

fn main() {
    tauri_build::try_build(
        Attributes::new()
            .plugin("island", plugin(&["info", "layout"]))
            .plugin("stats", plugin(&["latest"]))
            .plugin("clipboard", plugin(&["history", "copy", "copy_image", "clear"]))
            .plugin("media", plugin(&["state", "artwork", "control"]))
            .plugin("volume", plugin(&["state", "peak", "sources", "set_level", "set_muted"]))
            .plugin("privacy", plugin(&["state"]))
            .plugin("settings", plugin(&["get", "set", "open", "autostart", "set_autostart"]))
            .plugin("popup", plugin(&["bind", "failures", "open", "hide", "paste"]))
            .plugin("screen", plugin(&["latest", "save_png"]))
            .plugin("dictation", plugin(&["state", "model_status", "control", "download_model", "delete_model", "open_model_dir"])),
    )
    .expect("failed to run tauri-build");
}
