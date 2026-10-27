# shellcheck shell=bash disable=SC2016  # check/wait_for evaluate their single-quoted conditions later
# Dictation's way of typing on GNOME: the text copied by an X11 client (as AiN is), then Ctrl+V sent
# with ydotool into a native Wayland app; accents survive on any keyboard layout.
ensure_app
check T14 "ydotool usable without root" 'ydotool mousemove -x 0 -y 0 >/dev/null 2>&1' \
  "socket: $(ls -la "$XDG_RUNTIME_DIR/.ydotool_socket" 2>&1)"
text="Dicté par vmtest : été, ça marche, ÀÉÈ œ €"
editor_open
copy_x11 "$text"
wait_for 10 '[ "$(clipboard_text)" = "$text" ]'
keys "$KEY_CTRL" "$KEY_V"
sleep 1.5
wait
shot paste
# Read it back: select all, copy, and ask the Wayland clipboard.
keys "$KEY_CTRL" "$KEY_HOME"
keys "$KEY_CTRL" "$KEY_SHIFT" "$KEY_END"
keys "$KEY_CTRL" "$KEY_C"
sleep 0.5
got=$(clipboard_text)
check T16 "pasted text arrives intact" '[ "$got" = "$text" ]' "got: $got"
editor_close
