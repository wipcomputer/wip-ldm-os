---
name: wip-ldm-os
description: LDM OS ... shared infrastructure for AI agents. Identity, memory, ownership, collaboration, compatibility, payments. One system across all your AIs.
license: MIT
interface: [cli, skill]
metadata:
  display-name: "LDM OS"
  version: "0.4.39"
  homepage: "https://github.com/wipcomputer/wip-ldm-os"
  author: "Parker Todd Brooks"
  category: infrastructure
  capabilities:
    - extension-install
    - interface-detection
    - agent-identity
    - extension-registry
    - health-check
  requires:
    bins: [git, npm, node]
  openclaw:
    requires:
      bins: [git, npm, node]
    install:
      - id: node
        kind: node
        package: "@wipcomputer/wip-ldm-os"
        bins: [ldm]
        label: "Install LDM OS via npm"
    emoji: "🧠"
compatibility: Requires git, npm, node. Node.js 18+.
---

# LDM OS

## CRITICAL: Bootstrap (read this first)

If `ldm` is not installed, run this BEFORE anything else:

```bash
npm install -g @wipcomputer/wip-ldm-os
```

Then check: `ldm --version`. If that works, proceed with `ldm install --dry-run`.

If npm/node is not installed, the user needs Node.js 18+ from https://nodejs.org first.

---

You use Claude Code, GPT, OpenClaw, others. They don't share memory. They don't know each other. They don't know how to work together.

LDM OS is the shared infrastructure layer. Install it once and every AI you use gets:

- **Identity** ... each AI gets its own behavior, personality, and skills
- **Memory** ... shared memory across all your AIs, secure, sovereign, yours to take anywhere
- **Ownership** ... every interaction, every memory, across every AI you use is yours, portable, encrypted, never locked in
- **Collaboration** ... your AIs communicate, share tools, and work together
- **Compatibility** ... any skill, plugin, or tool works with all your AIs. Install once, use everywhere.
- **Payments** ... your AI hits a paywall, you approve it with Face ID, Apple Pay for your AI

## Platform Compatibility

| Interface | Requires | Examples |
|-----------|----------|----------|
| CLI | Shell access (run bash/node commands) | `ldm init`, `ldm install`, `ldm doctor` |
| Skill | SKILL.md file (works in Claude Code and OpenClaw) | You're reading it right now |

**Built and tested on:**
- **Claude Code CLI** ... full support (shell, CLI)
- **OpenClaw** ... full support (shell, CLI)

## Operating Rules

**Check before you run.** Before running any `ldm` command, check if it's installed: `which ldm`. If not found, tell the user: "I can run `ldm install --dry-run` to show you exactly what will change, but first I need to install the LDM OS CLI. That's one npm package (`npm install -g @wipcomputer/wip-ldm-os`) that gives us the `ldm` command. It doesn't install anything else until you say so." Never show the user a "command not found" error you already knew would happen.

**Always dry-run first.** Before installing or making changes, run with `--dry-run` so the user can see exactly what will happen. Only proceed when the user explicitly says to.

**Never touch sacred data.** The installer never overwrites: crystal.db, agent data, secrets, state files. Code gets updated. Data stays.

## Install

### Step 1: Install LDM OS

```bash
npm install -g @wipcomputer/wip-ldm-os
ldm init --dry-run
```

Show the user the dry run output. Explain what it creates:
- `~/.ldm/extensions/` ... where tools and plugins live
- `~/.ldm/agents/` ... each AI gets its own identity, personality, and memory here
- `~/.ldm/memory/` ... shared memory across all your AIs
- `~/.ldm/state/` ... configuration and sync state

When the user approves:
```bash
ldm init
```

### Step 2: Install Skills

LDM OS ships with a skill catalog. Show the user what's available:

| Skill | What it is | Status |
|-------|-----------|--------|
| **Memory Crystal** (recommended) | Persistent memory. Search, capture, consolidation. | Stable |
| **AI DevOps Toolbox** | Release, deploy, license, repo management. | Stable |
| **1Password** | 1Password secrets for AI agents. | Stable |
| **Markdown Viewer** | Live markdown viewer for AI pair-editing. | Stable |
| **xAI Grok** | xAI Grok API. Search the web, search X, generate images. | Stable |
| **X Platform** | X Platform API. Read posts, search tweets, post, upload media. | Stable |
| **OpenClaw** | AI agent platform. Run AI agents 24/7 with identity, memory, and tool access. | Stable |
| **Dream Weaver Protocol** | Memory consolidation protocol for AI agents. | Stable |
| **Bridge** | Cross-platform agent bridge. Claude Code to OpenClaw communication. | Stable |

To install a skill:
```bash
ldm install wipcomputer/memory-crystal --dry-run
```

Show the dry run. When approved:
```bash
ldm install wipcomputer/memory-crystal
```

The installer detects what a repo supports (CLI, MCP Server, OpenClaw Plugin, Skill, CC Hook, Module) and deploys each interface to the right location automatically.

**Note:** Skills installed before LDM OS (via `crystal init`, `wip-install`, or manual setup) may not appear in the registry. Run `ldm install <org/repo>` to re-register them.

### Step 3: Verify

```bash
ldm doctor
```

This checks: LDM root exists, version.json valid, registry intact, all extensions deployed, hooks configured, MCP servers registered.

## Commands

| Command | What it does |
|---------|-------------|
| `ldm init` | Scaffold `~/.ldm/` and write version.json |
| `ldm install <org/repo>` | Clone, detect interfaces, deploy, register |
| `ldm install /path/to/repo` | Install from local path |
| `ldm install` | Update all registered extensions |
| `ldm doctor` | Check health of all extensions |
| `ldm status` | Show version and extension list |
| `ldm --version` | Show version |

All commands support `--dry-run` (preview changes) and `--json` (machine-readable output).

## Interface Detection

When you run `ldm install`, it automatically detects what a repo supports:

| Interface | How it's detected | Where it deploys |
|-----------|------------------|-----------------|
| CLI | `package.json` has `bin` entries | `npm install -g` |
| MCP Server | Has `mcp-server.mjs` or `mcp-server.js` | `claude mcp add --scope user` |
| OpenClaw Plugin | Has `openclaw.plugin.json` | `~/.ldm/extensions/` + `~/.openclaw/extensions/` |
| Skill | Has `SKILL.md` or `skills/` directory | `~/.openclaw/skills/` |
| CC Hook | Has `guard.mjs` or `claudeCode.hook` in package.json | `~/.claude/settings.json` |
| Module | Has `main` or `exports` in package.json | Importable via `node_modules` |

No manual configuration needed. Point it at a repo and it figures out the rest.

## Update

If LDM OS is already installed, run `ldm status` BEFORE presenting the summary to the user:

```bash
ldm status 2>&1
```

`ldm status` checks both the CLI and all extensions against npm. It shows:
- CLI version and whether a newer version exists
- Extension count and how many have updates available
- Specific version diffs for each outdated extension

**Use the output of `ldm status` as your summary.** Do not say "up to date" if `ldm status` shows updates available. Do not make your own summary without running `ldm status` first.

When the user asks for a dry run or wants to update, run `ldm install --dry-run` and display the results as a **table**:

```
| Extension | Current | Available | Package |
|-----------|---------|-----------|---------|
| wip-branch-guard | v1.9.30 | v1.9.36 | @wipcomputer/wip-branch-guard |
| memory-crystal | v0.7.24 | v0.7.26 | @wipcomputer/memory-crystal |
```

**Always show a table.** Never collapse updates into a paragraph or bullet list. Every update gets its own row. Show ALL updates, not a summary.

When the user says "install":
```bash
ldm install       # update all registered extensions
ldm doctor        # verify everything works
```

Updates deploy new code without touching data. crystal.db, agent files, secrets, and state are never overwritten.

## Part of LDM OS

LDM OS is the runtime. Skills plug into it:

- **Memory Crystal** ... `wipcomputer/memory-crystal`
- **AI DevOps Toolbox** ... `wipcomputer/wip-ai-devops-toolbox`
- **1Password** ... `wipcomputer/wip-1password`
- **Markdown Viewer** ... `wipcomputer/wip-markdown-viewer`
- **xAI Grok** ... `wipcomputer/wip-xai-grok`
- **X Platform** ... `wipcomputer/wip-xai-x`
- **OpenClaw** ... `openclaw/openclaw`
- **Dream Weaver Protocol** ... `wipcomputer/dream-weaver-protocol`
- **Bridge** ... `wipcomputer/wip-bridge`

Run `ldm install` anytime to add more skills.

## Claude Code Marketplace

If you're running Claude Code, you can browse and install all LDM OS plugins available from WIP Computer:

```
/plugin marketplace add wipcomputer/claude-plugins
```

This adds LDM OS skills to Claude Code's Discover tab alongside Anthropic's official plugins. Install any skill with `/plugin install`.
