# Changelog


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
