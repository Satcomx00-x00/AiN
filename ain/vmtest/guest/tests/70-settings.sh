# shellcheck shell=bash disable=SC2016  # check/wait_for evaluate their single-quoted conditions later
# The gear opens the settings window, as the first click after the app starts: a user's first visit.
start_app
gear
wait_for 20 settings_shown
check T15 "the settings window opens on the first click after start" 'settings_shown' "window state: $(settings_state)"
shot settings
settings_close

fold_island
