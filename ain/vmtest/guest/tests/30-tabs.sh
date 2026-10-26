# shellcheck shell=bash disable=SC2016  # check/wait_for evaluate their single-quoted conditions later
# Clicking tabs keeps the island open, and shows their widget.
ensure_app
w=$(island)
for t in stats clipboard media; do
  tab "$t"
  geom "$w"
  check "T10-$t" "stays open after a click on the $t tab" '[ "$HEIGHT" -gt 100 ]' "${WIDTH}x$HEIGHT"
  shot "tab-$t"
  look "T10-$t-shown" "the $t tab shows its widget" "tab-$t"
done
fold_island
