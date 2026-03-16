###### WIP Computer
# Universal Interface ... Technical Reference

Every tool is a sensor, an actuator, or both. Every tool should be accessible through multiple interfaces. We call this the Universal Interface.

## Sensors and Actuators

**Sensors** convert state into data:
- Search the web (wip-grok search_web)
- Search X/Twitter (wip-grok search_x, wip-x search_recent)
- Fetch a post (wip-x fetch_post)
- Read bookmarks (wip-x get_bookmarks)
- Check system health (wip-healthcheck)

**Actuators** convert intent into action:
- Generate an image (wip-grok generate_image)
- Post a tweet (wip-x post_tweet)
- Guard a file from edits (wip-file-guard)
- Generate a video (wip-grok generate_video)

## The Seven Interfaces

Agents don't all speak the same language. Some run shell commands. Some import modules. Some talk MCP. Some read markdown instructions.

So every tool should expose multiple interfaces into the same core logic:

| Interface | What | Who uses it |
|-----------|------|-------------|
| **CLI** | Shell command | Humans, any agent with bash |
| **Module** | ES import | Other tools, scripts |
| **MCP Server** | JSON-RPC over stdio | Claude Code, Cursor, any MCP client |
| **OpenClaw Plugin** | Lifecycle hooks + tools | OpenClaw agents |
| **Skill** | Markdown instructions (SKILL.md) | Any agent that reads files |
| **Claude Code Hook** | PreToolUse/Stop events | Claude Code |
| **Claude Code Plugin** | Distributable package (skills, agents, hooks, MCP, LSP) | Claude Code marketplace |

Not every tool needs all seven. Build what makes sense. But the more interfaces you expose, the more agents can use your tool.

### 1. CLI

A shell command. The most universal interface. If it has a terminal, it works.

**Convention:** `package.json` with a `bin` field.

**Detection:** `pkg.bin` exists.

**Install:** `npm install -g .` or `npm link`.

```json
{
  "bin": {
    "wip-grok": "./cli.mjs"
  }
}
```

### 2. Module

An importable ES module. The programmatic interface. Other tools compose with it.

**Convention:** `package.json` with `main` or `exports` field. File is `core.mjs` by convention.

**Detection:** `pkg.main` or `pkg.exports` exists.

**Install:** `npm install <package>` or import directly from path.

```json
{
  "type": "module",
  "main": "core.mjs",
  "exports": {
    ".": "./core.mjs",
    "./cli": "./cli.mjs"
  }
}
```

### 3. MCP Server

A JSON-RPC server implementing the Model Context Protocol. Any MCP-compatible agent can use it.

**Convention:** `mcp-server.mjs` (or `.js`, `.ts`) at the repo root. Uses `@modelcontextprotocol/sdk`.

**Detection:** One of `mcp-server.mjs`, `mcp-server.js`, `mcp-server.ts`, `dist/mcp-server.js` exists.

**Install:** Add to `.mcp.json`:

```json
{
  "tool-name": {
    "command": "node",
    "args": ["/path/to/mcp-server.mjs"]
  }
}
```

### 4. OpenClaw Plugin

A plugin for OpenClaw agents. Lifecycle hooks, tool registration, settings.

**Convention:** `openclaw.plugin.json` at the repo root.

**Detection:** `openclaw.plugin.json` exists.

**Install:** Copy to `~/.openclaw/extensions/<name>/`, run `npm install --omit=dev`.

### 5. Skill (SKILL.md)

A markdown file that teaches agents when and how to use the tool. The instruction interface.

**Convention:** `SKILL.md` at the repo root. YAML frontmatter with name, version, description, metadata.

**Detection:** `SKILL.md` exists.

**Install:** Referenced by path. Agents read it when they need the tool.

```yaml
---
name: wip-grok
version: 1.0.0
description: xAI Grok API. Search the web, search X, generate images.
metadata:
  category: search,media
  capabilities:
    - web-search
    - image-generation
---
```

### 6. Claude Code Hook

A hook that runs during Claude Code's tool lifecycle (PreToolUse, Stop, etc.).

**Convention:** `guard.mjs` at repo root, or `claudeCode.hook` in `package.json`.

**Detection:** `guard.mjs` exists, or `pkg.claudeCode.hook` is defined.

**Install:** Added to `~/.claude/settings.json` under `hooks`.

```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "Edit|Write",
      "hooks": [{
        "type": "command",
        "command": "node /path/to/guard.mjs",
        "timeout": 5
      }]
    }]
  }
}
```

### 7. Claude Code Plugin

A distributable plugin for Claude Code. Bundles skills, agents, hooks, MCP servers, and LSP servers into one installable package. Shareable via marketplaces.

**Convention:** `.claude-plugin/plugin.json` at the repo root.

**Detection:** `.claude-plugin/plugin.json` exists.

**Install:** Registered with Claude Code via `/plugin install` or marketplace.

```
your-plugin/
  .claude-plugin/
    plugin.json          manifest (name, version, description)
  skills/                SKILL.md files
  agents/                subagent definitions
  hooks/
    hooks.json           event handlers
  .mcp.json              MCP server configs
  .lsp.json              LSP server configs
```

```json
{
  "name": "your-plugin",
  "version": "1.0.0",
  "description": "What it does",
  "author": { "name": "Your Name" }
}
```

## How to Build It

The architecture is simple. Four files:

```
your-tool/
  core.mjs            <- pure logic, zero deps if possible
  cli.mjs             <- thin CLI wrapper
  mcp-server.mjs      <- MCP server wrapping core as tools
  SKILL.md            <- when/how to use it, for agents
```

`core.mjs` does the work. Everything else is a thin wrapper. CLI parses argv and calls core. MCP server maps tools to core functions. SKILL.md teaches agents when to call what.

This means one codebase, one set of tests, multiple interfaces.

## Install Prompt Template

Every product gets an install prompt. Paste it into any AI. The AI reads the spec, explains it, checks what's installed, and walks you through a dry run.

```
Read wip.computer/install/{URL}

Then explain:
1. What is {name of product}?
2. What does it install on my system?
3. What changes for us? (this AI)
4. What changes across all my AIs?

Check if {name of product} is already installed.

If it is, show me what I have and what's new.

Then ask:
- Do you have questions?
- Want to see a dry run?

If I say yes, run: {product-init} init --dry-run

Show me exactly what will change. Don't install anything until I say "install".
```

## The `ai/` Folder

Every repo should have an `ai/` folder. This is where agents and humans collaborate on the project ... plans, todos, dev updates, research notes, conversations.

```
ai/
  plan/              architecture plans, roadmaps
  dev-updates/       what was built, session logs
  todos/
    PUNCHLIST.md     blockers to ship
    inboxes/         per-agent action items
  notes/             research, references, raw conversation logs
```

The `ai/` folder is the development process. It is not part of the published product.

**Public/private split:** If a repo is public, the `ai/` folder should not ship. The recommended pattern is to maintain a private working repo (with `ai/`) and a public repo (everything except `ai/`). The public repo has everything an LLM or human needs to understand and use the tool. The `ai/` folder is operational context for the team building it.

## Catalog

Skills are defined in `catalog.json` at the LDM OS root. Each entry has:

```json
{
  "id": "memory-crystal",
  "name": "Memory Crystal",
  "description": "Persistent memory for your AI.",
  "npm": "@wipcomputer/memory-crystal",
  "repo": "wipcomputer/memory-crystal",
  "registryMatches": ["memory-crystal"],
  "cliMatches": ["crystal"],
  "recommended": true,
  "status": "stable"
}
```

## Stacks

Stacks group skills for team installs. Defined in `catalog.json`:

```json
{
  "stacks": {
    "core": {
      "name": "WIP Core",
      "components": ["memory-crystal", "wip-ai-devops-toolbox", "wip-1password", "wip-markdown-viewer"],
      "mcpServers": []
    },
    "web": {
      "name": "Web Development",
      "components": [],
      "mcpServers": [
        { "name": "playwright", "command": "npx", "args": ["-y", "@playwright/mcp@latest"] }
      ]
    }
  }
}
```

Stacks are composable via the `includes` field.

## The Installer

`ldm install` scans any repo, detects which interfaces exist, and installs them all. One command.

```bash
ldm install wipcomputer/wip-grok      # from GitHub
ldm install /path/to/repo             # from a local path
ldm install --dry-run                  # detect only
ldm install                            # update all
```

### What It Detects

| Pattern | Interface | Install action |
|---------|-----------|---------------|
| `package.json` with `bin` | CLI | `npm install -g` |
| `main` or `exports` in `package.json` | Module | Reports import path |
| `mcp-server.mjs` | MCP | Prints `.mcp.json` config |
| `openclaw.plugin.json` | OpenClaw | Copies to `~/.openclaw/extensions/` |
| `SKILL.md` | Skill | Reports path |
| `guard.mjs` or `claudeCode.hook` | CC Hook | Adds to `~/.claude/settings.json` |
| `.claude-plugin/plugin.json` | CC Plugin | Registers with Claude Code marketplace |

## Examples

| Tool | Type | Interfaces | What it does |
|------|------|------------|-------------|
| [wip-grok](https://github.com/wipcomputer/wip-grok) | Sensor + Actuator | CLI + Module + MCP + Skill | xAI Grok API: search web/X, generate images/video |
| [wip-x](https://github.com/wipcomputer/wip-x) | Sensor + Actuator | CLI + Module + MCP + Skill | X Platform API: read/write tweets, bookmarks |
| [wip-file-guard](https://github.com/wipcomputer/wip-ai-devops-toolbox/tree/main/tools/wip-file-guard) | Actuator | CLI + OpenClaw + CC Hook | Protect files from AI edits |
| [wip-healthcheck](https://github.com/wipcomputer/wip-healthcheck) | Sensor | CLI + Module | System health monitoring |
| [wip-markdown-viewer](https://github.com/wipcomputer/wip-markdown-viewer) | Actuator | CLI + Module | Live markdown viewer |

## Supported Tools

Works with any AI agent or coding tool that can run shell commands:

| Tool | How |
|------|-----|
| Claude Code | CLI via bash, hooks via settings.json, MCP via .mcp.json, plugins via marketplace |
| OpenAI Codex CLI | CLI via bash, skills via AGENTS.md |
| Cursor | CLI via terminal, MCP via config |
| Windsurf | CLI via terminal, MCP via config |
| OpenClaw | Plugins, skills, MCP |
| Any agent | CLI works everywhere. If it has a shell, it works. |
