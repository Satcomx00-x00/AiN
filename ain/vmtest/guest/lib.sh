# shellcheck shell=bash disable=SC2016  # check/wait_for evaluate their single-quoted conditions later
# Helpers for the tests in tests/, sourced by run.sh in the auto-login GNOME (Wayland) session.
#
# A test prints one line per result, which the runner collects:
#   PASS <id> <what>
#   FAIL <id> <what> (<detail>)
#   LOOK <id> <what> [<shot>]     to be judged on a screenshot
# and gets a screenshot of the VM's screen with `shot <name>`.
#
# AiN's island is an X11 window (XWayland) on GNOME, so xdotool can read it; the pointer and keys go
# through ydotool (the kernel's uinput), as a real mouse and keyboard would.

XDG_RUNTIME_DIR=/run/user/$(id -u)
XAUTHORITY=$(find "$XDG_RUNTIME_DIR" -maxdepth 1 -name ".mutter-Xwaylandauth.*" 2>/dev/null | head -1)
export XDG_RUNTIME_DIR XAUTHORITY WAYLAND_DISPLAY=wayland-0 DISPLAY=:0 DBUS_SESSION_BUS_ADDRESS=unix:path=$XDG_RUNTIME_DIR/bus
BIN=~/vmtest/ain
UNIT=vmtest-ain
read -r SW SH < <(xdotool getdisplaygeometry)

# ---------- results ----------

# check ID WHAT CONDITION [DETAIL]: CONDITION is evaluated; DETAIL says why, on failure.
check() {
  if eval "$3"; then echo "PASS $1 $2"; else echo "FAIL $1 $2 (${4:-})"; fi
}
# look ID WHAT SHOT: a result only a screenshot shows (taken with `shot SHOT` just before).
look() { echo "LOOK $1 $2 [$3]"; }
# shot NAME: the runner saves the VM's screen as NAME.png, then lets the test go on.
shot() {
  echo "@@shot $1"
  read -r _ <&3 || true
}
# wait_for SECONDS CONDITION: polls CONDITION; fails if it isn't true in time.
wait_for() {
  local end=$((SECONDS + $1))
  until eval "$2"; do
    [ "$SECONDS" -ge "$end" ] && return 1
    sleep 0.2
  done
}

# ---------- the app ----------

app_running() { [ "$(systemctl --user is-active "$UNIT" 2>/dev/null)" = active ]; }
app_pid() { systemctl --user show -p MainPID --value "$UNIT" 2>/dev/null; }
# What the app printed since it was last started.
app_log() { journalctl --user --no-pager -o cat _SYSTEMD_INVOCATION_ID="$(systemctl --user show -p InvocationID --value "$UNIT")"; }

# The island: the app's visible X11 window that isn't one of its other windows.
island() {
  local w
  for w in $(xdotool search --onlyvisible --pid "$(app_pid)" 2>/dev/null); do
    case "$(xdotool getwindowname "$w")" in "AiN settings" | "AiN" | "AiN capture") continue ;; esac
    echo "$w"
    return
  done
}

# GNOME opens its overview at login, over everything: back to the desktop.
overview_active() {
  gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell \
    --method org.freedesktop.DBus.Properties.Get org.gnome.Shell OverviewActive 2>/dev/null | grep -q true
}
leave_overview() {
  overview_active || return 0
  ydotool key 1:1 1:0 >/dev/null # Esc
  wait_for 5 '! overview_active'
}

# Starts the app from its default settings (its stored data removed, models kept), and waits for the island to
# be laid out: folded to the pill (before the frontend runs, the window has a default size).
start_app() {
  leave_overview
  systemctl --user stop "$UNIT" 2>/dev/null
  rm -rf ~/.config/dev.satcom.ain ~/.cache/dev.satcom.ain
  # Its data too, but for the downloaded models: they're big, and sent from the host (no internet).
  find ~/.local/share/dev.satcom.ain -mindepth 1 -maxdepth 1 ! -name models -exec rm -rf {} + 2>/dev/null
  systemd-run --user --unit="$UNIT" --collect "$BIN" >/dev/null 2>&1
  wait_for 60 'w=$(island) && [ -n "$w" ] && is_folded "$w"' && sleep 2
}
ensure_app() { { app_running && [ -n "$(island)" ]; } || start_app; }

# ---------- the pointer and the island ----------

# geom WINDOW: sets X Y WIDTH HEIGHT to the part of WINDOW that takes input (its X11 input shape's
# bounds), on screen. The island's window keeps one size: its input follows the pill.
geom() {
  eval "$(xdotool getwindowgeometry --shell "$1")"
  local dx dy
  read -r dx dy WIDTH HEIGHT < <(python3 -c "
import ctypes, sys
x11, xext = ctypes.CDLL('libX11.so.6'), ctypes.CDLL('libXext.so.6')
class Rect(ctypes.Structure): _fields_ = [('x', ctypes.c_short), ('y', ctypes.c_short), ('w', ctypes.c_ushort), ('h', ctypes.c_ushort)]
x11.XOpenDisplay.restype = ctypes.c_void_p
xext.XShapeGetRectangles.restype = ctypes.POINTER(Rect)
xext.XShapeGetRectangles.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int)]
d, n, order = x11.XOpenDisplay(None), ctypes.c_int(), ctypes.c_int()
r = xext.XShapeGetRectangles(d, int(sys.argv[1]), 2, ctypes.byref(n), ctypes.byref(order))  # ShapeInput
rs = [r[i] for i in range(n.value)]
if not rs: sys.exit(print(0, 0, 0, 0))
l, t = min(q.x for q in rs), min(q.y for q in rs)
print(l, t, max(q.x + q.w for q in rs) - l, max(q.y + q.h for q in rs) - t)" "$1")
  X=$((X + dx)) Y=$((Y + dy))
}
under() { xdotool getmouselocation --shell | sed -n 's/^WINDOW=//p'; }
# point X Y: to the bottom-right corner, then a relative move: exact with the flat pointer profile.
point() {
  gsettings set org.gnome.desktop.peripherals.mouse accel-profile flat
  ydotool mousemove -x 4000 -y 4000 >/dev/null
  sleep 0.2
  ydotool mousemove -x $(($1 - SW + 1)) -y $(($2 - SH + 1)) >/dev/null
}
click() { ydotool click 0xC0 >/dev/null; }
# Where XWayland last saw the pointer: right while it's over an X11 window (the island), stale elsewhere.
pointer() { xdotool getmouselocation | sed -E 's/^x:([0-9]+) y:([0-9]+).*/\1 \2/'; }
# reach X Y: `point`, then corrected: relative moves can come up short (seen by 180 px). Only for
# a target on an X11 window, where `pointer` is right.
reach() {
  local i px py
  point "$1" "$2"
  for i in 1 2 3; do
    sleep 0.1
    read -r px py < <(pointer)
    [ "$px" = "$1" ] && [ "$py" = "$2" ] && return 0
    ydotool mousemove -x $(($1 - px)) -y $(($2 - py)) >/dev/null
  done
}
# glide_to X Y: from where the pointer is to X Y, in small steps, as a hand moves. Starts from an
# X11 window (the island), where XWayland knows the pointer's position; within the island, it
# never leaves it (`point` goes by the screen's corner, so the island would fold and reopen).
glide_to() {
  local px py i n=10
  read -r px py < <(pointer)
  for ((i = 1; i <= n; i++)); do
    ydotool mousemove -x $((($1 - px) * i / n - ($1 - px) * (i - 1) / n)) -y $((($2 - py) * i / n - ($2 - py) * (i - 1) / n)) >/dev/null
    sleep 0.03
  done
}
# hover_click X Y: onto X Y within the open island, a rest (the web view wants the hover), a click.
hover_click() {
  glide_to "$1" "$2"
  sleep 0.3
  ydotool mousemove -x 1 -y 0 >/dev/null
  sleep 0.05
  ydotool mousemove -x -1 -y 0 >/dev/null
  sleep 0.5
  click
}

is_open() { geom "$1" && [ "$HEIGHT" -gt 100 ]; }
is_folded() { geom "$1" && [ "$HEIGHT" -le 50 ]; }
# The pointer on the island, which opens; true once it has.
open_island() {
  local w
  w=$(island)
  is_open "$w" && return 0
  geom "$w"
  reach $((X + WIDTH / 2)) $((Y + HEIGHT / 2))
  # A hand never stops dead: a few small moves over the pill, which the web view's hover wants.
  local i
  for i in 1 2 3; do
    ydotool mousemove -x 0 -y 4 >/dev/null
    sleep 0.05
    ydotool mousemove -x 0 -y -4 >/dev/null
    sleep 0.05
  done
  wait_for 5 "is_open $w"
}
# The island open, a second hover if the first didn't take: on a busy host the web view can miss
# the first one. A test's clicks then land on the island, never on the desktop behind it.
open_island_sure() { open_island || { fold_island; open_island; }; }
# The pointer away, down out of the island as a hand would; true once the island has folded.
# Not a jump: XWayland only sees the pointer over X11 windows, so the island must see it cross its
# window's lower edge (its transparent margin) to know it left.
fold_island() {
  local w i
  w=$(island)
  geom "$w"
  reach $((X + WIDTH / 2)) $((Y + HEIGHT / 2))
  for i in $(seq 1 30); do
    ydotool mousemove -x 0 -y 12 >/dev/null
    sleep 0.03
  done
  wait_for 5 "is_folded $w"
}

# The open island's tab bar at the default settings, left to right (the frontend's widget ids).
# Update it when the default layout changes; 30-tabs' screenshots show what each click opened.
TABS=(media clock timer volume clipboard stats privacy dictation tts persona)
# Where they are in the open island's window (472 wide: the panel and its shadow): the first tab's
# centre, the gap between tabs in tenths of a pixel, the bar's height, the settings gear.
# shellcheck disable=SC2034  # used by the tests
TAB_X=59 TAB_DX10=306 BAR_Y=48 GEAR_FROM_RIGHT=96

# tab NAME: opens the island and clicks that tab.
tab() {
  local i w
  for i in "${!TABS[@]}"; do [ "${TABS[$i]}" = "$1" ] && break; done
  [ "${TABS[$i]}" = "$1" ] || { echo "no tab $1 in TABS" >&2; return 1; }
  open_island_sure || return 1
  w=$(island)
  geom "$w"
  hover_click $((X + TAB_X + i * TAB_DX10 / 10)) $((Y + BAR_Y))
  sleep 1
}

# ---------- the settings window ----------

settings_shown() { xdotool search --onlyvisible --name "^AiN settings$" >/dev/null 2>&1; }
# Closes the settings windows as their close button does (WM_DELETE_WINDOW), and waits until they're
# gone. Not `xdotool windowclose`: it destroys the X window under the app, and GNOME's helper that
# draws X11 title bars (mutter-x11-frames) quits on the X error that follows, for the rest of the
# session; GNOME then shows no decorated X11 window at all.
settings_close() {
  local s
  for s in $(xdotool search --name "^AiN settings$" 2>/dev/null); do xdotool windowquit "$s" 2>/dev/null; done
  wait_for 10 '! xdotool search --name "^AiN settings$" >/dev/null 2>&1'
}

# ---------- other apps ----------

# copy_wayland TEXT: a native Wayland app puts TEXT on the clipboard (and keeps it a few seconds).
copy_wayland() {
  GDK_BACKEND=wayland timeout 6 python3 -c "
import sys, gi; gi.require_version('Gtk','3.0'); from gi.repository import Gtk, Gdk, GLib
w=Gtk.Window(); w.show()
GLib.timeout_add(800, lambda: Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD).set_text(sys.argv[1], -1) and False)
GLib.timeout_add(5000, Gtk.main_quit); Gtk.main()" "$1" 2>/dev/null
}
# copy_x11 TEXT: the same from an X11 client, as AiN is on GNOME (in the background for 10 s).
copy_x11() {
  GDK_BACKEND=x11 timeout 10 python3 -c "
import sys, gi; gi.require_version('Gtk','3.0'); from gi.repository import Gtk, Gdk, GLib
GLib.timeout_add(300, lambda: Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD).set_text(sys.argv[1], -1) and False)
GLib.timeout_add(9000, Gtk.main_quit); Gtk.main()" "$1" 2>/dev/null &
}
# What the clipboard holds, whichever app owns it. Read as an X11 client: GNOME lets a Wayland
# client read it only with the keyboard focus, which a background script doesn't get.
clipboard_text() {
  GDK_BACKEND=x11 timeout 5 python3 -c "
import gi; gi.require_version('Gtk','3.0'); from gi.repository import Gtk, Gdk
print(Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD).wait_for_text() or '', end='')" 2>/dev/null
}
# keys CODE...: presses then releases each Linux key code in turn (layout-independent ones only).
keys() {
  local k args=()
  for k in "$@"; do args+=("$k:1"); done
  for ((k = $# - 1; k >= 0; k--)); do args+=("${*:k+1:1}:0"); done
  ydotool key "${args[@]}" >/dev/null
}
# shellcheck disable=SC2034  # used by the tests
KEY_CTRL=29 KEY_SHIFT=42 KEY_ESC=1 KEY_C=46 KEY_V=47 KEY_HOME=102 KEY_END=107

editor_open() {
  flatpak kill org.gnome.TextEditor 2>/dev/null
  rm -rf ~/.var/app/org.gnome.TextEditor/data
  systemd-run --user --unit=vmtest-editor --collect flatpak run org.gnome.TextEditor >/dev/null 2>&1
  # A Wayland window, out of xdotool's sight: its process (comm, cut to 15 characters), then time to draw.
  wait_for 40 'pgrep -x gnome-text-edit >/dev/null' && sleep 4
}
editor_close() {
  flatpak kill org.gnome.TextEditor 2>/dev/null
  rm -rf ~/.var/app/org.gnome.TextEditor/data
}
