//! sherpa-onnx's prebuilt libraries come from `vendor/sherpa-onnx` (`SHERPA_ONNX_ARCHIVE_DIR`, set
//! in `.cargo/config.toml`), never from GitHub: the build has no network beyond the registries.
//! A sherpa-onnx bump without its archives, or an archive that isn't upstream's, fails here with
//! what to do, not deep in a build script.

use std::{fs, path::PathBuf};

use sha2::{Digest, Sha256};

/// The folder sherpa-onnx-sys's build script reads: Cargo's `[env]` sets it for rustc too.
fn archive_dir() -> PathBuf {
    PathBuf::from(env!("SHERPA_ONNX_ARCHIVE_DIR"))
}

/// `SHA256SUMS`'s entries: (hash, file name).
fn sums() -> Vec<(String, String)> {
    let text = fs::read_to_string(archive_dir().join("SHA256SUMS")).expect("SHA256SUMS");
    text.lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| {
            let (hash, name) = l.split_once("  ").unwrap_or_else(|| panic!("not `<sha256>  <file>`: {l}"));
            (hash.to_string(), name.to_string())
        })
        .collect()
}

/// sherpa-onnx-sys's version in Cargo.lock: the one whose archives its build script asks for.
fn locked_version() -> String {
    let lock = fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/Cargo.lock")).expect("Cargo.lock");
    let mut lines = lock.lines().skip_while(|l| *l != r#"name = "sherpa-onnx-sys""#);
    lines.next().expect("sherpa-onnx-sys in Cargo.lock");
    let version = lines.next().and_then(|l| l.strip_prefix("version = ")).expect("its version");
    version.trim_matches('"').to_string()
}

#[test]
fn the_archive_folder_is_the_vendored_one() {
    let expected = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("vendor").join("sherpa-onnx");
    assert_eq!(fs::canonicalize(archive_dir()).unwrap(), fs::canonicalize(expected).unwrap());
}

#[test]
fn pins_the_archives_of_the_locked_version() {
    let v = locked_version();
    let names: Vec<String> = sums().into_iter().map(|(_, n)| n).collect();
    // As sherpa-onnx-sys's build script names them, for the targets CI builds.
    for want in
        [format!("sherpa-onnx-v{v}-linux-x64-static-lib.tar.bz2"), format!("sherpa-onnx-v{v}-win-x64-static-MT-Release-lib.tar.bz2")]
    {
        assert!(
            names.contains(&want),
            "SHA256SUMS lacks {want}: after bumping sherpa-onnx, put the new version's archives from \
             https://github.com/k2-fsa/sherpa-onnx/releases/tag/v{v} in vendor/sherpa-onnx and their hashes in SHA256SUMS"
        );
    }
}

#[test]
fn every_archive_is_pinned_and_intact() {
    let pinned = sums();
    for entry in fs::read_dir(archive_dir()).unwrap() {
        let name = entry.unwrap().file_name().into_string().unwrap();
        if name == "SHA256SUMS" {
            continue;
        }
        let (want, _) = pinned.iter().find(|(_, n)| *n == name).unwrap_or_else(|| panic!("{name} isn't in SHA256SUMS"));
        let got: String = Sha256::digest(fs::read(archive_dir().join(&name)).unwrap()).iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(&got, want, "{name} isn't the archive SHA256SUMS pins");
    }
}

/// Linux's archive is committed (Windows' is over GitHub's file limit: CI fetches it).
#[test]
fn linux_archive_is_committed() {
    let name = format!("sherpa-onnx-v{}-linux-x64-static-lib.tar.bz2", locked_version());
    assert!(archive_dir().join(&name).is_file(), "vendor/sherpa-onnx lacks {name}");
}
