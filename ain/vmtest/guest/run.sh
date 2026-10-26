#!/usr/bin/env bash
# Runs one test file in the desktop session: run.sh tests/NN-name.sh
# The runner talks to it through stdout (results, screenshot requests) and stdin (screenshot taken):
# stdin moves to fd 3 so nothing in a test can swallow those answers.
exec 3<&0 0</dev/null
cd "$(dirname "$0")" || exit 1
# shellcheck source=lib.sh disable=SC1091  # checked on its own
source ./lib.sh
# shellcheck disable=SC1090
source "$1"
# Results are the PASS/FAIL/LOOK lines, not the status of whatever command came last.
exit 0
