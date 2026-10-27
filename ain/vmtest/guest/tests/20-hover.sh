# shellcheck shell=bash disable=SC2016  # check/wait_for evaluate their single-quoted conditions later
# The island opens under the pointer and folds when it leaves.
ensure_app
w=$(island)
fold_island
open_island
geom "$w"
check T08 "opens on hover" '[ "$HEIGHT" -gt 100 ]' "${WIDTH}x$HEIGHT"
check T09 "still centered when open" '[ $((X + WIDTH / 2 - SW / 2)) -ge -2 ] && [ $((X + WIDTH / 2 - SW / 2)) -le 2 ]' "x=$X w=$WIDTH"
shot open
fold_island
geom "$w"
check T11 "folds when the pointer leaves" '[ "$HEIGHT" -le 50 ]' "${WIDTH}x$HEIGHT"
