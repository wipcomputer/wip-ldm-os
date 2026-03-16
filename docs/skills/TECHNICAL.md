# Skills ... Technical Reference

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

## Interface Detection

`ldm install` auto-detects which interfaces a repo supports:

| Pattern | Interface | Install Action |
|---------|-----------|---------------|
| `package.json` with `bin` | CLI | `npm install -g` from registry |
| `main` or `exports` | Module | Reports import path |
| `mcp-server.mjs` | MCP | `claude mcp add --scope user` |
| `openclaw.plugin.json` | OpenClaw Plugin | Deploy to `~/.ldm/extensions/` + `~/.openclaw/extensions/` |
| `SKILL.md` | Skill | Deploy to `~/.openclaw/skills/` |
| `guard.mjs` or `claudeCode.hook` | CC Hook | Add to `~/.claude/settings.json` |
| `.claude-plugin/plugin.json` | CC Plugin | Register with marketplace |

## Key Files

| File | What |
|------|------|
| `catalog.json` | Component + stack definitions |
| `lib/detect.mjs` | Interface detection engine |
| `lib/deploy.mjs` | Deployment engine |
| `bin/ldm.js` | `ldm stack` and `ldm install` commands |
