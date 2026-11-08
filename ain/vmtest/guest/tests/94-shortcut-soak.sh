# shellcheck shell=bash disable=SC2016  # check/wait_for evaluate their single-quoted conditions later
# timeout: 900
# A shortcut fired again and again: the popup must open and close each time, with no duplicate
# window, no growing process, and no crash. This is the path a user takes dozens of times a day.

start_app
sleep 3
allowed=0
# shellcheck disable=SC2034  # read by the check below, through eval
allow_shortcuts_dialog && allowed=1
check X50 "a real key press opens the shortcut popup before the soak" '[ "$allowed" = 1 ]' "Super+Shift+B opened nothing"

pid=$(app_pid)
resources "$pid"
rss0=$RSS_KB fd0=$FD_COUNT th0=$THREAD_COUNT cg0=$CGROUP_MB proc0=$PROCESS_COUNT
base_windows=$(window_count)
metric X52 rss_kb_start "$rss0"
metric X52 cgroup_mb_start "$cg0"
metric X52 processes_start "$proc0"
metric X52 fd_start "$fd0"
metric X52 windows_start "$base_windows"

cycles=10
started=$SECONDS
opened=0
for ((i = 1; i <= cycles; i++)); do
  if shortcut_popup; then
    opened=$((opened + 1))
    close_shortcut_popup
  fi
done
elapsed=$((SECONDS - started))
metric X53 cycles "$cycles"
metric X53 opened "$opened"
metric X53 seconds "$elapsed"

check X54 "the clipboard popup opened every time" '[ "$opened" -eq "$cycles" ]' "opened=$opened of $cycles"
check X55 "the app is still running" 'app_alive' "$(app_log | tail -3 | tr '\n' ' ')"
check X56 "no window was left behind" '[ "$(window_count)" -le "$base_windows" ]' "before=$base_windows now=$(window_count)"
resources "$pid"
metric X57 rss_kb_end "$RSS_KB"
metric X57 cgroup_mb_end "$CGROUP_MB"
metric X57 processes_end "$PROCESS_COUNT"
metric X57 fd_end "$FD_COUNT"
metric X57 thread_end "$THREAD_COUNT"
grew X57 "memory stays bounded across the firings" "$RSS_KB" "$rss0" $((128 * 1024))
grew X57B "the app's whole cgroup stays bounded" "$CGROUP_MB" "$cg0" 256
grew X57C "no leaked WebKit process" "$PROCESS_COUNT" "$proc0" 4
grew X58 "no file descriptor leak across the firings" "$FD_COUNT" "$fd0" 24
grew X59 "no thread leak across the firings" "$THREAD_COUNT" "$th0" 12
check X60 "no panic across the firings" '! grep -qiE "panicked at|segmentation fault|core dumped" <<<"$(app_log)"' \
  "$(grep -iE "panicked at|segmentation fault|core dumped" <<<"$(app_log)" | head -2 | tr '\n' ' ')"
shot shortcut-soak
