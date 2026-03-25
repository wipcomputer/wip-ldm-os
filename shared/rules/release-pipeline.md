# Release Pipeline

## Three steps. Never combine. Never skip.

| Step | What happens | What it means |
|------|-------------|---------------|
| **Merge** | PR merged to main | Code lands. Nothing else changes. |
| **Deploy** | wip-release + deploy-public.sh | Published to npm + GitHub. Not on your machine yet. |
| **Install** | Run the install prompt | Extensions updated on your machine. Only when Parker says "install." |

After Deploy, STOP. Do not copy files. Do not npm install -g. Do not npm link. Dogfood the install prompt.

## The workflow

1. Create worktree, make changes, commit
2. Write RELEASE-NOTES on the branch (not after)
3. Push, create PR, merge (--merge, never squash)
4. `git checkout main && git pull`
5. `wip-release patch` (auto-detects release notes)
6. `deploy-public.sh` to sync public repo
7. Dogfood: `Read https://wip.computer/install/wip-ldm-os.txt`

## Never run tools from repo clones

Installed tools are for execution. Repo clones are for development. Use the installed commands (`crystal`, `wip-release`, `mdview`, etc.), never run from source.
