#!/usr/bin/env bash
# The commit-msg hook's linter. A fresh clone or worktree has no ain/node_modules yet: say what to
# do instead of letting bun report a missing `commitlint` binary.
set -euo pipefail

root=$(git rev-parse --show-toplevel)
if [ ! -d "$root/ain/node_modules/@commitlint/cli" ]; then
  echo "commitlint isn't installed: run 'bun install' in ain/ first." >&2
  exit 1
fi
cd "$root"
exec bun run --cwd ain commitlint "$@"
