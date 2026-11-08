# shellcheck shell=bash disable=SC2016  # check/wait_for evaluate their single-quoted conditions later
# timeout: 600
# The app's lifecycle on the desktop: stop and start it as a user does, with its settings kept.
# Every restart must come back folded, centered, one process only, able to open Settings, and
# without a crash in the previous run's output. A restart that takes longer over time is a leak.

start_app
w=$(island)
base_windows=$(window_count)
metric S30 windows_at_start "$base_windows"

for round in 1 2 3; do
  started=$SECONDS
  restart_app
  elapsed=$((SECONDS - started))
  metric "S31-$round" restart_seconds "$elapsed"
  check "S30-$round" "restart $round brings the app back" 'app_alive' "$(app_log | tail -3 | tr '\n' ' ')"
  w=$(island)
  geom "$w"
  check "S32-$round" "restart $round comes back folded" '[ "$HEIGHT" -le 50 ]' "${WIDTH}x$HEIGHT"
  check "S33-$round" "restart $round is centered" '[ $((X + WIDTH / 2 - SW / 2)) -ge -2 ] && [ $((X + WIDTH / 2 - SW / 2)) -le 2 ]' "x=$X w=$WIDTH"
  check "S34-$round" "restart $round leaves one process" '[ "$(pgrep -fc "$BIN")" -le 1 ]' "processes: $(pgrep -fc "$BIN")"
  check "S35-$round" "restart $round has no crash in the log" '! grep -qiE "panicked at|segmentation fault|core dumped" <<<"$(app_log)"' \
    "$(grep -iE "panicked at|segmentation fault|core dumped" <<<"$(app_log)" | head -2 | tr '\n' ' ')"
done

# The settings a restart kept: Settings still opens, and the island still answers the pointer.
gear
wait_for 15 settings_shown
check S36 "Settings opens after the restarts" 'settings_shown' "window state: $(settings_state)"
settings_close
check S37 "no window was left behind" '[ "$(window_count)" -le "$base_windows" ]' "before=$base_windows now=$(window_count)"
fold_island
shot restart
