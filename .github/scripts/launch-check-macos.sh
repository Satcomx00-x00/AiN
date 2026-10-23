#!/usr/bin/env bash
# Starts the built app on macOS and checks that it comes up for real:
#   - the process starts and stays alive, and nothing panics;
#   - it puts a window on screen, which proves WKWebView loaded and the frontend ran.
# Leaves the app's output, its windows (with their bounds) and a screenshot in OUT.
#
# Usage: launch-check-macos.sh <path to AiN.app> [OUT]
set -euo pipefail

APP=$1
OUT=${2:-launch-check}
WAIT=${WAIT:-60}
STAY=${STAY:-10}
mkdir -p "$OUT"

BIN=$(find "$APP/Contents/MacOS" -maxdepth 1 -type f -perm -u+x | head -n 1)
[ -n "$BIN" ] || { echo "::error::no executable in $APP/Contents/MacOS"; exit 1; }

# The on-screen windows of a process, from the window server (bounds need no permission).
cat >"$OUT/windows.swift" <<'SWIFT'
import CoreGraphics
let pid = Int32(CommandLine.arguments[1])!
let all = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []
for w in all where (w[kCGWindowOwnerPID as String] as? Int32) == pid {
  let b = w[kCGWindowBounds as String] as? [String: Any] ?? [:]
  print("\(b["Width"] ?? 0)x\(b["Height"] ?? 0)+\(b["X"] ?? 0)+\(b["Y"] ?? 0)")
}
SWIFT
swiftc -O "$OUT/windows.swift" -o "$OUT/windows"

"$BIN" >"$OUT/app.log" 2>&1 &
PID=$!
trap 'kill "$PID" 2>/dev/null || true' EXIT

fail() {
  echo "::error::$1"
  echo "--- app output ---"
  cat "$OUT/app.log"
  screencapture -x "$OUT/screen.png" 2>/dev/null || true
  exit 1
}
alive() { kill -0 "$PID" 2>/dev/null; }

shown=""
for _ in $(seq 1 "$WAIT"); do
  alive || fail "the app exited before showing a window"
  if [ -n "$("$OUT/windows" "$PID")" ]; then
    shown=1
    break
  fi
  sleep 1
done
[ -n "$shown" ] || fail "no window on screen after ${WAIT}s: the web view or the frontend didn't start"
echo "The app shows its windows: $("$OUT/windows" "$PID" | paste -sd, -)"

sleep "$STAY"
alive || fail "the app exited within ${STAY}s of starting"
if grep -qiE "panicked at|segmentation fault" "$OUT/app.log"; then
  fail "the app crashed or panicked"
fi
"$OUT/windows" "$PID" >"$OUT/windows.txt"
screencapture -x "$OUT/screen.png" 2>/dev/null || true
echo "The app is up after ${STAY}s more, without a crash."
echo "--- app output ---"
cat "$OUT/app.log"
