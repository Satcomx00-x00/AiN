# shellcheck shell=bash disable=SC2016  # check/wait_for evaluate their single-quoted conditions later
# timeout: 1800
# A soak of the island's main loop: hover, open, click every tab, fold, again and again. The app
# must stay alive and responsive, keep its geometry, keep one window, and not leak memory, file
# descriptors or threads. The numbers go in the run's Metrics table, so a regression shows as a
# trend across runs, not just a pass/fail.

start_app
pid=$(app_pid)
w=$(island)
fold_island
geom "$w"
base_x=$X base_w=$WIDTH
base_windows=$(window_count)
resources "$pid"
rss0=$RSS_KB fd0=$FD_COUNT th0=$THREAD_COUNT cg0=$CGROUP_MB proc0=$PROCESS_COUNT
metric S01 rss_kb_start "$rss0"
metric S01 cgroup_mb_start "$cg0"
metric S01 processes_start "$proc0"
metric S01 fd_start "$fd0"
metric S01 thread_start "$th0"
metric S01 windows_start "$base_windows"

cycles=20
started=$SECONDS
for ((i = 1; i <= cycles; i++)); do
  t=${TABS[$((i % ${#TABS[@]}))]}
  tab "$t" >/dev/null 2>&1 || true
  fold_island >/dev/null 2>&1 || true
  app_alive || break
done
elapsed=$((SECONDS - started))

check S01 "survives $cycles open/click/fold cycles" 'app_alive' "$(app_log | tail -3 | tr '\n' ' ')"
metric S02 cycle_seconds "$elapsed"

resources "$pid"
metric S03 rss_kb_end "$RSS_KB"
metric S03 cgroup_mb_end "$CGROUP_MB"
metric S03 processes_end "$PROCESS_COUNT"
metric S03 fd_end "$FD_COUNT"
metric S03 thread_end "$THREAD_COUNT"
metric S03 windows_end "$(window_count)"

grew S04 "memory stays bounded over the soak" "$RSS_KB" "$rss0" $((256 * 1024))
grew S04B "the app's whole cgroup stays bounded" "$CGROUP_MB" "$cg0" 512
grew S05 "no file descriptor leak" "$FD_COUNT" "$fd0" 32
grew S05B "no leaked WebKit process" "$PROCESS_COUNT" "$proc0" 4
grew S06 "no thread leak" "$THREAD_COUNT" "$th0" 16

fold_island
geom "$w"
check S07 "the island is still centered" '[ $((X + WIDTH / 2 - SW / 2)) -ge -2 ] && [ $((X + WIDTH / 2 - SW / 2)) -le 2 ]' "x=$X w=$WIDTH"
check S08 "the island kept its size and place" '[ "$WIDTH" -eq "$base_w" ] && [ "$X" -eq "$base_x" ]' "before=${base_w}px at $base_x, now=${WIDTH}px at $X"
check S09 "no window was left open" '[ "$(window_count)" -le "$base_windows" ]' "before=$base_windows now=$(window_count)"
check S10 "Settings was never left open" '! settings_shown'
check S11 "no panic or crash during the soak" '! grep -qiE "panicked at|segmentation fault|core dumped" <<<"$(app_log)"' \
  "$(grep -iE "panicked at|segmentation fault|core dumped" <<<"$(app_log)" | head -2 | tr '\n' ' ')"

# It still answers after the soak: a hover opens it, a click opens Settings.
open_island || true
check S12 "still opens on hover after the soak" 'is_open "$(island)"' "$(geom "$(island)" 2>/dev/null; echo "${WIDTH}x$HEIGHT")"
fold_island
shot stability
