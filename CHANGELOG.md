# Changelog


## 0.4.9 (2026-03-16)

# LDM OS v0.4.9

Stale install lockfiles auto-cleaned. Dead PID locks removed automatically instead of blocking with "remove the file manually." Closes #66.

## Issues closed

- Closes #66

## 0.4.8 (2026-03-16)

# LDM OS v0.4.8

Dry-run output is now a table. Every update gets its own row. Closes #64.

## Issues closed

- Closes #64

## 0.4.7 (2026-03-16)

# LDM OS v0.4.7

Three fixes from dogfood:

1. MCP registration strips `/tmp/` clone prefixes (`wip-install-wip-1password` -> `wip-1password`). Closes #54 follow-up.
2. `ldm doctor --fix` cleans stale MCP entries from `~/.claude.json` (entries with `/tmp/` paths or clone prefix names).
3. `ldm status` shows pending npm updates. Reads from installed package.json, not stale registry. Closes #34.
4. `ldm stack list` shows full contents (component and MCP server names, not just counts). Closes #60.

## Issues closed

- Closes #34
- Closes #60

## 0.4.6 (2026-03-16)

# LDM OS v0.4.6

`ldm status` now tells you what needs updating before you ask.

## What changed

`ldm status` checks every installed extension against npm and shows version diffs. No more "everything looks fine" when 3 extensions are behind. The SKILL.md now tells the AI to run `ldm status` before presenting the summary, so users see updates upfront.

Also reads from the actual installed package.json, not the registry (which could be stale).

## Issues closed

- Closes #34
- Closes #60

## 0.4.5 (2026-03-16)

# LDM OS v0.4.5

`ldm stack list` now shows what's in each stack. Lists every component and MCP server by name instead of just counts.

## Issues closed

- Closes #60

## 0.4.4 (2026-03-16)

# LDM OS v0.4.4

`ldm install` finally works the way it should.

## npm version checking (per extension)

`ldm install --dry-run` now checks every installed extension against npm using its own package name. Shows real version diffs:

```
  Checking npm for updates...
  Would update 3 extension(s) from npm:
    wip-branch-guard: v1.9.30 -> v1.9.36 (@wipcomputer/wip-branch-guard)
    ldm-install-wip-xai-grok: v1.0.2 -> v1.0.3 (@wipcomputer/wip-xai-grok)
    ldm-install-wip-xai-x: v1.0.1 -> v1.0.4 (@wipcomputer/wip-xai-x)
```

No more relying on local source paths. No more stale `/tmp/` clones. npm is the source of truth. Closes #55.

## Install lockfile

Only one `ldm install` runs at a time. PID-based lock at `~/.ldm/state/.ldm-install.lock`. Stale locks (dead PID) auto-cleaned. Prevents the process swarm that was hitting 310% CPU when multiple sessions ran install simultaneously. Closes #57.

## Issues closed

- Closes #55
- Closes #57

## 0.4.3 (2026-03-16)

# LDM OS v0.4.3

`ldm install` actually works as an updater now.

## The fix

Before: `ldm install` (bare) only re-copied from saved source paths. Most were dead `/tmp/` clones. If Memory Crystal shipped v0.7.25, you'd never know. The dry-run lied ("18 would refresh" when they were stale copies).

After: `ldm install` checks npm for each extension via catalog.json. Shows real version diffs in dry-run. Installs from GitHub when a newer version exists.

```
  Would update 3 extension(s) from npm:
    memory-crystal: v0.7.24 -> v0.7.25 (@wipcomputer/memory-crystal)
    wip-xai-grok: v1.0.2 -> v1.0.3 (@wipcomputer/wip-xai-grok)
    wip-xai-x: v1.0.3 -> v1.0.4 (@wipcomputer/wip-xai-x)
```

Also includes: /tmp/ registry cleanup (#54), skills TECHNICAL.md merged into universal-installer, README link fixes, co-author fix for deploy-public.sh.

## Issues closed

- Closes #55 (ldm install checks npm for updates)
- Closes #54 (/tmp/ registry cleanup)

## 0.4.2 (2026-03-16)

# LDM OS v0.4.2

Dogfood continues. Doctor hang fixed, bridge renamed, docs completed, git commits on main now blocked globally.

## Fixes

- **Doctor hang** (missing `await` on async function). One character fix. Also adds 5s timeouts to CLI binary detection to prevent zombie processes. Closes #48
- **Boot hook sync.** `ldm install` now updates `~/.ldm/shared/boot/boot-hook.mjs` from the npm package. Sessions, messages, and update surfacing from v0.3.0 were never activating because the deployed boot hook was stale. Closes #49
- **Bridge renamed** from `lesa-bridge` to `wip-bridge`. MCP server name, all log output, CLI headers, docs. Product name, not personal name. Closes #50

## New: Global pre-commit hook

`ldm init` now installs a git pre-commit hook that blocks commits on main/master. Every repo on the machine. Every agent. Git itself refuses the commit before it happens.

```bash
~/.ldm/hooks/pre-commit
git config --global core.hooksPath ~/.ldm/hooks
```

No more agents committing to main by accident. The CC branch guard is a warning layer on top. The git hook is enforcement. Closes #51

## Docs

- Bridge docs added: `docs/bridge/README.md` (protocol comparison chart) + `docs/bridge/TECHNICAL.md` (full original bridge README content)
- All doc READMEs now link to their TECHNICAL.md
- Bridge listed first under "Ships with LDM OS" in main README
- README title: "LDM OS: Learning Dreaming Machines"
- All broken doc links fixed after docs reorg
- Bridge repos renamed to `wip-bridge-deprecated` and `wip-bridge-private-deprecated`

## 0.4.1 (2026-03-15)

# LDM OS v0.4.1

Consolidate Universal Installer into LDM OS. Closes wipcomputer/wip-ai-devops-toolbox#182.

## What changed

The `wip-install` command now ships with LDM OS. The 700-line standalone `install.js` from the DevOps Toolbox is replaced by a thin bootstrap (`lib/bootstrap.mjs`) that delegates to `ldm install`.

Three steps:
1. Check if `ldm` is on PATH
2. If not, `npm install -g @wipcomputer/wip-ldm-os`
3. Delegate to `ldm install`

No standalone fallback code. All install logic lives in `lib/deploy.mjs`.

## Also

- SPEC.md (Universal Interface Spec) moved from toolbox to `docs/universal-installer/SPEC.md`
- `wip-install` added to package.json bin entries

## Issues closed

- Closes wipcomputer/wip-ai-devops-toolbox#182

## 0.4.0 (2026-03-15)

# LDM OS v0.4.0

One dogfood session. Nine releases. Seven bugs found and fixed. One new feature shipped.

## New: ldm stack

Pre-defined tool stacks. Install everything your team needs with one command.

```bash
ldm stack list                    # show available stacks
ldm stack install core            # Memory Crystal, DevOps Toolbox, 1Password, mdview
ldm stack install web             # Playwright, Next.js DevTools, shadcn, Tailwind (MCP)
ldm stack install all             # everything
ldm stack install core --dry-run  # preview first
```

Three stacks ship in catalog.json. Stacks are composable ("all" includes "core" + "web"). The installer checks what's already installed, shows status, only installs what's missing.

This is Layer 1 (local install). Layer 2 (cloud MCP for iOS/web) is specced.

## Bugs fixed (v0.3.2 through v0.3.6)

- CLI self-update warning after install (v0.3.2)
- Stale hook cleanup in `ldm doctor --fix` (v0.3.2)
- /tmp/ paths flagged as stale even when file exists (v0.3.3)
- version.json auto-sync on npm upgrade (v0.3.4)
- CLI install from npm registry instead of /tmp/ symlinks (v0.3.5)
- SKILL.md prompt checks extension updates before summary (v0.3.6)

## Docs reorganized

Every feature now has its own folder with README.md + TECHNICAL.md:
- `docs/universal-installer/`
- `docs/acp/`
- `docs/skills/`
- `docs/recall/`
- `docs/shared-workspace/`
- `docs/system-pulse/`

## 0.3.6 (2026-03-15)

SKILL.md prompt now checks extension updates before presenting summary to user

## 0.3.5 (2026-03-15)

Fix: install CLIs from npm registry instead of /tmp/ symlinks (#37)

## 0.3.4 (2026-03-15)

Fix: auto-sync version.json when CLI version drifts after npm upgrade

## 0.3.3 (2026-03-15)

Fix: detect /tmp/ hook paths as stale even when file exists

## 0.3.2 (2026-03-15)

Fix: CLI version warning after install (#29) + stale hook cleanup in doctor (#30)

## 0.3.1 (2026-03-15)

Fix npm publish: remove prepublishOnly, ship pre-built dist

## 0.3.0 (2026-03-15)

# LDM OS v0.3.0

LDM OS evolves from an installer/boot system into a full agent operating system. Five new core features plus WIP Bridge absorbed as a core module.

## WIP Bridge Absorption

WIP Bridge (wip-bridge-private) is now a core module at `src/bridge/`. Bridge is always installed with LDM OS, not optional. The standalone wip-bridge-private repo is deprecated.

- Bridge source (core.ts, mcp-server.ts, cli.ts) lives in `src/bridge/`
- Built with tsup into `dist/bridge/`
- `lesa` CLI stays as alias in LDM OS bin
- All existing MCP tools preserved (`lesa_*`, `oc_skill_*`)

## Agent Register

Named session tracking. Parker runs multiple CC sessions simultaneously. Now they can discover each other.

- `lib/sessions.mjs` ... register/deregister/list sessions (pure ESM, zero deps)
- File-based at `~/.ldm/sessions/{name}.json` with PID liveness validation
- Boot hook registers on SessionStart
- Stop hook (`src/hooks/stop-hook.mjs`) deregisters on session end
- CLI: `ldm sessions`

## Message Bus

File-based inter-session messaging. One CC session can message another, or broadcast to all.

- `lib/messages.mjs` ... send/read/broadcast/acknowledge (pure ESM, zero deps)
- File-based at `~/.ldm/messages/{uuid}.json`
- Message types: chat, system, update-available
- Boot hook reads pending messages on session start
- CLI: `ldm msg send/list/broadcast`

## Update Checker

Cron job checks npm for newer versions of installed extensions. Surfaces updates in boot output.

- `lib/updates.mjs` ... check npm, write manifest (pure ESM, zero deps)
- Cron job every 6 hours (`src/cron/update-check.mjs`)
- Boot hook surfaces "Updates Available" section
- CLI: `ldm updates`

## ACP Compatibility Docs

Agent Client Protocol (ACP-Client) and Agent Communication Protocol (ACP-Comm) documented at `docs/acp-compatibility.md`. Both Apache 2.0, compatible with MIT + AGPL.

## Init and Doctor Updates

- `ldm init` creates: `sessions/`, `messages/`, `shared/cron/`, `state/`
- `ldm doctor` checks session and message directory health

## Build Pipeline

- `prepublishOnly` script builds bridge TypeScript before npm publish
- `dist/bridge/` ships with the npm package
- `docs/` added to files field

## Unreleased

Bridge absorption. WIP Bridge (wip-bridge-private) moved into LDM OS as core module at src/bridge/. Bridge is now always installed with LDM OS, not optional. Standalone wip-bridge-private deprecated.

## 0.2.14 (2026-03-14)

Add .publish-skill.json. SKILL.md auto-publishes to wip.computer on release. Website was stuck at v0.2.5.

## 0.2.13 (2026-03-14)

Fix: deploy guard.mjs to ~/.ldm/extensions/ before configuring CC hook. Hooks no longer point to /tmp/. Also adds ldm doctor --fix flag.

## 0.2.12 (2026-03-14)

Fix corrupted SKILL.md version string. Fix install prompt URLs to use wip- prefix.

## 0.2.11 (2026-03-14)

Docs overhaul: combined TECHNICAL.md, 7th interface (CC Plugin), license files, marketplace section, link fixes

## 0.2.10 (2026-03-14)

Installer improvements. Closes 6 issues (#5, #6, #7, #8, #19, #32). Semver comparison skips deploy if installed version is already current. Config files (boot-config.json, .env, *.local) preserved during updates. npm package resolution: `ldm install @wipcomputer/memory-crystal` works. OpenClaw naming verification warns on config/directory mismatches. Removed secrets/ from scaffold (1Password is the secrets store).

## 0.2.9 (2026-03-14)

npm bin fix. npm was stripping all bin entries during publish because it rejects .mjs extensions. Renamed bin/ldm.mjs to bin/ldm.js. `npm install -g` now creates the `ldm` command. `npx @wipcomputer/wip-ldm-os init` works. Unblocks zero-dependency bootstrap.

## 0.2.8 (2026-03-14)

Doc link fixes. wip-release and wip-file-guard links in docs pointed to standalone repos that no longer exist. Updated to point to wip-ai-devops-toolbox.

## 0.2.7 (2026-03-14)

Universal Interface docs. Copied REFERENCE.md and SPEC.md from DevOps Toolbox into LDM OS docs. Fixed 404 at github.com/wipcomputer/wip-ldm-os/blob/main/docs/REFERENCE.md. Updated all wip-install references to ldm install.

## 0.2.6 (2026-03-13)

OpenClaw detection + catalog scoping. Added openclaw to CLI binary scanner so it stops showing as "not installed." Added OpenClaw to skill docs with correct link to github.com/openclaw/openclaw. Updated Memory Crystal npm scope to @wipcomputer/memory-crystal.

## 0.2.5 (2026-03-13)

Catalog matching + skill descriptions. Added registryMatches and cliMatches arrays to catalog.json so the installer recognizes extensions under different names. Simplified dry-run output from 4 categories to one flat "Installed" list. Replaced "closed beta" with "not yet public" and wrote real descriptions for Mirror Test, Weekly Tuning, Private Mode, Root Key.

## 0.2.4 (2026-03-13)

SKILL.md cleanup. Removed secrets/ directory description (1Password is the secrets store, not a filesystem directory). Simplified directory descriptions. Discovered during dogfood testing when the AI told users about "encryption keys."

## 0.2.3 (2026-03-13)

System state awareness. New lib/state.mjs scans MCP servers, extension directories, and CLI binaries to build a real picture of what's installed. Reconciliation engine compares registry vs actual system state. New lib/safe.mjs: trash mechanism (old versions go to ~/.ldm/_trash/, never deleted) and revert manifests.

## 0.2.2 (2026-03-13)

Delegation layer. Registry auto-detection in dry-run. ai/ folder reorg. SKILL.md with full catalog. deploy-public.sh safety after a bad deploy wiped ai/ from private repo. Delegation plan for crystal init and wip-install to detect ldm on PATH.

## 0.2.1 (2026-03-13)

Public launch prep. SKILL.md, catalog.json, interactive picker, catalog-based install, public-facing README rewrite, TECHNICAL.md, docs/ folder, wip-ldm-os bin alias for npx.

## 0.1.1 (2026-03-12)

Boot Sequence. SessionStart hook reads identity files on every CC session start. Scaffold creates ~/.ldm/ structure. Installer detects and deploys boot hook. Architecture docs: Souls vs Agents, identity model, enterprise agents concept.
