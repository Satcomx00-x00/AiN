# shellcheck shell=bash disable=SC2016  # check/wait_for evaluate their single-quoted conditions later
# After everything above: the app is still up, and never crashed.
check T17 "still running" 'app_running' "the app exited"
log=$(app_log)
check T18 "no panic or crash in the app's output" '! grep -qiE "panicked at|segmentation fault|core dumped" <<<"$log"' \
  "$(grep -iE "panicked at|segmentation fault|core dumped" <<<"$log" | head -2 | tr '\n' ' ')"
