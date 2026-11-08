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
# ydotool's client looks for the daemon's socket in the runtime folder; templates and the dev VM
# run `ydotoold --socket-path=$XDG_RUNTIME_DIR/.ydotool_socket` for the desktop user.
export YDOTOOL_SOCKET=$XDG_RUNTIME_DIR/.ydotool_socket
BIN=~/vmtest/ain
UNIT=vmtest-ain
read -r SW SH < <(xdotool getdisplaygeometry)

# The Gtk clipboard helpers need PyGObject; a mise-installed python may lack it, the system one has it.
PYTHON=$(for p in /usr/bin/python3 python3; do "$p" -c 'import gi' 2>/dev/null && { echo "$p"; break; }; done)
PYTHON=${PYTHON:-python3}

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
# metric ID NAME VALUE: a number the run keeps, shown in the summary's Metrics table.
metric() { echo "METRIC $1 $2 $3"; }
# resources PID: sets RSS_KB, FD_COUNT and THREAD_COUNT for that process, and CGROUP_MB and
# PROCESS_COUNT for the app's whole systemd cgroup (WebKit's web and network processes included).
resources() {
  RSS_KB=$(awk '/^VmRSS:/ {print $2}' "/proc/$1/status" 2>/dev/null)
  FD_COUNT=$(find "/proc/$1/fd" -mindepth 1 -maxdepth 1 2>/dev/null | wc -l)
  THREAD_COUNT=$(find "/proc/$1/task" -mindepth 1 -maxdepth 1 2>/dev/null | wc -l)
  RSS_KB=${RSS_KB:-0} FD_COUNT=${FD_COUNT:-0} THREAD_COUNT=${THREAD_COUNT:-0}
  CGROUP_MB=$(systemctl --user show -p MemoryCurrent --value "$UNIT" 2>/dev/null)
  case "$CGROUP_MB" in
    '' | *[!0-9]*) CGROUP_MB=0 ;;
    *) CGROUP_MB=$((CGROUP_MB / 1048576)) ;;
  esac
  local cg
  cg=$(systemctl --user show -p ControlGroup --value "$UNIT" 2>/dev/null)
  PROCESS_COUNT=$(wc -l <"/sys/fs/cgroup$cg/cgroup.procs" 2>/dev/null)
  PROCESS_COUNT=${PROCESS_COUNT:-0}
}
# grew ID WHAT NOW BASE MAX: passes while NOW - BASE stays within MAX.
grew() {
  local delta=$(($3 - $4))
  check "$1" "$2" "[ $delta -le $5 ]" "before=$4 now=$3 delta=$delta max=$5"
}

# ---------- the app ----------

app_running() { [ "$(systemctl --user is-active "$UNIT" 2>/dev/null)" = active ]; }
app_pid() { systemctl --user show -p MainPID --value "$UNIT" 2>/dev/null; }
# What the app printed since it was last started.
app_log() { journalctl --user --no-pager -o cat _SYSTEMD_INVOCATION_ID="$(systemctl --user show -p InvocationID --value "$UNIT")"; }

# The island: the app's visible X11 window that isn't one of its other windows. A window can be
# briefly unmapped while GNOME switches views (the overview hides it): wait a moment for it.
island() {
  local w i
  for i in 1 2 3 4 5; do
    for w in $(xdotool search --onlyvisible --pid "$(app_pid)" 2>/dev/null); do
      case "$(xdotool getwindowname "$w")" in "AiN settings" | "AiN" | "AiN capture") continue ;; esac
      echo "$w"
      return 0
    done
    sleep 0.2
  done
  return 1
}

# GNOME opens its overview at login, over everything: back to the desktop.
overview_active() {
  gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell \
    --method org.freedesktop.DBus.Properties.Get org.gnome.Shell OverviewActive 2>/dev/null | grep -q true
}
# screen_locked: the lock screen is up, so the pointer and keys would go there, not to the app.
screen_locked() {
  gdbus call --session --dest org.gnome.ScreenSaver --object-path /org/gnome/ScreenSaver \
    --method org.gnome.ScreenSaver.GetActive 2>/dev/null | grep -q true
}
leave_overview() {
  overview_active || return 0
  ydotool key 1:1 1:0 >/dev/null # Esc
  wait_for 5 '! overview_active'
}

# Starts the app as the user's session would, and waits for the island to be laid out: folded to the
# pill (before the frontend runs, the window has a default size).
launch_app() {
  leave_overview
  systemd-run --user --unit="$UNIT" --collect "$BIN" >/dev/null 2>&1
  # The frontend attaches its pointer listeners after the startup animation (2.3 s for "hello",
  # with a 6 s limit): on a software-rendered VM that lands later than the folded window does.
  wait_for 60 'w=$(island) && [ -n "$w" ] && is_folded "$w"' && sleep 5
  answer_shortcuts_dialog
}
# answer_shortcuts_dialog: the GlobalShortcuts portal shows gnome-control-center's "Add Keyboard
# Shortcuts" dialog on the first bind of shortcuts the desktop hasn't stored yet. It is a Wayland
# window, so xdotool can't see it; it covers the island until answered. Its _Add button's mnemonic
# works here, but not on every gnome-control-center: then click the header's right end. Once the
# shortcuts are stored the dialog doesn't come back (until reset_shortcut_grant forgets them).
answer_shortcuts_dialog() {
  local i x y top
  grant_dconf && return 0
  for i in 1 2 3; do
    chord "$KEY_A" "$KEY_ALT"
    sleep 1.2
    grant_dconf && return 0
    keys "$KEY_ENTER"
    sleep 1.2
    grant_dconf && return 0
    keys "$KEY_TAB"; sleep 0.2; keys "$KEY_ENTER"
    sleep 1.2
    grant_dconf && return 0
  done
  # No portal at all: the app logged why, and there is no dialog to click.
  app_log | grep -q "island: shortcuts:" && return 1
  if pointer_ready; then
    for top in 20 40 60 80 $((SH / 2 - 370)) $((SH / 2 - 350)) $((SH / 2 - 330)) $((SH / 2 - 310)); do
      [ "$top" -lt 0 ] && continue
      for x in $((SW / 2 + 200)) $((SW / 2 + 225)) $((SW / 2 + 250)) $((SW / 2 + 275)) $((SW / 2 + 300)); do
        pointer_move "$x" "$top"
        sleep 0.15
        pointer_click
        sleep 0.8
        grant_dconf && return 0
      done
    done
  fi
  return 1
}
# The GlobalShortcuts grant. A remembered grant makes the portal answer BindShortcuts without its
# dialog. That is what the tests want: the dialog is a Wayland window above the island, covering it
# until someone clicks Add, and its mnemonics/position vary with gnome-control-center. guest/
# shortcuts.dconf holds the defaults this build binds, so the provider sees nothing new and the
# portal binds them straight away. The runner restores the desktop's own grant after the run.
reset_shortcut_grant() {
  dconf reset -f /org/gnome/settings-daemon/global-shortcuts/ 2>/dev/null || true
}
seed_shortcut_grant() {
  reset_shortcut_grant
  [ -f ~/vmtest/guest/shortcuts.dconf ] && dconf load /org/gnome/settings-daemon/global-shortcuts/ < ~/vmtest/guest/shortcuts.dconf 2>/dev/null
}
stop_app() {
  systemctl --user stop "$UNIT" 2>/dev/null
  systemctl --user reset-failed "$UNIT" 2>/dev/null
}
# Starts the app from its default settings (its stored data removed, models kept).
start_app() {
  leave_overview
  # GNOME's calendar / notifications panel is a Wayland surface above the island: XWayland doesn't
  # see it, so the tests would aim at the island and the panel would take the click. Esc closes it.
  keys "$KEY_ESC"
  sleep 0.3
  stop_app
  seed_shortcut_grant
  rm -rf ~/.config/dev.satcom.ain ~/.cache/dev.satcom.ain
  # The defaults with the startup animation off: its listeners attach after a promise that can stall
  # on a software-rendered VM, leaving the island inert. The runner generates this from the source.
  mkdir -p ~/.config/dev.satcom.ain
  [ -f ~/vmtest/guest/settings.test.json ] && cp ~/vmtest/guest/settings.test.json ~/.config/dev.satcom.ain/settings.json
  # Its data too, but for the downloaded models: they're big, and sent from the host (no internet).
  find ~/.local/share/dev.satcom.ain -mindepth 1 -maxdepth 1 ! -name models -exec rm -rf {} + 2>/dev/null
  launch_app
  ensure_interactive
}
# ensure_interactive: hover must open the island. A start can still be inert (the web view drew
# but takes no pointer events); one more start is the recovery. Leaves the island folded.
ensure_interactive() {
  local i
  for i in 1 2; do
    open_island >/dev/null 2>&1 && {
      fold_island >/dev/null 2>&1
      return 0
    }
    stop_app
    seed_shortcut_grant
    launch_app
  done
  return 1
}
# restart_app: the app again with the settings it has, as a user would (no wipe).
restart_app() { stop_app; seed_shortcut_grant; launch_app; ensure_interactive; }
ensure_app() { { app_running && [ -n "$(island)" ]; } || start_app; }
app_alive() { app_running && [ -n "$(island)" ]; }

# ---------- the pointer and the island ----------

# geom WINDOW: sets X Y WIDTH HEIGHT to the part of WINDOW that takes input (its X11 input shape's
# bounds), on screen. The island's window keeps one size: its input follows the pill.
geom() {
  [ -n "$1" ] || return 1
  eval "$(xdotool getwindowgeometry --shell "$1")" || return 1
  local dx dy
  read -r dx dy WIDTH HEIGHT < <("$PYTHON" -c "
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

# ---------- the pointer: absolute through uinput ----------
# ydotool moves a relative mouse, which a desktop accelerates: on some machines a long move is
# scaled ~2x and the pointer misses the island. The helper in guest/ain-pointer.c creates an
# absolute uinput pointer instead, read commands from a FIFO, so `move X Y` lands on that pixel.
# It runs as root (only root may create uinput devices) and is installed where a service can
# execute it; when it can't start, the ydotool relative path below is used.
POINTER_FIFO=$XDG_RUNTIME_DIR/ain-pointer.fifo
POINTER_BIN=$HOME/vmtest/ain-pointer
POINTER_SRC=$HOME/vmtest/guest/ain-pointer.c
start_pointer() {
  pointer_ready && return 0
  [ -f "$POINTER_SRC" ] || return 1
  if [ ! -x "$POINTER_BIN" ] || [ "$POINTER_SRC" -nt "$POINTER_BIN" ]; then
    cc -O2 -o "$POINTER_BIN" "$POINTER_SRC" >/dev/null 2>&1 || return 1
  fi
  sudo -n install -m755 "$POINTER_BIN" /usr/local/bin/ain-pointer >/dev/null 2>&1 || return 1
  sudo -n systemctl stop vmtest-pointer >/dev/null 2>&1 || true
  sudo -n systemctl reset-failed vmtest-pointer >/dev/null 2>&1 || true
  rm -f "$POINTER_FIFO"
  sudo -n systemd-run --unit=vmtest-pointer --collect /usr/local/bin/ain-pointer "$POINTER_FIFO" "$(id -u)" "$(id -g)" "$SW" "$SH" >/dev/null 2>&1 || return 1
  wait_for 5 'pointer_ready'
}
stop_pointer() {
  sudo -n systemctl stop vmtest-pointer >/dev/null 2>&1 || true
  sudo -n systemctl reset-failed vmtest-pointer >/dev/null 2>&1 || true
  rm -f "$POINTER_FIFO"
}
# Both the daemon and its FIFO: a FIFO left by a stopped daemon would block a writer forever.
pointer_ready() { [ -p "$POINTER_FIFO" ] && systemctl is-active --quiet vmtest-pointer 2>/dev/null; }
pointer_move() {
  pointer_ready || return 1
  printf 'move %s %s\n' "$1" "$2" | timeout 1 tee "$POINTER_FIFO" >/dev/null 2>&1 || true
}
pointer_click() {
  pointer_ready || return 1
  printf 'click\n' | timeout 1 tee "$POINTER_FIFO" >/dev/null 2>&1 || true
}
LAST_X=${LAST_X:-$((SW / 2))}
LAST_Y=${LAST_Y:-$((SH / 2))}

# point X Y: the absolute pointer, with a short glide so the web view sees motion; a single jump
# from outside is not a hover it acts on. Falls back to the relative ydotool path.
point() {
  local x=$1 y=$2 i px=${LAST_X:-$((SW / 2))} py=${LAST_Y:-$((SH / 2))}
  if pointer_ready; then
    for i in 1 2 3 4 5; do
      pointer_move $((px + (x - px) * i / 5)) $((py + (y - py) * i / 5))
      sleep 0.03
    done
    LAST_X=$x LAST_Y=$y
    return 0
  fi
  gsettings set org.gnome.desktop.peripherals.mouse accel-profile flat
  ydotool mousemove -x 4000 -y 4000 >/dev/null
  sleep 0.2
  ydotool mousemove -x $(($1 - SW + 1)) -y $(($2 - SH + 1)) >/dev/null
}
click() {
  if pointer_ready; then pointer_click; else ydotool click 0xC0 >/dev/null; fi
}
# Where XWayland last saw the pointer: right while it's over an X11 window (the island), stale elsewhere.
pointer() { xdotool getmouselocation | sed -E 's/^x:([0-9]+) y:([0-9]+).*/\1 \2/'; }
# reach X Y: `point`, then corrected: relative moves can come up short (seen by 180 px). Only for
# a target on an X11 window, where `pointer` is right. The absolute pointer needs no correction.
reach() {
  local i px py
  if pointer_ready; then point "$1" "$2"; return 0; fi
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
  local x=$1 y=$2 i n=10 px=${LAST_X:-$((SW / 2))} py=${LAST_Y:-$((SH / 2))}
  if pointer_ready; then
    for ((i = 1; i <= n; i++)); do
      pointer_move $((px + (x - px) * i / n)) $((py + (y - py) * i / n))
      sleep 0.02
    done
    LAST_X=$x LAST_Y=$y
    return 0
  fi
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
  if pointer_ready; then
    pointer_move $(($1 + 1)) "$2"
    sleep 0.05
    pointer_move "$1" "$2"
  else
    ydotool mousemove -x 1 -y 0 >/dev/null
    sleep 0.05
    ydotool mousemove -x -1 -y 0 >/dev/null
  fi
  sleep 0.5
  click
}

is_open() { geom "$1" && [ "$HEIGHT" -gt 100 ]; }
is_folded() { geom "$1" && [ "$HEIGHT" -le 50 ]; }
# The pointer on the island, which opens; true once it has. The web view may still be attaching
# its listeners, and the input shape follows the open animation, which is slow on software
# rendering: keep the pointer on the pill and give each attempt time.
open_island() {
  local w i cx cy
  w=$(island) || return 1
  [ -n "$w" ] || return 1
  is_open "$w" && return 0
  for _ in 1 2 3; do
    geom "$w" || return 1
    cx=$((X + WIDTH / 2)) cy=$((Y + HEIGHT / 2))
    reach "$cx" "$cy"
    # A hand never stops dead: a few small moves over the pill, which the web view's hover wants.
    for i in 1 2 3 4 5; do
      if pointer_ready; then
        pointer_move "$cx" $((cy + 4))
        sleep 0.06
        pointer_move "$cx" "$cy"
      else
        ydotool mousemove -x 0 -y 4 >/dev/null
        sleep 0.06
        ydotool mousemove -x 0 -y -4 >/dev/null
      fi
      sleep 0.06
    done
    wait_for 2 "is_open $w" && return 0
    # A click focuses the window and opens the island (its click listener). On a desktop that
    # doesn't deliver hover to an unfocused web view, this is what a user does to make it answer.
    if pointer_ready; then
      pointer_move "$cx" "$cy"
      sleep 0.2
    fi
    click
    wait_for 4 "is_open $w" && return 0
    # Still folded: a last nudge, then the shape has a little more time to follow.
    if pointer_ready; then
      pointer_move $((cx + 4)) "$cy"
      sleep 0.05
      pointer_move "$cx" "$cy"
    fi
    wait_for 3 "is_open $w" && return 0
  done
  return 1
}
# The island open, a second hover if the first didn't take: on a busy host the web view can miss
# the first one. A test's clicks then land on the island, never on the desktop behind it.
open_island_sure() { open_island || { fold_island; open_island; }; }
# The pointer away, down out of the island as a hand would; true once the island has folded.
# Not a jump: XWayland only sees the pointer over X11 windows, so the island must see it cross its
# window's lower edge (its transparent margin) to know it left.
fold_island() {
  local w i
  w=$(island) || return 1
  [ -n "$w" ] || return 1
  geom "$w" || return 1
  reach $((X + WIDTH / 2)) $((Y + HEIGHT / 2))
  local cx=$((X + WIDTH / 2)) cy=$((Y + HEIGHT / 2))
  if pointer_ready; then
    for i in $(seq 1 30); do
      pointer_move "$cx" $((cy + i * 12))
      sleep 0.02
    done
    LAST_X=$cx LAST_Y=$((cy + 360))
  else
    for i in $(seq 1 30); do
      ydotool mousemove -x 0 -y 12 >/dev/null
      sleep 0.03
    done
  fi
  wait_for 5 "is_folded $w"
}

# The open island's tab bar, left to right; settings.test.json puts these first, in this order.
# Update it when the default layout changes; 30-tabs' screenshots show what each click opened.
TABS=(media clock timer volume clipboard stats privacy dictation tts persona)
# Where they are in the open island's input area: the input region carries the pointer margin
# (window.rs INPUT_MARGIN, 8 logical px on each side), so the visible panel starts 8 px in and the
# measured centres shift by it. First tab's centre, the gap in tenths of a pixel, the bar's height,
# the settings gear from the right. Re-measure if the panel's width or the margin changes.
# shellcheck disable=SC2034  # used by the tests
TAB_X=52 TAB_DX10=300 BAR_Y=42 GEAR_FROM_RIGHT=106

# tab NAME: opens the island and clicks that tab.
tab() {
  local i w
  for i in "${!TABS[@]}"; do [ "${TABS[$i]}" = "$1" ] && break; done
  [ "${TABS[$i]}" = "$1" ] || { echo "no tab $1 in TABS" >&2; return 1; }
  open_island_sure || return 1
  w=$(island) || return 1
  [ -n "$w" ] || return 1
  geom "$w" || return 1
  hover_click $((X + TAB_X + i * TAB_DX10 / 10)) $((Y + BAR_Y))
  sleep 1
}
# cycle_tabs ROUNDS: opens the island and clicks every tab, then folds it, ROUNDS times.
cycle_tabs() {
  local rounds=${1:-1} r t
  for ((r = 0; r < rounds; r++)); do
    for t in "${TABS[@]}"; do tab "$t" >/dev/null 2>&1 || return 1; done
    fold_island || return 1
  done
}

# ---------- the settings window ----------

settings_shown() { xdotool search --onlyvisible --name "^AiN settings$" >/dev/null 2>&1; }
# How GNOME holds the settings windows that exist: "Iconic" for created but never shown.
settings_state() {
  local s states=""
  for s in $(xdotool search --name "^AiN settings$" 2>/dev/null); do
    states+="$(xprop -id "$s" WM_STATE | sed -n 's/.*window state: //p') "
  done
  echo "${states:-no window}"
}
# gear: opens the island and clicks the settings gear.
gear() {
  open_island_sure || return 1
  geom "$(island)" || return 1
  hover_click $((X + WIDTH - GEAR_FROM_RIGHT)) $((Y + BAR_Y))
}
# cycle_settings ROUNDS: opens Settings with the gear and closes it as a user does, ROUNDS times.
cycle_settings() {
  local rounds=${1:-1} r
  for ((r = 0; r < rounds; r++)); do
    gear || return 1
    wait_for 15 settings_shown || return 1
    settings_close || return 1
  done
}
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
  GDK_BACKEND=wayland timeout 6 "$PYTHON" -c "
import sys, gi; gi.require_version('Gtk','3.0'); from gi.repository import Gtk, Gdk, GLib
w=Gtk.Window(); w.show()
GLib.timeout_add(800, lambda: Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD).set_text(sys.argv[1], -1) and False)
GLib.timeout_add(5000, Gtk.main_quit); Gtk.main()" "$1" 2>/dev/null
}
# copy_x11 TEXT: the same from an X11 client, as AiN is on GNOME (in the background for 10 s).
copy_x11() {
  GDK_BACKEND=x11 timeout 10 "$PYTHON" -c "
import sys, gi; gi.require_version('Gtk','3.0'); from gi.repository import Gtk, Gdk, GLib
GLib.timeout_add(300, lambda: Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD).set_text(sys.argv[1], -1) and False)
GLib.timeout_add(9000, Gtk.main_quit); Gtk.main()" "$1" 2>/dev/null &
}
# What the clipboard holds, whichever app owns it. Read as an X11 client: GNOME lets a Wayland
# client read it only with the keyboard focus, which a background script doesn't get.
clipboard_text() {
  GDK_BACKEND=x11 timeout 5 "$PYTHON" -c "
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
# chord KEYCODE [MODIFIER...]: holds the modifiers, taps the key, releases the modifiers. This is
# what the desktop's shortcut portal sees, whichever keyboard layout is active.
chord() {
  local key=$1 i args=()
  shift
  for i in "$@"; do args+=("$i:1"); done
  args+=("$key:1" "$key:0")
  for ((i = $#; i >= 1; i--)); do args+=("${!i}:0"); done
  ydotool key "${args[@]}" >/dev/null
}
# shellcheck disable=SC2034  # used by the tests
# shellcheck disable=SC2034  # used by the tests
KEY_CTRL=29 KEY_ALT=56 KEY_SHIFT=42 KEY_SUPER=125 KEY_ESC=1 KEY_C=46 KEY_V=47 KEY_HOME=102 KEY_END=107
# shellcheck disable=SC2034  # used by the tests
KEY_A=30 KEY_B=48 KEY_D=32 KEY_H=35 KEY_O=24 KEY_R=19 KEY_S=31 KEY_T=20 KEY_Z=44 KEY_SPACE=57
# shellcheck disable=SC2034  # used by the tests
KEY_LEFT=105 KEY_RIGHT=106 KEY_ENTER=28 KEY_TAB=15

# ---------- the app's windows ----------
# app_windows: one line per visible window of the app: id, then its title.
app_windows() {
  local w
  for w in $(xdotool search --onlyvisible --pid "$(app_pid)" 2>/dev/null); do
    printf '%s\t%s\n' "$w" "$(xdotool getwindowname "$w" 2>/dev/null)"
  done
}
# window_count: how many visible windows the app has.
window_count() { app_windows | wc -l; }
# snapshot_windows: remembers which visible windows exist now (BEFORE_IDS).
snapshot_windows() { BEFORE_IDS=$(app_windows | cut -f1 | tr '\n' ' '); }
# wait_new_window SECONDS: waits for a visible window that wasn't in BEFORE_IDS; sets NEW_WINDOW.
wait_new_window() {
  local end=$((SECONDS + $1)) w
  while :; do
    for w in $(app_windows | cut -f1); do
      # shellcheck disable=SC2034  # the tests read it
      case " $BEFORE_IDS " in *" $w "*) ;; *) NEW_WINDOW=$w; return 0 ;; esac
    done
    [ "$SECONDS" -ge "$end" ] && return 1
    sleep 0.2
  done
}
# window_title WINDOW: its title, or empty.
window_title() { xdotool getwindowname "$1" 2>/dev/null; }
# window_width WINDOW / window_height WINDOW: its X11 size.
window_width() { xdotool getwindowgeometry --shell "$1" 2>/dev/null | sed -n 's/^WIDTH=//p'; }
window_height() { xdotool getwindowgeometry --shell "$1" 2>/dev/null | sed -n 's/^HEIGHT=//p'; }
# window_visible WINDOW: whether the app shows that window now.
window_visible() { xdotool search --onlyvisible --pid "$(app_pid)" 2>/dev/null | grep -qx "$1"; }
# wait_window_gone SECONDS WINDOW: until the app hides it.
wait_window_gone() {
  local end=$((SECONDS + $1))
  while window_visible "$2"; do
    [ "$SECONDS" -ge "$end" ] && return 1
    sleep 0.2
  done
}

# ---------- the desktop's shortcut grant ----------
# AiN binds on Wayland through the GlobalShortcuts portal, which asks the user once; GNOME Shell
# keeps that answer. The only reliable test of the grant is a real key press: shortcut_popup fires
# Super+Shift+B and says whether the popup opened. allow_shortcuts_dialog answers the one-time
# dialog (a Wayland window xdotool cannot see) by keyboard: Enter, then Tab+Enter, until the
# shortcut works. shortcuts_granted reports the portal permission store entry, when GNOME keeps one.
shortcut_popup() {
  snapshot_windows
  chord "$KEY_B" "$KEY_SUPER" "$KEY_SHIFT"
  wait_new_window 8 || return 1
  SHORTCUT_WINDOW=$NEW_WINDOW
  [ "$(window_title "$NEW_WINDOW")" = "AiN" ] && [ "$(window_width "$NEW_WINDOW")" -ge 300 ]
}
close_shortcut_popup() {
  [ -n "$SHORTCUT_WINDOW" ] || return 0
  keys "$KEY_ESC"
  wait_window_gone 5 "$SHORTCUT_WINDOW" || true
  SHORTCUT_WINDOW=
}
allow_shortcuts_dialog() {
  shortcut_popup && { close_shortcut_popup; return 0; }
  answer_shortcuts_dialog || return 1
  shortcut_popup && { close_shortcut_popup; return 0; }
  return 1
}
# grant_dconf: the shortcuts GNOME's provider stored for this app.
grant_dconf() {
  dconf dump /org/gnome/settings-daemon/global-shortcuts/dev.satcom.ain/ 2>/dev/null | grep -q .
}
# shortcuts_granted: whether the portal's permission store has an entry for this app (GNOME 50
# answers through the Shell instead, so this is a diagnostic, not the gate).
shortcuts_granted() {
  timeout 5 gdbus call --session --dest org.freedesktop.impl.portal.PermissionStore \
    --object-path /org/freedesktop/impl/portal/PermissionStore \
    --method org.freedesktop.impl.portal.PermissionStore.Lookup global-shortcuts dev.satcom.ain >/dev/null 2>&1
}

editor_open() {
  systemctl --user stop vmtest-editor 2>/dev/null
  systemctl --user reset-failed vmtest-editor 2>/dev/null
  if flatpak info org.gnome.TextEditor >/dev/null 2>&1; then
    flatpak kill org.gnome.TextEditor 2>/dev/null
    rm -rf ~/.var/app/org.gnome.TextEditor/data
    systemd-run --user --unit=vmtest-editor --collect flatpak run org.gnome.TextEditor >/dev/null 2>&1
  else
    # The distribution's own build (the dev VM has it; the templates use the flatpak).
    rm -rf ~/.config/gnome-text-editor ~/.local/share/gnome-text-editor ~/.cache/gnome-text-editor \
      ~/.config/org.gnome.TextEditor ~/.local/share/org.gnome.TextEditor ~/.cache/org.gnome.TextEditor
    systemd-run --user --unit=vmtest-editor --collect gnome-text-editor >/dev/null 2>&1
  fi
  # A Wayland window, out of xdotool's sight: its process (comm, cut to 15 characters), then time to draw.
  wait_for 40 'pgrep -x gnome-text-edit >/dev/null' && sleep 4
}
editor_close() {
  systemctl --user stop vmtest-editor 2>/dev/null
  flatpak kill org.gnome.TextEditor 2>/dev/null
  rm -rf ~/.var/app/org.gnome.TextEditor/data ~/.config/gnome-text-editor ~/.local/share/gnome-text-editor \
    ~/.cache/gnome-text-editor ~/.config/org.gnome.TextEditor ~/.local/share/org.gnome.TextEditor ~/.cache/org.gnome.TextEditor
}
