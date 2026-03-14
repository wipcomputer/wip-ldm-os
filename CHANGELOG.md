# Changelog


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
