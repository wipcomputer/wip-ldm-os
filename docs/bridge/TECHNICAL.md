# Bridge ... Technical Reference

## Architecture

```
Claude Code CLI (cc-mini, cc-air, or any CC session)
  |
  |-- On boot --> registerSession() --> ~/.ldm/sessions/{name}.json (session discovery)
  |
  |-- MCP stdio --> wip-bridge MCP server (single process)
  |                   |
  |                   |-- lesa_send_message --> HTTP POST localhost:18789 (OpenClaw gateway)
  |                   |                          |
  |                   |                          v
  |                   |                        Lesa's agent pipeline
  |                   |                          |
  |                   |                          v
  |                   |                        Response returned
  |                   |
  |                   |-- lesa_check_inbox --> HTTP GET localhost:18790 (Bridge inbox)
  |                   |
  |                   |-- lesa_conversation_search --> SQLite (context-embeddings.sqlite)
  |                   |
  |                   |-- lesa_memory_search --> filesystem (workspace/*.md)
  |                   |
  |                   |-- oc_skill_* --> exec scripts in ~/.openclaw/extensions/*/skills/

CC <-> CC (multi-session):
  CC session A --> registerSession() --> ~/.ldm/sessions/a.json
  CC session B --> registerSession() --> ~/.ldm/sessions/b.json
  CC session A --> listSessions()    --> discovers session B (agent ID, PID, cwd)
  CC session B --> listSessions()    --> discovers session A
  Communication via file-based message bus at ~/.ldm/sessions/
```

## MCP Tools

| Tool | What | Transport |
|------|------|-----------|
| `lesa_send_message` | Send message to OpenClaw agent | HTTP POST to gateway (localhost:18789) |
| `lesa_check_inbox` | Check for pending messages from agent | In-memory queue (drained on read) |
| `lesa_conversation_search` | Semantic search over conversation history | SQLite + OpenAI embeddings |
| `lesa_memory_search` | Keyword search across workspace .md files | Filesystem scan |
| `lesa_read_workspace` | Read a specific workspace file | Filesystem |
| `oc_skill_*` | Execute OpenClaw skill scripts | child_process exec |
| `oc_skills_list` | List all available OpenClaw skills | Filesystem scan |

## Config Resolution

Bridge resolves config in two steps:

1. **LDM OS path** (`~/.ldm/config.json`): checks for `openclawDir`, `workspaceDir`, `dbPath`
2. **Legacy path** (`OPENCLAW_DIR` env or `~/.openclaw`): fallback

Both return the same `BridgeConfig` shape: `openclawDir`, `workspaceDir`, `dbPath`, `inboxPort`, `embeddingModel`, `embeddingDimensions`.

## Gateway Authentication

Bridge reads the gateway auth token from `~/.openclaw/openclaw.json` (`gateway.auth.token`). Every HTTP request to the gateway includes `Authorization: Bearer <token>`.

## Conversation Search

Two modes:
1. **Vector search** (if OpenAI API key available): embeds query, computes cosine similarity against all conversation chunks, applies recency weighting (exponential decay, half-life ~50 days)
2. **Text search** (fallback): SQL LIKE query against chunk text

The API key is resolved from: environment variable > 1Password via service account token.

## Inbox Server

Bridge starts a localhost-only HTTP server on port 18790:
- `POST /message`: push a message (from OpenClaw agent)
- `GET /status`: check pending count

Messages are held in memory. `lesa_check_inbox` drains the queue.

## Session Discovery

On boot, Recall registers the session via `registerSession()` from `lib/sessions.mjs`. Each session writes a JSON file to `~/.ldm/sessions/{name}.json` containing:

- `name` — session identifier
- `agentId` — agent identity (e.g. `cc-mini`, `cc-air`)
- `pid` — process ID (used for liveness checks)
- `startTime` — ISO timestamp
- `cwd` — working directory

`listSessions()` reads all session files, validates PID liveness (signal 0 probe), and auto-cleans stale entries. Filter by `agentId` to find specific agents. `sessionCount()` returns a quick count of live sessions.

CLI: `ldm sessions` lists all active sessions.

This enables CC-to-CC awareness without a broker daemon. Any session can discover any other session on the machine.

## Key Files

| File | What |
|------|------|
| `src/bridge/core.ts` | Pure logic: config, messaging, search, skills |
| `src/bridge/mcp-server.ts` | MCP server: tool registration, inbox HTTP server |
| `src/bridge/cli.ts` | CLI wrapper (`lesa` command) |
| `lib/sessions.mjs` | Session registration, discovery, PID liveness |
| `dist/bridge/` | Compiled output (ships with npm package) |

## Node Communication (Future)

Bridge currently works localhost only (Core). For Node -> Core communication:
- Phase 7 (Cloud Relay) handles messaging via encrypted Cloudflare R2 dead drops
- Search, workspace read, and skill execution from a Node are NOT yet covered
- Two proposed solutions: proxy pattern (Node sends requests through relay) and sync pattern (replicate crystal.db to Node)

See `ai/products/plans-prds/current/ldm-stack-spec.md` for the full platform matrix.

## CLI Usage

```bash
lesa send "What are you working on?"     # Message the OpenClaw agent
lesa search "API key resolution"          # Semantic search (recency-weighted)
lesa memory "compaction"                  # Keyword search across workspace files
lesa read MEMORY.md                       # Read a workspace file
lesa read memory/2026-02-10.md            # Read a daily log
lesa status                               # Show bridge configuration
lesa diagnose                             # Check gateway, inbox, DB, skills health
```

## Skill Bridge

On startup, Bridge scans OpenClaw's skill directories and exposes them as MCP tools. Claude Code gets the same skills the OpenClaw agent has.

1. Scans `extensions/*/node_modules/openclaw/skills/` (built-in) and `extensions/*/skills/` (custom)
2. Parses each `SKILL.md` frontmatter for name, description, requirements
3. Skills with a `scripts/` folder get registered as executable `oc_skill_{name}` tools
4. All skills show up in `oc_skills_list`

Skills that need API keys get them from the environment. The op-secrets plugin sets these from 1Password.

## Inbox Watcher (Auto-Relay)

Polls the inbox endpoint and auto-injects messages into a running Claude Code tmux session.

```bash
bash scripts/watch.sh                    # Alert mode (notification only)
bash scripts/watch.sh --auto claude:0.0  # Auto-inject into tmux pane
```

| Setting | Default | Description |
|---------|---------|-------------|
| `POLL_INTERVAL` | `5` | Seconds between inbox checks |
| `COOLDOWN` | `30` | Minimum seconds between alerts |
| `INBOX_URL` | `http://127.0.0.1:18790/status` | Inbox status endpoint |

## OpenClaw Skills (Lesa -> CC)

Two skills shipped with Bridge for the reverse direction:

| Skill | What |
|-------|------|
| `claude-code` | Invoke Claude Code CLI for coding tasks (`claude -p`) |
| `send-to-claude-code` | Push messages into CC's live inbox (POST localhost:18790) |

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OPENCLAW_DIR` | Yes | `~/.openclaw` | Path to OpenClaw installation |
| `OPENAI_API_KEY` | For semantic search | Resolved from 1Password | OpenAI API key for embeddings |
| `LESA_BRIDGE_INBOX_PORT` | No | `18790` | Inbox HTTP server port |

## Ports

| Port | Service | Bound to |
|------|---------|----------|
| 18789 | OpenClaw gateway | localhost (managed by OpenClaw) |
| 18790 | Bridge inbox | localhost (managed by Bridge) |

## Requirements

- OpenClaw running with gateway enabled
- `gateway.auth.token` set in `openclaw.json`
- `gateway.http.endpoints.chatCompletions.enabled: true`
- OpenAI API key for semantic search (falls back to text search without it)
