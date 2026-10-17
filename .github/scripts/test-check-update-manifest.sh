#!/usr/bin/env bash
# Tests check-update-manifest.py against the signed fixtures of the updater's Rust tests: it must
# accept a good manifest and reject a tampered file, a missing one and a missing platform.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
fixtures="$here/../../ain/src-tauri/tests/fixtures/updater"
# PYTHON: an interpreter with the `cryptography` package.
check() { "${PYTHON:-python3}" "$here/check-update-manifest.py" "$@" > /dev/null; }
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

cp "$fixtures/update.bin" "$work/"
signature="$(tr -d '\n' < "$fixtures/update.bin.sig")"
manifest() { # version, file name or full URL
  local url="$2"
  [[ "$url" == https://* ]] || url="https://example.com/dl/$url"
  printf '{"version":"%s","platforms":{"test-x86_64":{"url":"%s","signature":"%s"}}}' \
    "$1" "$url" "$signature" > "$work/latest.json"
}
expect_fail() { if check "$@"; then echo "FAIL: accepted, should have rejected: $*"; exit 1; fi; }

manifest 1.0.0 update.bin
check "$work/latest.json" "$work" "$fixtures/test.key.pub" 1.0.0 test-x86_64
echo "ok  accepts a good manifest"

expect_fail "$work/latest.json" "$work" "$fixtures/test.key.pub" 1.0.0 test-x86_64 other-x86_64
echo "ok  rejects a missing platform"

expect_fail "$work/latest.json" "$work" "$fixtures/test.key.pub" 2.0.0 test-x86_64
echo "ok  rejects another version"

manifest 1.0.0 missing.bin
expect_fail "$work/latest.json" "$work" "$fixtures/test.key.pub" 1.0.0 test-x86_64
echo "ok  rejects a file that isn't in the release"

# Uploaded to a draft, entries point at asset ids, named through ASSET_IDS.
manifest 1.0.0 https://api.github.com/repos/o/r/releases/assets/42
printf '{"42": "update.bin"}' > "$work/ids.json"
ASSET_IDS="$work/ids.json" check "$work/latest.json" "$work" "$fixtures/test.key.pub" 1.0.0 test-x86_64
echo "ok  accepts an entry by asset id"

printf '{"7": "update.bin"}' > "$work/ids.json"
ASSET_IDS="$work/ids.json" expect_fail "$work/latest.json" "$work" "$fixtures/test.key.pub" 1.0.0 test-x86_64
echo "ok  rejects an asset id that names no file of the release"

manifest 1.0.0 update.bin
printf 'x' >> "$work/update.bin"
expect_fail "$work/latest.json" "$work" "$fixtures/test.key.pub" 1.0.0 test-x86_64
echo "ok  rejects a tampered file"
