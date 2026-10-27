# shellcheck shell=bash disable=SC2016  # check/wait_for evaluate their single-quoted conditions later
# The app starts from its default settings, and the island settles at the top of the screen.
start_app
log=$(app_log)
check T01 "app running" 'app_running' "service not active"
check T02 "no window error at start" '! grep -qiE "no monitor|failed to prepare|panicked" <<<"$log"' \
  "$(grep -iE "no monitor|failed|panic" <<<"$log" | head -2 | tr '\n' ' ')"
w=$(island)
check T03 "the island is an X11 (XWayland) window" '[ -n "$w" ]' "no X11 window for ain"
[ -n "$w" ] || return 0
fold_island
geom "$w"
check T04 "centered" '[ $((X + WIDTH / 2 - SW / 2)) -ge -2 ] && [ $((X + WIDTH / 2 - SW / 2)) -le 2 ]' "x=$X w=$WIDTH"
check T05 "at the top of the screen" '[ "$Y" -ge 0 ] && [ "$Y" -le 40 ]' "y=$Y"
st=$(xprop -id "$w" _NET_WM_STATE)
check T06 "kept above, on all workspaces" 'grep -q ABOVE <<<"$st" && grep -q STICKY <<<"$st"' "$st"
check T07 "folded, it's pill-sized" '[ "$HEIGHT" -le 50 ] && [ "$WIDTH" -le 400 ]' "${WIDTH}x$HEIGHT"
shot launch
