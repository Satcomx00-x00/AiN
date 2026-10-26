# shellcheck shell=bash disable=SC2016  # check/wait_for evaluate their single-quoted conditions later
# Around the folded pill, the island's window lets clicks through to what's under it.
ensure_app
w=$(island)
fold_island
geom "$w"
point $((X + WIDTH / 2)) $((Y + HEIGHT + 60))
sleep 1
check T12 "under the folded pill, the pointer is over the desktop" '[ "$(under)" != "$w" ]' "still over the island"
