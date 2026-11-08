# AGENTS.md

- Frontend: `ain/` — scripts in `ain/package.json`, code in `ain/src/` (features, shell, sdk), Rust in `ain/src-tauri/`.
- Docs: start at `docs/architecture.md`; testing in `docs/testing.md`, plugins in `docs/plugins.md`, updates in `docs/updates.md`.
- Checks: `prek run --all-files` (`pre-commit` hooks); add `--hook-stage pre-push` for compilers and tests. CI runs the same in `.github/workflows/ci.yml`. Setup: `prek install --prepare-hooks`, plus `bun install` in `ain/` (a fresh worktree has no `node_modules`, and the commit-msg hook needs it).
- Commits: Conventional Commits, enforced by commitlint (commit-msg hook and CI).
- Release: merging to `main` publishes — a green CI run cuts a release for feat/fix/perf, not docs/ci/chore (README §Release, `.github/workflows/release.yml`).
