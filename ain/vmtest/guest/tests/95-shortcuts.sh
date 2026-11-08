# shellcheck shell=bash disable=SC2016  # check/wait_for evaluate their single-quoted conditions later
# timeout: 900
# The global shortcuts, as a user presses them: ydotool sends the real keys to the compositor, so
# this exercises the whole chain — GNOME's GlobalShortcuts portal, AiN's registration, and the
# window or action each command opens. The defaults are the ones listed in the README.

start_app
# Let the frontend load and ask the portal to bind before the first key press.
sleep 3
# The portal asks once per user; the answer is remembered by GNOME Shell.
shot shortcuts-portal
allowed=0
# shellcheck disable=SC2034  # read by the check below, through eval
allow_shortcuts_dialog && allowed=1
check X01 "a real key press opens the first shortcut's popup" '[ "$allowed" = 1 ]' "Super+Shift+B opened nothing"
check X02 "AiN logs no shortcut registration failure" '! grep -qi "island: shortcuts:" <<<"$(app_log)"' \
  "$(grep -i "island: shortcuts:" <<<"$(app_log)" | tail -2 | tr '\n' ' ')"
check X03 "the island is folded before the shortcuts are pressed" 'is_folded "$(island)"' "$(geom "$(island)" 2>/dev/null; echo "${WIDTH}x$HEIGHT")"
base_windows=$(window_count)

# popup_shortcut ID WHAT KEYCODE MODIFIER...: the chord opens the shortcut popup; Escape closes it.
popup_shortcut() {
  local id=$1 what=$2 key=$3
  shift 3
  snapshot_windows
  chord "$key" "$@"
  if ! wait_new_window 8; then
    check "$id" "$what" 'false' "no visible popup after the shortcut"
    return 1
  fi
  local w=$NEW_WINDOW
  check "$id" "$what" '[ "$(window_title "$w")" = "AiN" ] && [ "$(window_width "$w")" -ge 300 ]' \
    "title=$(window_title "$w") size=$(window_width "$w")x$(window_height "$w")"
  keys "$KEY_ESC"
  wait_window_gone 5 "$w" || true
  return 0
}

popup_shortcut X10 "Super+Shift+B opens the clipboard history" "$KEY_B" "$KEY_SUPER" "$KEY_SHIFT"
popup_shortcut X11 "Super+Alt+Space opens the command palette" "$KEY_SPACE" "$KEY_SUPER" "$KEY_ALT"

# The zones overlay covers the screen; Esc cancels the picker.
snapshot_windows
chord "$KEY_Z" "$KEY_CTRL" "$KEY_ALT" "$KEY_SUPER"
if wait_new_window 8; then
  z=$NEW_WINDOW
  geom "$z"
  check X12 "Ctrl+Alt+Super+Z opens the zones picker" '[ "$(window_title "$z")" = "AiN zones" ]' "title=$(window_title "$z")"
  check X13 "the zones picker covers the screen" '[ "$WIDTH" -ge $((SW - 2)) ] && [ "$HEIGHT" -ge $((SH - 2)) ]' "${WIDTH}x$HEIGHT on ${SW}x${SH}"
  keys "$KEY_ESC"
  wait_window_gone 8 "$z" || true
  check X14 "Esc closes the zones picker" '! window_visible "$z"' "still visible"
else
  check X12 "Ctrl+Alt+Super+Z opens the zones picker" 'false' "no zone window after the shortcut"
fi

# Capture needs the desktop's screenshot permission (the portal already holds one on a desktop
# that used it); the overlay is "AiN capture", full screen.
snapshot_windows
chord "$KEY_S" "$KEY_SUPER" "$KEY_ALT"
if wait_new_window 12; then
  c=$NEW_WINDOW
  geom "$c"
  check X15 "Super+Alt+S opens the capture overlay" '[ "$(window_title "$c")" = "AiN capture" ] && [ "$HEIGHT" -gt 200 ]' \
    "title=$(window_title "$c") ${WIDTH}x$HEIGHT"
  keys "$KEY_ESC"; sleep 0.4; keys "$KEY_ESC"
  wait_window_gone 8 "$c" || true
else
  check X15 "Super+Alt+S opens the capture overlay" 'false' "no overlay: $(app_log | grep -i capture | tail -2 | tr '\n' ' ')"
fi

# The action shortcuts open no window: each one must reach the app without killing it.
for entry in "X20:Ctrl+Alt+D:dictation:$KEY_D" "X21:Ctrl+Alt+R:read aloud:$KEY_R" \
             "X22:Ctrl+Alt+O:spelling:$KEY_O" "X23:Ctrl+Alt+H:transcript:$KEY_H"; do
  IFS=: read -r id name what key <<<"$entry"
  chord "$key" "$KEY_CTRL" "$KEY_ALT"
  sleep 1.5
  check "$id" "$name ($what) reaches the app without a crash" 'app_alive' "$(app_log | tail -3 | tr '\n' ' ')"
done

check X30 "all shortcuts left the window count unchanged" '[ "$(window_count)" -le "$base_windows" ]' "before=$base_windows now=$(window_count)"
check X31 "no panic after the shortcuts" '! grep -qiE "panicked at|segmentation fault|core dumped" <<<"$(app_log)"' \
  "$(grep -iE "panicked at|segmentation fault|core dumped" <<<"$(app_log)" | head -2 | tr '\n' ' ')"

# The grant outlives the app: a restart keeps the shortcuts usable without a new dialog.
restart_app
popup_shortcut X32 "a shortcut still works after a restart" "$KEY_B" "$KEY_SUPER" "$KEY_SHIFT"

fold_island
shot shortcuts
