# shellcheck shell=bash disable=SC2016  # check/wait_for evaluate their single-quoted conditions later
# The gear opens the settings window, as the first click after the app starts: a user's first visit.
# How GNOME holds the settings windows that exist: "Iconic" for created but never shown.
settings_state() {
  local s states=""
  for s in $(xdotool search --name "^AiN settings$" 2>/dev/null); do
    states+="$(xprop -id "$s" WM_STATE | sed -n 's/.*window state: //p') "
  done
  echo "${states:-no window}"
}
gear() {
  open_island_sure
  geom "$(island)"
  hover_click $((X + WIDTH - GEAR_FROM_RIGHT)) $((Y + BAR_Y))
}

start_app
gear
wait_for 10 settings_shown
check T15 "the settings window opens on the first click after start" 'settings_shown' "window state: $(settings_state)"
shot settings
settings_close

fold_island
