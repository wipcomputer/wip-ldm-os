import {
  discoverSkills,
  drainInbox,
  executeSkillScript,
  getSessionIdentity,
  inboxCount,
  inboxCountBySession,
  listActiveSessions,
  pushInbox,
  readWorkspaceFile,
  registerBridgeSession,
  resolveConfig,
  searchConversations,
  searchWorkspace,
  sendLdmMessage,
  sendMessage,
  setSessionIdentity
} from "./chunk-O65O6CCM.js";
import {
  __require
} from "./chunk-3RG5ZIWI.js";

// mcp-server.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "http";
import { appendFileSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { z } from "zod";
var config = resolveConfig();
var METRICS_DIR = join(process.env.HOME || homedir(), ".openclaw", "memory");
var METRICS_PATH = join(METRICS_DIR, "search-metrics.jsonl");
function logSearchMetric(tool, query, resultCount) {
  try {
    mkdirSync(METRICS_DIR, { recursive: true });
    const entry = JSON.stringify({
      ts: (/* @__PURE__ */ new Date()).toISOString(),
      tool,
      query,
      results: resultCount
    });
    appendFileSync(METRICS_PATH, entry + "\n");
  } catch {
  }
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}
function startInboxServer(cfg) {
  const httpServer = createServer(async (req, res) => {
    const remoteAddr = req.socket.remoteAddress;
    if (remoteAddr !== "127.0.0.1" && remoteAddr !== "::1" && remoteAddr !== "::ffff:127.0.0.1") {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "localhost only" }));
      return;
    }
    if (req.method === "POST" && req.url === "/message") {
      try {
        const body = JSON.parse(await readBody(req));
        const { agentId, sessionName } = getSessionIdentity();
        const queued = pushInbox({
          from: body.from || "agent",
          body: body.body || body.message || "",
          to: body.to || `${agentId}:${sessionName}`,
          type: body.type || "chat"
        });
        const messageBody = body.body || body.message || "";
        console.error(`wip-bridge inbox: message from ${body.from || "agent"} to ${body.to || "default"}`);
        try {
          server.sendLoggingMessage({
            level: "info",
            logger: "wip-bridge",
            data: `[inbox] ${body.from || "agent"}: ${messageBody}`
          });
        } catch {
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, queued }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }
    if (req.method === "GET" && req.url === "/status") {
      const pending = inboxCount();
      const bySession = inboxCountBySession();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, pending, bySession }));
      return;
    }
    if (req.method === "GET" && req.url === "/sessions") {
      const sessions = listActiveSessions();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, sessions }));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  httpServer.listen(cfg.inboxPort, "127.0.0.1", () => {
    console.error(`wip-bridge inbox listening on 127.0.0.1:${cfg.inboxPort}`);
  });
  httpServer.on("error", (err) => {
    console.error(`wip-bridge inbox server error: ${err.message}`);
  });
}
var server = new McpServer({
  name: "wip-bridge",
  version: "0.3.0"
});
server.registerTool(
  "lesa_conversation_search",
  {
    description: "Search embedded conversation history. Returns semantically similar excerpts from past conversations. Use this to find what was discussed about a topic, decisions made, or technical details from earlier sessions.",
    inputSchema: {
      query: z.string().describe("What to search for in past conversations"),
      limit: z.number().optional().default(5).describe("Max results to return (default: 5)")
    }
  },
  async ({ query, limit }) => {
    try {
      const results = await searchConversations(config, query, limit);
      logSearchMetric("lesa_conversation_search", query, results.length);
      if (results.length === 0) {
        return { content: [{ type: "text", text: "No conversation history found." }] };
      }
      const hasEmbeddings = results[0].similarity !== void 0;
      const freshnessIcon = { fresh: "\u{1F7E2}", recent: "\u{1F7E1}", aging: "\u{1F7E0}", stale: "\u{1F534}" };
      const text = results.map((r, i) => {
        const sim = r.similarity !== void 0 ? `score: ${r.similarity.toFixed(3)}, ` : "";
        const fresh = r.freshness ? `${freshnessIcon[r.freshness]} ${r.freshness}, ` : "";
        return `[${i + 1}] (${fresh}${sim}session: ${r.sessionKey}, date: ${r.date})
${r.text}`;
      }).join("\n\n---\n\n");
      const prefix = hasEmbeddings ? "(Recency-weighted. \u{1F7E2} fresh <3d, \u{1F7E1} recent <7d, \u{1F7E0} aging <14d, \u{1F534} stale 14d+)\n\n" : "(Text search; no API key for semantic search)\n\n";
      return { content: [{ type: "text", text: `${prefix}${text}` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);
server.registerTool(
  "lesa_memory_search",
  {
    description: "Search workspace memory files (MEMORY.md, daily logs, notes, identity docs). Returns matching excerpts from .md files. Use this to find written memory, observations, todos, and notes.",
    inputSchema: {
      query: z.string().describe("Keywords to search for in workspace files")
    }
  },
  async ({ query }) => {
    try {
      const results = searchWorkspace(config.workspaceDir, query);
      logSearchMetric("lesa_memory_search", query, results.length);
      if (results.length === 0) {
        return { content: [{ type: "text", text: `No workspace files matched "${query}".` }] };
      }
      const text = results.map((r) => {
        const excerpts = r.excerpts.map((e) => `  ${e.replace(/\n/g, "\n  ")}`).join("\n  ...\n");
        return `### ${r.path}
${excerpts}`;
      }).join("\n\n---\n\n");
      return { content: [{ type: "text", text }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);
server.registerTool(
  "lesa_read_workspace",
  {
    description: "Read a specific file from the agent workspace. Paths are relative to the workspace directory. Common files: MEMORY.md, IDENTITY.md, SOUL.md, USER.md, AGENTS.md, TOOLS.md, memory/YYYY-MM-DD.md (daily logs), memory/todos.md, memory/observations.md, notes/*.",
    inputSchema: {
      path: z.string().describe("File path relative to workspace/ (e.g. 'MEMORY.md', 'memory/2026-02-07.md')")
    }
  },
  async ({ path: filePath }) => {
    try {
      const result = readWorkspaceFile(config.workspaceDir, filePath);
      return { content: [{ type: "text", text: `# ${result.relativePath}

${result.content}` }] };
    } catch (err) {
      return { content: [{ type: "text", text: err.message }], isError: !err.message.includes("Available files") };
    }
  }
);
server.registerTool(
  "lesa_send_message",
  {
    description: "Send a message to the OpenClaw agent through the gateway. Routes through the agent's full pipeline: memory, tools, personality, workspace. Use this for direct communication: asking questions, sharing findings, coordinating work, or having a discussion. Messages are prefixed with [Claude Code] so the agent knows the source.\n\nThis is async: returns immediately after sending. The agent's reply will arrive in your inbox (check via lesa_check_inbox or it appears automatically on your next turn).",
    inputSchema: {
      message: z.string().describe("Message to send to the OpenClaw agent")
    }
  },
  async ({ message }) => {
    try {
      await sendMessage(config.openclawDir, message, { fireAndForget: true });
      const { agentId, sessionName } = getSessionIdentity();
      sendLdmMessage({
        from: `${agentId}:${sessionName}`,
        to: "lesa",
        body: message,
        type: "chat"
      });
      return {
        content: [{
          type: "text",
          text: `Sent to L\u0113sa: "${message}"

Message delivered to the gateway (fire-and-forget). L\u0113sa will process it through her full pipeline. Her reply will arrive in your inbox. Use lesa_check_inbox to check, or it will appear automatically on your next turn.`
        }]
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Error sending message: ${err.message}` }], isError: true };
    }
  }
);
server.registerTool(
  "lesa_check_inbox",
  {
    description: "Check for pending messages in the file-based inbox (~/.ldm/messages/). Messages can come from OpenClaw agents, other Claude Code sessions, or CLI. Returns all pending messages for this session and marks them as read. Each entry includes [id: <uuid>] so you can pass it to lesa_reply_to_sender when replying to a specific message.",
    inputSchema: {}
  },
  async () => {
    const messages = drainInbox();
    if (messages.length === 0) {
      return { content: [{ type: "text", text: "No pending messages." }] };
    }
    const text = messages.map((m) => `**${m.from}** [${m.type}] (${m.timestamp}) [id: ${m.id}]:
${m.body || m.message}`).join("\n\n---\n\n");
    return { content: [{ type: "text", text: `${messages.length} message(s):

${text}` }] };
  }
);
server.registerTool(
  "lesa_reply_to_sender",
  {
    description: "Reply to a specific inbox message, routing back to the exact session that sent it (not broadcast). Use this instead of ldm_send_message when responding to something you saw in lesa_check_inbox. The message id is printed as [id: <uuid>] in the inbox output.\n\nIf the message id can't be found (already deleted, typo, etc.) the reply is still written with a best-effort target derived from the message sender field you pass in as fallback.",
    inputSchema: {
      messageId: z.string().describe("The inbox message id you are replying to (from the [id: ...] field in lesa_check_inbox output)"),
      body: z.string().describe("Reply body"),
      type: z.string().optional().default("chat").describe("Message type: chat, system, task (default: chat)")
    }
  },
  async ({ messageId, body, type }) => {
    try {
      const { agentId, sessionName } = getSessionIdentity();
      sendLdmMessage({
        from: `${agentId}:${sessionName}`,
        body,
        type: type || "chat",
        inReplyTo: messageId
      });
      return {
        content: [{
          type: "text",
          text: `Replied to message ${messageId}. Routed back to the original sender (not broadcast).`
        }]
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Error replying: ${err.message}` }], isError: true };
    }
  }
);
server.registerTool(
  "ldm_send_message",
  {
    description: "Send a message to any agent or session via the file-based inbox (~/.ldm/messages/). Works for agent-to-agent communication. For OpenClaw agents (like Lesa), use lesa_send_message instead (goes through the gateway). This tool writes directly to the shared inbox.\n\nTarget formats:\n  'cc-mini' ... default session\n  'cc-mini:brainstorm' ... named session\n  'cc-mini:*' ... broadcast to all sessions of that agent\n  '*' ... broadcast to all agents",
    inputSchema: {
      to: z.string().describe("Target: 'agent', 'agent:session', 'agent:*', or '*'"),
      message: z.string().describe("Message body"),
      type: z.string().optional().default("chat").describe("Message type: chat, system, task (default: chat)")
    }
  },
  async ({ to, message, type }) => {
    const { agentId, sessionName } = getSessionIdentity();
    const id = sendLdmMessage({
      from: `${agentId}:${sessionName}`,
      to,
      body: message,
      type
    });
    if (id) {
      return { content: [{ type: "text", text: `Message sent (id: ${id}) to ${to}` }] };
    } else {
      return { content: [{ type: "text", text: "Failed to send message." }], isError: true };
    }
  }
);
function registerSkillTools(skills) {
  const executableSkills = skills.filter((s) => s.hasScripts);
  const toolNameMap = /* @__PURE__ */ new Map();
  for (const skill of executableSkills) {
    const toolName = `oc_skill_${skill.name.replace(/-/g, "_")}`;
    toolNameMap.set(toolName, skill);
    const scriptList = skill.scripts.length > 1 ? ` Available scripts: ${skill.scripts.join(", ")}.` : "";
    server.registerTool(
      toolName,
      {
        description: `[OpenClaw skill] ${skill.description}${scriptList}`,
        inputSchema: {
          args: z.string().describe("Arguments to pass to the skill script (e.g. file paths, flags)"),
          script: z.string().optional().describe(
            skill.scripts.length > 1 ? `Which script to run: ${skill.scripts.join(", ")}. Defaults to first .sh script.` : "Script to run (optional, defaults to the only available script)"
          )
        }
      },
      async ({ args, script }) => {
        try {
          const result = await executeSkillScript(skill.skillDir, skill.scripts, script, args);
          return { content: [{ type: "text", text: result }] };
        } catch (err) {
          return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
        }
      }
    );
  }
  server.registerTool(
    "oc_skills_list",
    {
      description: "List all available OpenClaw skills and their descriptions. Skills with scripts can be called directly as oc_skill_{name} tools. Instruction-only skills describe how to use external CLIs.",
      inputSchema: {
        filter: z.string().optional().describe("Filter skills by name or description keyword")
      }
    },
    async ({ filter }) => {
      let filtered = skills;
      if (filter) {
        const f = filter.toLowerCase();
        filtered = skills.filter(
          (s) => s.name.toLowerCase().includes(f) || s.description.toLowerCase().includes(f)
        );
      }
      if (filtered.length === 0) {
        return { content: [{ type: "text", text: "No skills matched the filter." }] };
      }
      const lines = filtered.map((s) => {
        const prefix = s.hasScripts ? `oc_skill_${s.name.replace(/-/g, "_")}` : "(instruction-only)";
        const emoji = s.emoji ? `${s.emoji} ` : "";
        return `- ${emoji}**${s.name}** [${prefix}]: ${s.description}`;
      });
      const header = `${filtered.length} skill(s)` + (filter ? ` matching "${filter}"` : "") + ` (${executableSkills.length} executable, ${skills.length - executableSkills.length} instruction-only)`;
      return { content: [{ type: "text", text: `${header}

${lines.join("\n")}` }] };
    }
  );
  console.error(`wip-bridge: registered ${executableSkills.length} skill tools + oc_skills_list (${skills.length} total skills)`);
}
function resolveSessionName() {
  const ccSessionDir = join(process.env.HOME || homedir(), ".claude", "sessions");
  const ccSessionPath = join(ccSessionDir, `${process.ppid}.json`);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const data = JSON.parse(readFileSync(ccSessionPath, "utf-8"));
      if (data.name && typeof data.name === "string") {
        return data.name;
      }
      if (attempt < 2) {
        const { execSync } = __require("child_process");
        execSync("sleep 0.5", { stdio: "ignore" });
      }
    } catch {
      if (attempt < 2) {
        try {
          const { execSync } = __require("child_process");
          execSync("sleep 0.5", { stdio: "ignore" });
        } catch {
        }
      }
    }
  }
  if (process.env.LDM_SESSION_NAME) {
    return process.env.LDM_SESSION_NAME;
  }
  return "default";
}
async function main() {
  const agentId = process.env.LDM_AGENT_ID || "cc-mini";
  const sessionName = resolveSessionName();
  setSessionIdentity(agentId, sessionName);
  console.error(`wip-bridge: session identity: ${agentId}:${sessionName} (resolved from ${sessionName !== "default" ? "CC session file or env" : "default"})`);
  const session = registerBridgeSession();
  if (session) {
    console.error(`wip-bridge: registered session ${agentId}--${sessionName} (pid ${session.pid})`);
  }
  startInboxServer(config);
  try {
    const skills = discoverSkills(config.openclawDir);
    registerSkillTools(skills);
  } catch (err) {
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
