use tauri_build::{Attributes, DefaultPermissionRule, InlinedPlugin, WindowsAttributes};

#[path = "build/sherpa_onnx.rs"]
mod sherpa_onnx;

include!("src/manifest.rs");

/// Each plugin in the manifest gets an `allow-<command>` permission per command, and a `default`
/// set allowing all of them.
macro_rules! permissions {
    ($( $group:ident { $( $name:ident: $($path:ident)::+ {
        typed: [$($typed:ident),* $(,)?], raw: [$($raw:ident),* $(,)?], events: [$($event:ident),* $(,)?]
    } )* } )*) => {
        fn plugins(attributes: Attributes) -> Attributes {
            attributes $($(.plugin(
                stringify!($name),
                InlinedPlugin::new()
                    .commands(&[$(stringify!($typed),)* $(stringify!($raw),)*])
                    .default_permission(DefaultPermissionRule::AllowAllCommands),
            ))*)*
        }
    };
}

manifest!(permissions);

/// Windows: the app and its test binaries need Common Controls v6 (window code imports from it,
/// and a binary without it fails to start). tauri-build embeds that manifest as a resource, which
/// only reaches the app; asking the linker instead covers every binary, tests included.
fn common_controls(windows: WindowsAttributes) -> WindowsAttributes {
    if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() != Ok("msvc") {
        return windows;
    }
    println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
    println!(
        "cargo:rustc-link-arg=/MANIFESTDEPENDENCY:type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'"
    );
    WindowsAttributes::new_without_app_manifest()
}

/// The bundle's name (`productName`), which names its resource folder on Linux.
fn product() -> String {
    let config: serde_json::Value = serde_json::from_str(include_str!("tauri.conf.json")).expect("tauri.conf.json is JSON");
    config["productName"].as_str().expect("tauri.conf.json has a productName").to_owned()
}

fn main() {
    println!("cargo:rerun-if-changed=src/manifest.rs");
    sherpa_onnx::link(&product()).unwrap_or_else(|e| panic!("sherpa-onnx: {e}"));
    let attributes = plugins(Attributes::new()).windows_attributes(common_controls(WindowsAttributes::new()));
    tauri_build::try_build(attributes).expect("failed to run tauri-build");
}
