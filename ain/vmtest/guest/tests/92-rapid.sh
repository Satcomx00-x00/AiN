# shellcheck shell=bash disable=SC2016  # check/wait_for evaluate their single-quoted conditions later
# timeout: 600
# The races around the island's edges: open and fold in quick succession, then click every tab with
# almost no pause. A stale hover, a lost pointer or a click on a folding window must not crash the
# app, leave a window behind, or move the island.

start_app
pid=$(app_pid)
w=$(island)
fold_island
geom "$w"
base_cx=$((X + WIDTH / 2))
base_windows=$(window_count)
resources "$pid"
rss0=$RSS_KB cg0=$CGROUP_MB proc0=$PROCESS_COUNT
metric S20 rss_kb_start "$rss0"
metric S20 cgroup_mb_start "$cg0"
metric S20 processes_start "$proc0"

cycles=15
started=$SECONDS
for ((i = 1; i <= cycles; i++)); do
  open_island_sure || break
  # Leave and come back without resting: the web view gets hover events while the window folds.
  fold_island >/dev/null 2>&1 || true
done
elapsed=$((SECONDS - started))
metric S21 open_fold_cycles "$cycles"
metric S21 open_fold_seconds "$elapsed"
check S20 "survives $cycles rapid open/fold cycles" 'app_alive' "$(app_log | tail -3 | tr '\n' ' ')"

# Every tab, one after the other, with only the click's own rest: no window left over, no crash.
open_island_sure || true
geom "$(island)"
for ((i = 0; i < ${#TABS[@]}; i++)); do
  hover_click $((X + TAB_X + i * TAB_DX10 / 10)) $((Y + BAR_Y))
  sleep 0.15
done
sleep 1
check S21 "survives clicking every tab in quick succession" 'app_alive' "$(app_log | tail -3 | tr '\n' ' ')"
check S22 "no extra window after the rapid clicks" '[ "$(window_count)" -le "$base_windows" ]' "before=$base_windows now=$(window_count)"
check S23 "no panic during the races" '! grep -qiE "panicked at|segmentation fault|core dumped" <<<"$(app_log)"' \
  "$(grep -iE "panicked at|segmentation fault|core dumped" <<<"$(app_log)" | head -2 | tr '\n' ' ')"

fold_island
geom "$w"
check S24 "the island keeps its centre" '[ $((X + WIDTH / 2)) -ge $((base_cx - 2)) ] && [ $((X + WIDTH / 2)) -le $((base_cx + 2)) ]' "before=${base_cx}px, now=$((X + WIDTH / 2))px (${WIDTH}px at $X)"
check S25 "still centered after the races" '[ $((X + WIDTH / 2 - SW / 2)) -ge -2 ] && [ $((X + WIDTH / 2 - SW / 2)) -le 2 ]' "x=$X w=$WIDTH"
resources "$pid"
metric S26 rss_kb_end "$RSS_KB"
metric S26 cgroup_mb_end "$CGROUP_MB"
metric S26 processes_end "$PROCESS_COUNT"
grew S26 "memory stays bounded through the races" "$RSS_KB" "$rss0" $((256 * 1024))
grew S26B "the app's whole cgroup stays bounded" "$CGROUP_MB" "$cg0" 512
grew S26C "no leaked WebKit process" "$PROCESS_COUNT" "$proc0" 4
shot rapid
