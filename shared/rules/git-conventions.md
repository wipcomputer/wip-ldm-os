# Git Conventions

## Never commit to main

All work happens on branches. The pre-commit hook blocks commits on main.

## Never squash merge

Every commit has co-authors and tells the story. Always `--merge` or fast-forward.

## Never push directly to main

Always use a branch and PR.

## Co-authors on every commit

List all contributors. Read co-author lines from `settings/config.json` in your workspace.

## Branch prefixes

Each agent uses a prefix from `settings/config.json` agents section. Prevents collisions.

## Worktrees

Use worktrees for isolated work. Main working tree stays on main (read-only).

## Issues go on the public repo

For private/public repo pairs, all issues go on the public repo.
