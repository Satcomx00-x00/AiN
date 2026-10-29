//! Links sherpa-onnx's shared libraries from SHERPA_ONNX_LIB_DIR (PyPI's `sherpa-onnx-core`, set in
//! .cargo/config.toml), in place of sherpa-onnx-sys's build script, which downloads them from GitHub.
//! The bundle installs them as resources (tauri.<os>.conf.json), and tauri-build copies them beside
//! the binary in `target`.

use std::{env, path::PathBuf};

const LIB: &str = "sherpa-onnx-c-api";

/// The file the linker reads for `LIB` on `os`.
fn link_file(os: &str) -> Option<String> {
    match os {
        "linux" => Some(format!("lib{LIB}.so")),
        "windows" => Some(format!("{LIB}.lib")),
        _ => None,
    }
}

pub fn link(product: &str) -> Result<(), String> {
    println!("cargo:rerun-if-env-changed=SHERPA_ONNX_LIB_DIR");
    let os = env::var("CARGO_CFG_TARGET_OS").map_err(|e| e.to_string())?;
    let file = link_file(&os).ok_or_else(|| format!("sherpa-onnx: no libraries for {os}"))?;
    let dir = env::var_os("SHERPA_ONNX_LIB_DIR").map(PathBuf::from).ok_or("SHERPA_ONNX_LIB_DIR is unset (see .cargo/config.toml)")?;
    if !dir.join(&file).is_file() {
        return Err(format!("{file} isn't in {}: run `bun run native` in ain/", dir.display()));
    }
    println!("cargo:rerun-if-changed={}", dir.join(&file).display());
    println!("cargo:rustc-link-search=native={}", dir.display());
    println!("cargo:rustc-link-lib=dylib={LIB}");
    if os == "linux" {
        // Beside the binary (in `target`, or an npm package), or in the bundle's resources
        // (/usr/lib/<product>, also inside the AppImage). The libraries find each other by $ORIGIN.
        println!("cargo:rustc-link-arg=-Wl,-rpath,$ORIGIN:$ORIGIN/../lib/{product}");
    }
    Ok(())
}
