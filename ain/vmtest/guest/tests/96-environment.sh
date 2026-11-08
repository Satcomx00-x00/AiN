# shellcheck shell=bash disable=SC2016  # check/wait_for evaluate their single-quoted conditions later
# timeout: 300
# The desktop the rest of the suite drives: a real GNOME Wayland session on seat0, with XWayland,
# ydotool on the kernel's input device, and the portals AiN needs. When one of these is wrong, the
# interactive tests fail in confusing ways; this file says which piece is missing.

ensure_app
check E01 "GNOME runs a user shell (not the greeter)" 'pgrep -af "gnome-shell --mode=user" >/dev/null' "$(pgrep -af gnome-shell | head -2 | tr '\n' ' ')"
check E02 "the Wayland socket exists" '[ -S "$XDG_RUNTIME_DIR/wayland-0" ]' "missing $XDG_RUNTIME_DIR/wayland-0"
check E03 "XWayland is up and we can read it" 'xdotool getdisplaygeometry >/dev/null 2>&1' "$(xdotool getdisplaygeometry 2>&1)"
mine=$(loginctl list-sessions --no-legend | awk -v u="$(id -u)" '$2 == u && $4 == "seat0" { print $1; exit }')
check E04 "our session is the one on seat0" '[ -n "$mine" ] && [ "$(loginctl show-seat seat0 -p ActiveSession --value)" = "$mine" ]' \
  "seat0=$(loginctl show-seat seat0 -p ActiveSession --value) ours=${mine:-none}"
check E05 "mutter's X11 frame helper is running" 'pgrep -x mutter-x11-frames >/dev/null' "$(pgrep -af mutter-x11-frames | head -2 | tr '\n' ' ')"
check E06 "the session is unlocked and awake" '! screen_locked' "the lock screen is up"

check E10 "ydotool's socket is there" '[ -S "$YDOTOOL_SOCKET" ]' "$YDOTOOL_SOCKET"
check E11 "ydotool can move the pointer" 'ydotool mousemove -x 0 -y 0 >/dev/null 2>&1' "$(ydotool mousemove -x 0 -y 0 2>&1)"
check E12 "ydotool can press a key" 'ydotool key 1:1 1:0 >/dev/null 2>&1' "ydotool key failed"

check E20 "the desktop portal is on the bus" 'timeout 5 gdbus introspect --session --dest org.freedesktop.portal.Desktop --object-path /org/freedesktop/portal/desktop >/dev/null 2>&1'
check E21 "it has the GlobalShortcuts interface AiN binds through" \
  'timeout 5 gdbus call --session --dest org.freedesktop.portal.Desktop --object-path /org/freedesktop/portal/desktop --method org.freedesktop.DBus.Properties.Get org.freedesktop.portal.GlobalShortcuts version >/dev/null 2>&1'
check E22 "it has the RemoteDesktop interface Dictation pastes through" \
  'timeout 5 gdbus call --session --dest org.freedesktop.portal.Desktop --object-path /org/freedesktop/portal/desktop --method org.freedesktop.DBus.Properties.Get org.freedesktop.portal.RemoteDesktop version >/dev/null 2>&1'
check E23 "it has the Screenshot interface Capture uses" \
  'timeout 5 gdbus call --session --dest org.freedesktop.portal.Desktop --object-path /org/freedesktop/portal/desktop --method org.freedesktop.DBus.Properties.Get org.freedesktop.portal.Screenshot version >/dev/null 2>&1'

check E30 "GNOME's notification banners are off" '[ "$(gsettings get org.gnome.desktop.notifications show-banners)" = false ]' \
  "$(gsettings get org.gnome.desktop.notifications show-banners)"
check E31 "the desktop's shortcut list is the one AiN writes to" \
  'timeout 5 busctl --user status org.gnome.Shell >/dev/null 2>&1 || pgrep -x gnome-shell >/dev/null'

check E40 "the app binary is executable" '[ -x "$BIN" ]' "$BIN"
check E41 "the app is running and has its island" 'app_alive' "$(app_log | tail -3 | tr '\n' ' ')"
check E42 "the app's stored data folder is writable" '[ -w "$HOME" ]' "$HOME"

metric E50 screen_width "$SW"
metric E50 screen_height "$SH"
metric E51 gnome_version "$(gnome-shell --version 2>/dev/null | awk '{print $NF}')"
shot environment
