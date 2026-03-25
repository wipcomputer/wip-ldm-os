---
name: wip-ldm-os
description: LDM OS ... shared infrastructure for AI agents. Identity, memory, ownership, collaboration, compatibility, payments. One system across all your AIs.
license: MIT
interface: [cli, skill]
metadata:
  display-name: "LDM OS"
  version: "0.4.45"
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

## Step 1: Check if LDM OS is already installed

**Always check first. Never assume.**

```bash
which ldm && ldm --version 2>/dev/null
```

This determines everything. Branch on the result:

---

## If LDM OS IS installed (ldm command exists)

**Do NOT explain what LDM OS is.** The user already knows. Show them what they have and what's new.

### Run status

```bash
ldm status 2>&1
```

`ldm status` checks the CLI and all extensions against npm. It shows:
- CLI version and whether a newer version exists
- Extension count and how many have updates available
- Specific version diffs for each outdated extension

**Use the output of `ldm status` as your summary.** Do not say "up to date" if `ldm status` shows updates available.

### Present what changed

Show a table of components with updates:

```
| Component | Current | Available | Package |
|-----------|---------|-----------|---------|
| LDM OS CLI | v0.4.41 | v0.4.44 | @wipcomputer/wip-ldm-os |
| wip-branch-guard | v1.9.44 | v1.9.51 | @wipcomputer/wip-branch-guard |
```

**Always show a table.** Never collapse updates into a paragraph or bullet list. Every update gets its own row.

### Show what changed per component

For each component with an update, fetch the release notes and summarize what actually changed:

```bash
# For each component with an update:
gh release list --repo wipcomputer/<repo-name> --limit 5 --json tagName,name --jq '.[]'
# Then for each release between current and available:
gh release view <tag> --repo wipcomputer/<repo-name> --json body --jq .body
```

Show 2-3 bullet points per component summarizing the release notes. The user needs to know WHAT changed, not just THAT a version number moved.

Then answer:
1. **What changed for this AI?** New rules, boot config changes, CLAUDE.md updates.
2. **What changed across all my AIs?** Shared rules, shared prompts, new extensions.

### Ask

- Do you have questions?
- Want to see a dry run?

If they say yes:
```bash
ldm install --dry-run
```

**Don't install anything until the user says "install".**

When they say install:
```bash
npm install -g @wipcomputer/wip-ldm-os@latest   # CLI update
ldm install       # update all registered extensions
ldm doctor        # verify everything works
```

Updates deploy new code without touching data. crystal.db, agent files, secrets, and state are never overwritten.

---

## If LDM OS is NOT installed (ldm command not found)

Now explain. The user is new.

### What is LDM OS?

You use Claude Code, GPT, OpenClaw, others. They don't share memory. They don't know each other. They don't know how to work together.

LDM OS is the shared infrastructure layer. Install it once and every AI you use gets:

- **Identity** ... each AI gets its own behavior, personality, and skills
- **Memory** ... shared memory across all your AIs, secure, sovereign, yours to take anywhere
- **Ownership** ... every interaction, every memory, across every AI you use is yours, portable, encrypted, never locked in
- **Collaboration** ... your AIs communicate, share tools, and work together
- **Compatibility** ... any skill, plugin, or tool works with all your AIs. Install once, use everywhere.
- **Payments** ... your AI hits a paywall, you approve it with Face ID, Apple Pay for your AI

### What does it install?

- `~/.ldm/extensions/` ... where tools and plugins live
- `~/.ldm/agents/` ... each AI gets its own identity, personality, and memory here
- `~/.ldm/memory/` ... shared memory across all your AIs
- `~/.ldm/state/` ... configuration and sync state
- `~/.ldm/shared/rules/` ... dev conventions deployed to every AI harness

### What changes for this AI?

- Boot sequence reads from `~/.ldm/agents/` (identity, memory, daily logs)
- Rules deployed to `~/.claude/rules/` (git conventions, security, release pipeline)
- Extensions like Memory Crystal, wip-release are managed centrally
- Stop hooks write to crystal and daily logs after every turn

### What changes across all my AIs?

- Shared memory (crystal.db) accessible to every AI
- Shared rules (same conventions everywhere)
- Shared extensions (install once, every AI sees it)
- Agent identity (each AI is its own entity with its own prefix)

### Ask

- Do you have questions?
- Want to see a dry run?

If they say yes, install the CLI first:
```bash
npm install -g @wipcomputer/wip-ldm-os
```

If npm/node is not installed, the user needs Node.js 18+ from https://nodejs.org first.

Then dry run:
```bash
ldm init --dry-run
```

**Don't install anything until the user says "install".**

When they say install:
```bash
ldm init
```

### Install Skills

LDM OS ships with a skill catalog. Show the user what's available:

| Skill | What it is | Status |
|-------|-----------|--------|
| **Memory Crystal** (recommended) | Persistent memory. Search, capture, consolidation. | Stable |
| **AI DevOps Toolbox** | Release, deploy, license, repo management. | Stable |
| **1Password** | 1Password secrets for AI agents. | Stable |
| **Markdown Viewer** | Live markdown viewer for AI pair-editing. | Stable |
| **xAI Grok** | xAI Grok API. Search the web, search X, generate images. | Stable |
| **X Platform** | X Platform API. Read posts, search tweets, post, upload media. | Stable |
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

### Verify

```bash
ldm doctor
```

---

## Operating Rules (both paths)

**Always dry-run first.** Before installing or making changes, run with `--dry-run` so the user can see exactly what will happen. Only proceed when the user explicitly says to.

**Never touch sacred data.** The installer never overwrites: crystal.db, agent data, secrets, state files. Code gets updated. Data stays.

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
