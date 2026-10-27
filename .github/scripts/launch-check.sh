#!/usr/bin/env bash
# Starts the built app on a virtual X display and checks that it comes up for real:
#   - the process starts and stays alive, and nothing panics;
#   - the island's window takes the size the frontend asks for once it is running (472 px wide and at
#     least 204 tall: the open island, its ears and room for the spring; taller when a tab's content
#     needs a taller panel in the runner's fonts), which proves the web view loaded the page,
#     the frontend started, and its calls reached the backend.
# Leaves the app's output, the window tree and a screenshot in OUT, for the workflow to upload.
#
# Usage: launch-check.sh <app binary or AppImage> [OUT]
# Needs: Xvfb, x11-utils (xdpyinfo, xwininfo), dbus-x11 (dbus-launch), imagemagick (import).
set -euo pipefail

APP=$1
OUT=${2:-launch-check}
# Window width and least height once the island has laid itself out, at the default settings.
WIDTH=${WIDTH:-472}
MIN_HEIGHT=${MIN_HEIGHT:-204}
EXPECTED="${WIDTH}x${MIN_HEIGHT}+"
# Seconds to wait for it, then to keep it running.
WAIT=${WAIT:-60}
STAY=${STAY:-10}
mkdir -p "$OUT"

export DISPLAY=:99
Xvfb "$DISPLAY" -screen 0 1920x1080x24 -nolisten tcp >"$OUT/xvfb.log" 2>&1 &
XVFB=$!
PID=""
cleanup() {
  [ -n "$PID" ] && kill "$PID" 2>/dev/null || true
  kill "$XVFB" 2>/dev/null || true
}
trap cleanup EXIT
for _ in $(seq 1 100); do
  xdpyinfo >/dev/null 2>&1 && break
  sleep 0.1
done

# A session bus, as on a desktop: the tray, the media and settings watchers use it.
eval "$(dbus-launch --sh-syntax)"
# X11, as on the virtual display: no Wayland compositor here.
unset WAYLAND_DISPLAY
export GDK_BACKEND=x11
# An AppImage mounts itself with FUSE, which runners lack: it unpacks itself instead.
export APPIMAGE_EXTRACT_AND_RUN=1

"$APP" >"$OUT/app.log" 2>&1 &
PID=$!

fail() {
  echo "::error::$1"
  echo "--- app output ---"
  cat "$OUT/app.log"
  xwininfo -root -tree >"$OUT/windows.txt" 2>&1 || true
  import -window root "$OUT/screen.png" 2>/dev/null || true
  exit 1
}

alive() { kill -0 "$PID" 2>/dev/null; }

laid_out=""
for _ in $(seq 1 "$WAIT"); do
  alive || fail "the app exited before its window was laid out"
  size=$(xwininfo -root -tree 2>/dev/null | grep -oE " ${WIDTH}x[0-9]+\+" | tr -dc '0-9x\n' | awk -F x -v h="$MIN_HEIGHT" '$2 >= h { print; exit }' || true)
  if [ -n "$size" ]; then
    laid_out=1
    break
  fi
  sleep 1
done
[ -n "$laid_out" ] || fail "no ${EXPECTED} window after ${WAIT}s: the frontend didn't start, or couldn't reach the backend"
echo "The island's window is laid out (${size})."

# Let it run: a few beats of every widget, against the system as it is.
sleep "$STAY"
alive || fail "the app exited within ${STAY}s of starting"
if grep -qiE "panicked at|segmentation fault|core dumped" "$OUT/app.log"; then
  fail "the app crashed or panicked"
fi

xwininfo -root -tree >"$OUT/windows.txt" 2>&1 || true
import -window root "$OUT/screen.png" 2>/dev/null || true
echo "The app is up after ${STAY}s more, without a crash."
echo "--- app output ---"
cat "$OUT/app.log"
