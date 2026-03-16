// wip-bridge/mcp-server.ts: MCP server wrapping core.
// Thin layer: registers tools, starts inbox HTTP server, connects transport.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import {
  resolveConfig,
  sendMessage,
  drainInbox,
  pushInbox,
  inboxCount,
  searchConversations,
  searchWorkspace,
  readWorkspaceFile,
  discoverSkills,
  executeSkillScript,
  type BridgeConfig,
  type InboxMessage,
  type SkillInfo,
} from "./core.js";

// ── Config ───────────────────────────────────────────────────────────

const config = resolveConfig();

const METRICS_DIR = join(process.env.HOME || '/Users/lesa', '.openclaw', 'memory');
const METRICS_PATH = join(METRICS_DIR, 'search-metrics.jsonl');

function logSearchMetric(tool: string, query: string, resultCount: number) {
  try {
    mkdirSync(METRICS_DIR, { recursive: true });
    const entry = JSON.stringify({
      ts: new Date().toISOString(),
      tool,
      query,
      results: resultCount,
    });
    appendFileSync(METRICS_PATH, entry + '\n');
  } catch {}
}

// ── Inbox HTTP server ────────────────────────────────────────────────

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

function startInboxServer(cfg: BridgeConfig): void {
  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const remoteAddr = req.socket.remoteAddress;
    if (remoteAddr !== "127.0.0.1" && remoteAddr !== "::1" && remoteAddr !== "::ffff:127.0.0.1") {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "localhost only" }));
      return;
    }

    if (req.method === "POST" && req.url === "/message") {
      try {
        const body = JSON.parse(await readBody(req));
        const msg: InboxMessage = {
          from: body.from || "agent",
          message: body.message,
          timestamp: new Date().toISOString(),
        };
        const queued = pushInbox(msg);
        console.error(`wip-bridge inbox: message from ${msg.from}`);

        try {
          server.sendLoggingMessage({
            level: "info",
            logger: "wip-bridge",
            data: `[OpenClaw → Claude Code] ${msg.from}: ${msg.message}`,
          });
        } catch {}

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, queued }));
      } catch (err: any) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (req.method === "GET" && req.url === "/status") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, pending: inboxCount() }));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });

  httpServer.listen(cfg.inboxPort, "127.0.0.1", () => {
    console.error(`wip-bridge inbox listening on 127.0.0.1:${cfg.inboxPort}`);
  });

  httpServer.on("error", (err: Error) => {
    console.error(`wip-bridge inbox server error: ${err.message}`);
  });
}

// ── MCP Server ───────────────────────────────────────────────────────

const server = new McpServer({
  name: "wip-bridge",
  version: "0.3.0",
});

// Tool 1: Semantic search over conversation history
server.registerTool(
  "lesa_conversation_search",
  {
    description:
      "Search embedded conversation history. Returns semantically similar excerpts " +
      "from past conversations. Use this to find what was discussed about a topic, " +
      "decisions made, or technical details from earlier sessions.",
    inputSchema: {
      query: z.string().describe("What to search for in past conversations"),
      limit: z.number().optional().default(5).describe("Max results to return (default: 5)"),
    },
  },
  async ({ query, limit }) => {
    try {
      const results = await searchConversations(config, query, limit);
      logSearchMetric('lesa_conversation_search', query, results.length);

      if (results.length === 0) {
        return { content: [{ type: "text" as const, text: "No conversation history found." }] };
      }

      const hasEmbeddings = results[0].similarity !== undefined;
      const freshnessIcon = { fresh: "🟢", recent: "🟡", aging: "🟠", stale: "🔴" };
      const text = results
        .map((r, i) => {
          const sim = r.similarity !== undefined ? `score: ${r.similarity.toFixed(3)}, ` : "";
          const fresh = r.freshness ? `${freshnessIcon[r.freshness]} ${r.freshness}, ` : "";
          return `[${i + 1}] (${fresh}${sim}session: ${r.sessionKey}, date: ${r.date})\n${r.text}`;
        })
        .join("\n\n---\n\n");

      const prefix = hasEmbeddings
        ? "(Recency-weighted. 🟢 fresh <3d, 🟡 recent <7d, 🟠 aging <14d, 🔴 stale 14d+)\n\n"
        : "(Text search; no API key for semantic search)\n\n";
      return { content: [{ type: "text" as const, text: `${prefix}${text}` }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error: ${err.message}` }], isError: true };
    }
  }
);

// Tool 2: Search workspace markdown files
server.registerTool(
  "lesa_memory_search",
  {
    description:
      "Search workspace memory files (MEMORY.md, daily logs, notes, identity docs). " +
      "Returns matching excerpts from .md files. Use this to find written memory, " +
      "observations, todos, and notes.",
    inputSchema: {
      query: z.string().describe("Keywords to search for in workspace files"),
    },
  },
  async ({ query }) => {
    try {
      const results = searchWorkspace(config.workspaceDir, query);
      logSearchMetric('lesa_memory_search', query, results.length);

      if (results.length === 0) {
        return { content: [{ type: "text" as const, text: `No workspace files matched "${query}".` }] };
      }

      const text = results
        .map((r) => {
          const excerpts = r.excerpts.map((e) => `  ${e.replace(/\n/g, "\n  ")}`).join("\n  ...\n");
          return `### ${r.path}\n${excerpts}`;
        })
        .join("\n\n---\n\n");

      return { content: [{ type: "text" as const, text }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error: ${err.message}` }], isError: true };
    }
  }
);

// Tool 3: Read a specific workspace file
server.registerTool(
  "lesa_read_workspace",
  {
    description:
      "Read a specific file from the agent workspace. Paths are relative to the workspace directory. " +
      "Common files: MEMORY.md, IDENTITY.md, SOUL.md, USER.md, AGENTS.md, TOOLS.md, " +
      "memory/YYYY-MM-DD.md (daily logs), memory/todos.md, memory/observations.md, notes/*.",
    inputSchema: {
      path: z.string().describe("File path relative to workspace/ (e.g. 'MEMORY.md', 'memory/2026-02-07.md')"),
    },
  },
  async ({ path: filePath }) => {
    try {
      const result = readWorkspaceFile(config.workspaceDir, filePath);
      return { content: [{ type: "text" as const, text: `# ${result.relativePath}\n\n${result.content}` }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: err.message }], isError: !err.message.includes("Available files") };
    }
  }
);

// Tool 4: Send a message to the OpenClaw agent
server.registerTool(
  "lesa_send_message",
  {
    description:
      "Send a message to the OpenClaw agent through the gateway. Routes through the agent's " +
      "full pipeline: memory, tools, personality, workspace. Use this for direct communication: " +
      "asking questions, sharing findings, coordinating work, or having a discussion. " +
      "Messages are prefixed with [Claude Code] so the agent knows the source.",
    inputSchema: {
      message: z.string().describe("Message to send to the OpenClaw agent"),
    },
  },
  async ({ message }) => {
    try {
      const reply = await sendMessage(config.openclawDir, message);
      return { content: [{ type: "text" as const, text: reply }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error sending message: ${err.message}` }], isError: true };
    }
  }
);

// Tool 5: Check inbox for messages from the OpenClaw agent
server.registerTool(
  "lesa_check_inbox",
  {
    description:
      "Check for pending messages from the OpenClaw agent. The agent can push messages " +
      "via the inbox HTTP endpoint (POST localhost:18790/message). Call this to see if " +
      "the agent has sent anything. Returns all pending messages and clears the queue.",
    inputSchema: {},
  },
  async () => {
    const messages = drainInbox();

    if (messages.length === 0) {
      return { content: [{ type: "text" as const, text: "No pending messages." }] };
    }

    const text = messages
      .map((m) => `**${m.from}** (${m.timestamp}):\n${m.message}`)
      .join("\n\n---\n\n");

    return { content: [{ type: "text" as const, text: `${messages.length} message(s):\n\n${text}` }] };
  }
);

// ── OpenClaw Skill Bridge ────────────────────────────────────────────

function registerSkillTools(skills: SkillInfo[]): void {
  const executableSkills = skills.filter(s => s.hasScripts);
  const toolNameMap = new Map<string, SkillInfo>();

  // Register executable skills as individual tools
  for (const skill of executableSkills) {
    const toolName = `oc_skill_${skill.name.replace(/-/g, "_")}`;
    toolNameMap.set(toolName, skill);

    const scriptList = skill.scripts.length > 1
      ? ` Available scripts: ${skill.scripts.join(", ")}.`
      : "";

    server.registerTool(
      toolName,
      {
        description: `[OpenClaw skill] ${skill.description}${scriptList}`,
        inputSchema: {
          args: z.string().describe("Arguments to pass to the skill script (e.g. file paths, flags)"),
          script: z.string().optional().describe(
            skill.scripts.length > 1
              ? `Which script to run: ${skill.scripts.join(", ")}. Defaults to first .sh script.`
              : "Script to run (optional, defaults to the only available script)"
          ),
        },
      },
      async ({ args, script }) => {
        try {
          const result = await executeSkillScript(skill.skillDir, skill.scripts, script, args);
          return { content: [{ type: "text" as const, text: result }] };
        } catch (err: any) {
          return { content: [{ type: "text" as const, text: `Error: ${err.message}` }], isError: true };
        }
      }
    );
  }

  // Register a list tool for all skills
  server.registerTool(
    "oc_skills_list",
    {
      description:
        "List all available OpenClaw skills and their descriptions. " +
        "Skills with scripts can be called directly as oc_skill_{name} tools. " +
        "Instruction-only skills describe how to use external CLIs.",
      inputSchema: {
        filter: z.string().optional().describe("Filter skills by name or description keyword"),
      },
    },
    async ({ filter }) => {
      let filtered = skills;
      if (filter) {
        const f = filter.toLowerCase();
        filtered = skills.filter(s =>
          s.name.toLowerCase().includes(f) ||
          s.description.toLowerCase().includes(f)
        );
      }

      if (filtered.length === 0) {
        return { content: [{ type: "text" as const, text: "No skills matched the filter." }] };
      }

      const lines = filtered.map(s => {
        const prefix = s.hasScripts ? `oc_skill_${s.name.replace(/-/g, "_")}` : "(instruction-only)";
        const emoji = s.emoji ? `${s.emoji} ` : "";
        return `- ${emoji}**${s.name}** [${prefix}]: ${s.description}`;
      });

      const header = `${filtered.length} skill(s)` +
        (filter ? ` matching "${filter}"` : "") +
        ` (${executableSkills.length} executable, ${skills.length - executableSkills.length} instruction-only)`;

      return { content: [{ type: "text" as const, text: `${header}\n\n${lines.join("\n")}` }] };
    }
  );

  console.error(`wip-bridge: registered ${executableSkills.length} skill tools + oc_skills_list (${skills.length} total skills)`);
}

// ── Start ────────────────────────────────────────────────────────────

async function main() {
  startInboxServer(config);

  // Discover and register OpenClaw skills
  try {
    const skills = discoverSkills(config.openclawDir);
    registerSkillTools(skills);
  } catch (err: any) {
    console.error(`wip-bridge: skill discovery failed: ${err.message}`);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`wip-bridge MCP server running (openclaw: ${config.openclawDir})`);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
