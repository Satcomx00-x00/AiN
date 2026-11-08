# shellcheck shell=bash disable=SC2016  # check/wait_for evaluate their single-quoted conditions later
# A click in the island window's transparent margin, below the folded pill, goes through to what's
# under it: the input shape excludes the margin, so the island stays folded instead of taking the
# click. (`xdotool`'s window-under-pointer is the bounding window on XWayland, not the input shape,
# so this presses instead of looking.)
ensure_app
w=$(island)
fold_island
geom "$w"
point $((X + WIDTH / 2)) $((Y + HEIGHT + 40))
sleep 0.5
click
sleep 1
check T12 "a click below the pill goes through" 'is_folded "$w"' "the island took the click"
shot click-through
