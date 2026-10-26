# shellcheck shell=bash disable=SC2016  # check/wait_for evaluate their single-quoted conditions later
# A copy in a native Wayland app lands in the clipboard history.
ensure_app
text="vmtest Wayland copy $(date +%H%M%S)"
copy_wayland "$text"
sleep 1
tab clipboard
shot clipboard
look T13 "the clipboard tab lists \"$text\"" clipboard
fold_island
