# shellcheck shell=bash disable=SC2016  # check/wait_for evaluate their single-quoted conditions later
# timeout: 300
# GNOME's window rules for AiN's windows: the island stays above other windows on every workspace
# and out of the task switcher, the settings window is an ordinary window, and only the island's
# input follows the pill (its window stays one size, shaped instead of resized).

ensure_app
w=$(island)
fold_island
state=$(xprop -id "$w" _NET_WM_STATE)
check W01 "the island is kept above other windows" 'grep -q ABOVE <<<"$state"' "$state"
check W02 "the island is on every workspace" 'grep -q STICKY <<<"$state"' "$state"
check W03 "the island stays out of the task switcher" 'grep -q SKIP_TASKBAR <<<"$state" && grep -q SKIP_PAGER <<<"$state"' "$state"
type=$(xprop -id "$w" _NET_WM_WINDOW_TYPE)
check W04 "the island asks for a sensible window type" 'grep -qE "DOCK|UTILITY|NORMAL" <<<"$type"' "$type"
geom "$w"
window=$(xdotool getwindowgeometry --shell "$w" | sed -n 's/^WIDTH=//p')
check W05 "folded, the input area is smaller than the window" '[ "$WIDTH" -lt "$window" ]' "input=${WIDTH} window=${window}"

open_island_sure
geom "$w"
check W06 "open, the input area covers the panel" '[ "$HEIGHT" -gt 100 ] && [ "$WIDTH" -gt 300 ]' "${WIDTH}x$HEIGHT"
check W07 "open, the island is centered" '[ $((X + WIDTH / 2 - SW / 2)) -ge -2 ] && [ $((X + WIDTH / 2 - SW / 2)) -le 2 ]' "x=$X w=$WIDTH"
fold_island

# Settings: an ordinary window, shown when asked, closed without destroying it under GNOME.
gear
wait_for 15 settings_shown || { gear; wait_for 10 settings_shown; }
s=$(xdotool search --onlyvisible --name "^AiN settings$" 2>/dev/null | head -1)
check W10 "the settings window is visible" '[ -n "$s" ]' "window state: $(settings_state)"
if [ -n "$s" ]; then
  sstate=$(xprop -id "$s" _NET_WM_STATE)
  check W11 "Settings is not always-on-top" '! grep -q ABOVE <<<"$sstate"' "$sstate"
  check W12 "Settings has its own title" '[ "$(xdotool getwindowname "$s")" = "AiN settings" ]' "$(xdotool getwindowname "$s")"
fi
settings_close
check W13 "Settings closes cleanly" '! settings_shown' "window state: $(settings_state)"
check W14 "no window was left behind" '[ "$(window_count)" -le 1 ]' "visible app windows: $(window_count)"
shot window-rules
