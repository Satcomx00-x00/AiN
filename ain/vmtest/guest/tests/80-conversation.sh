# shellcheck shell=bash disable=SC2016  # check/wait_for evaluate their single-quoted conditions later
# Conversation on a computer without PersonaPlex (no NVIDIA GPU, no internet): the tab says why it
# can't talk instead of failing silently, Settings offers the install, and an install that can't
# work here says why, in a notification; the app lives through all of it.
alive() { app_running && [ -n "$(island)" ]; }
# In the open island's window: the tab's round Talk button (left) and its Settings chip (right).
TALK_X=64 TALK_Y=104 CHIP_FROM_RIGHT=82

start_app
tab persona
geom "$(island)"
check T30 "the Conversation tab opens" 'is_open "$(island)"' "${WIDTH}x$HEIGHT"
shot conversation
look T31 "Conversation shows its Talk button and how to use it" conversation

# Talk, with nothing installed: a reason on the tab, not a crash.
hover_click $((X + TALK_X)) $((Y + TALK_Y))
sleep 3
check T32 "pressing Talk without PersonaPlex keeps the app running" 'alive' "$(app_log | tail -3 | tr '\n' ' ')"
shot conversation-talk
look T33 "the tab says PersonaPlex isn't installed, and where to install it" conversation-talk

# Its Settings chip leads to Conversation's page in Settings.
open_island_sure
geom "$(island)"
hover_click $((X + WIDTH - CHIP_FROM_RIGHT)) $((Y + TALK_Y))
wait_for 15 settings_shown
check T34 "the tab's Settings chip opens Settings" 'settings_shown'
s=$(xdotool search --onlyvisible --name "^AiN settings$" 2>/dev/null | head -1)
[ -n "$s" ] && xdotool windowsize "$s" 1100 760 && xdotool windowmove "$s" 200 120 && sleep 2
shot conversation-settings
look T35 "Settings shows Conversation's page: engine, PersonaPlex's row with Install, voice, persona" conversation-settings

# Install, offline and without uv or a Python PyTorch supports: it must say why, and the app live on.
if [ -n "$s" ]; then
  # The row's Install button, at the right of PersonaPlex's row: where it is in the window at
  # 1100x760 (its geometry counts the invisible shadow round a window drawing its own title bar).
  geom "$s"
  echo "settings window geometry: $X $Y ${WIDTH}x$HEIGHT" >&2
  INSTALL_X=$((X + ${INSTALL_DX:-993})) INSTALL_Y=$((Y + ${INSTALL_DY:-495}))
  point "$INSTALL_X" "$INSTALL_Y"
  sleep 0.5
  click
  sleep 8
  shot conversation-install
  look T36 "the install says why it can't (a notification, bottom right), with its code and Copy" conversation-install
  check T37 "a failed install keeps the app running" 'alive' "$(app_log | tail -5 | tr '\n' ' ')"
  check T38 "Settings still open after the failed install" 'settings_shown'
fi
echo "app log, last lines: $(app_log | tail -8 | tr '\n' '|')" >&2

settings_close
fold_island
