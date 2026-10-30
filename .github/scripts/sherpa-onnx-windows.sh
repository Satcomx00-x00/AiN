#!/usr/bin/env bash
# sherpa-onnx's Windows x64 libraries, into the folder its build script reads (SHERPA_ONNX_ARCHIVE_DIR,
# set in ain/src-tauri/.cargo/config.toml). At 123 MB the archive is over GitHub's file limit, so
# unlike Linux's it isn't committed: fetched here and checked against the pinned SHA256SUMS.
set -euo pipefail

dir=ain/src-tauri/vendor/sherpa-onnx
name=$(awk '$2 ~ /-win-x64-/ { print $2 }' "$dir/SHA256SUMS")
version=$(sed -n 's/^sherpa-onnx-v\([0-9.]*\)-.*/\1/p' <<< "$name")
curl -fsSL --retry 3 -o "$dir/$name" "https://github.com/k2-fsa/sherpa-onnx/releases/download/v$version/$name"
cd "$dir"
sha256sum --check --ignore-missing --strict SHA256SUMS
