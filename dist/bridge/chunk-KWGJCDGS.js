// core.ts
import { execSync, exec } from "child_process";
import { readdirSync, readFileSync, existsSync, statSync } from "fs";
import { join, relative, resolve } from "path";
import { promisify } from "util";
var execAsync = promisify(exec);
var HOME = process.env.HOME || "/Users/lesa";
var LDM_ROOT = process.env.LDM_ROOT || join(HOME, ".ldm");
function resolveConfig(overrides) {
  const openclawDir = overrides?.openclawDir || process.env.OPENCLAW_DIR || join(process.env.HOME || "~", ".openclaw");
  return {
    openclawDir,
    workspaceDir: overrides?.workspaceDir || join(openclawDir, "workspace"),
    dbPath: overrides?.dbPath || join(openclawDir, "memory", "context-embeddings.sqlite"),
    inboxPort: overrides?.inboxPort || parseInt(process.env.LESA_BRIDGE_INBOX_PORT || "18790", 10),
    embeddingModel: overrides?.embeddingModel || "text-embedding-3-small",
    embeddingDimensions: overrides?.embeddingDimensions || 1536
  };
}
function resolveConfigMulti(overrides) {
  const ldmConfig = join(LDM_ROOT, "config.json");
  if (existsSync(ldmConfig)) {
    try {
      const raw = JSON.parse(readFileSync(ldmConfig, "utf-8"));
      const openclawDir = raw.openclawDir || process.env.OPENCLAW_DIR || join(HOME, ".openclaw");
      return {
        openclawDir,
        workspaceDir: raw.workspaceDir || overrides?.workspaceDir || join(openclawDir, "workspace"),
        dbPath: raw.dbPath || overrides?.dbPath || join(openclawDir, "memory", "context-embeddings.sqlite"),
        inboxPort: raw.inboxPort || overrides?.inboxPort || parseInt(process.env.LESA_BRIDGE_INBOX_PORT || "18790", 10),
        embeddingModel: raw.embeddingModel || overrides?.embeddingModel || "text-embedding-3-small",
        embeddingDimensions: raw.embeddingDimensions || overrides?.embeddingDimensions || 1536
      };
    } catch {
    }
  }
  return resolveConfig(overrides);
}
var cachedApiKey = void 0;
function resolveApiKey(openclawDir) {
  if (cachedApiKey !== void 0) return cachedApiKey;
  if (process.env.OPENAI_API_KEY) {
    cachedApiKey = process.env.OPENAI_API_KEY;
    return cachedApiKey;
  }
  const tokenPath = join(openclawDir, "secrets", "op-sa-token");
  if (existsSync(tokenPath)) {
    try {
      const saToken = readFileSync(tokenPath, "utf-8").trim();
      const key = execSync(
        `op read "op://Agent Secrets/OpenAI API/api key" 2>/dev/null`,
        {
          env: { ...process.env, OP_SERVICE_ACCOUNT_TOKEN: saToken },
          timeout: 1e4,
          encoding: "utf-8"
        }
      ).trim();
      if (key && key.startsWith("sk-")) {
        cachedApiKey = key;
        return cachedApiKey;
      }
    } catch {
    }
  }
  cachedApiKey = null;
  return null;
}
var cachedGatewayConfig = null;
function resolveGatewayConfig(openclawDir) {
  if (cachedGatewayConfig) return cachedGatewayConfig;
  const configPath = join(openclawDir, "openclaw.json");
  if (!existsSync(configPath)) {
    throw new Error(`OpenClaw config not found: ${configPath}`);
  }
  const config = JSON.parse(readFileSync(configPath, "utf-8"));
  const token = config?.gateway?.auth?.token;
  const port = config?.gateway?.port || 18789;
  if (!token) {
    throw new Error("No gateway.auth.token found in openclaw.json");
  }
  cachedGatewayConfig = { token, port };
  return cachedGatewayConfig;
}
var inboxQueue = [];
function pushInbox(msg) {
  inboxQueue.push(msg);
  return inboxQueue.length;
}
function drainInbox() {
  const messages = [...inboxQueue];
  inboxQueue.length = 0;
  return messages;
}
function inboxCount() {
  return inboxQueue.length;
}
async function sendMessage(openclawDir, message, options) {
  const { token, port } = resolveGatewayConfig(openclawDir);
  const agentId = options?.agentId || "main";
  const user = options?.user || "claude-code";
  const senderLabel = options?.senderLabel || "Claude Code";
  const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: agentId,
      user,
      messages: [
        {
          role: "user",
          content: `[${senderLabel}]: ${message}`
        }
      ]
    })
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Gateway returned ${response.status}: ${body}`);
  }
  const data = await response.json();
  const reply = data.choices?.[0]?.message?.content;
  if (!reply) {
    throw new Error("No response content from gateway");
  }
  return reply;
}
async function getQueryEmbedding(text, apiKey, model = "text-embedding-3-small", dimensions = 1536) {
  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      input: [text],
      model,
      dimensions
    })
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenAI embeddings failed (${response.status}): ${body}`);
  }
  const data = await response.json();
  return data.data[0].embedding;
}
function blobToEmbedding(blob) {
  const floats = [];
  for (let i = 0; i < blob.length; i += 4) {
    floats.push(blob.readFloatLE(i));
  }
  return floats;
}
function cosineSimilarity(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
function recencyWeight(ageDays) {
  return Math.max(0.5, 1 - ageDays * 0.01);
}
function freshnessLabel(ageDays) {
  if (ageDays < 3) return "fresh";
  if (ageDays < 7) return "recent";
  if (ageDays < 14) return "aging";
  return "stale";
}
async function searchConversations(config, query, limit = 5) {
  const Database = (await import("better-sqlite3")).default;
  if (!existsSync(config.dbPath)) {
    throw new Error(`Database not found: ${config.dbPath}`);
  }
  const db = new Database(config.dbPath, { readonly: true });
  db.pragma("journal_mode = WAL");
  try {
    const apiKey = resolveApiKey(config.openclawDir);
    if (apiKey) {
      const queryEmbedding = await getQueryEmbedding(
        query,
        apiKey,
        config.embeddingModel,
        config.embeddingDimensions
      );
      const rows = db.prepare(
        `SELECT chunk_text, role, session_key, timestamp, embedding
           FROM conversation_chunks
           WHERE embedding IS NOT NULL
           ORDER BY timestamp DESC
           LIMIT 1000`
      ).all();
      const now = Date.now();
      return rows.map((row) => {
        const cosine = cosineSimilarity(queryEmbedding, blobToEmbedding(row.embedding));
        const ageDays = (now - row.timestamp) / (1e3 * 60 * 60 * 24);
        const weight = recencyWeight(ageDays);
        return {
          text: row.chunk_text,
          role: row.role,
          sessionKey: row.session_key,
          date: new Date(row.timestamp).toISOString().split("T")[0],
          similarity: cosine * weight,
          recencyScore: weight,
          freshness: freshnessLabel(ageDays)
        };
      }).sort((a, b) => (b.similarity || 0) - (a.similarity || 0)).slice(0, limit);
    } else {
      const rows = db.prepare(
        `SELECT chunk_text, role, session_key, timestamp
           FROM conversation_chunks
           WHERE chunk_text LIKE ?
           ORDER BY timestamp DESC
           LIMIT ?`
      ).all(`%${query}%`, limit);
      return rows.map((row) => ({
        text: row.chunk_text,
        role: row.role,
        sessionKey: row.session_key,
        date: new Date(row.timestamp).toISOString().split("T")[0]
      }));
    }
  } finally {
    db.close();
  }
}
function findMarkdownFiles(dir, maxDepth = 4, depth = 0) {
  if (depth > maxDepth || !existsSync(dir)) return [];
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...findMarkdownFiles(fullPath, maxDepth, depth + 1));
    } else if (entry.name.endsWith(".md")) {
      files.push(fullPath);
    }
  }
  return files;
}
function searchWorkspace(workspaceDir, query) {
  const files = findMarkdownFiles(workspaceDir);
  const queryLower = query.toLowerCase();
  const words = queryLower.split(/\s+/).filter((w) => w.length > 2);
  const results = [];
  for (const filePath of files) {
    try {
      const content = readFileSync(filePath, "utf-8");
      const contentLower = content.toLowerCase();
      let score = 0;
      for (const word of words) {
        if (contentLower.indexOf(word) !== -1) score++;
      }
      if (score === 0) continue;
      const lines = content.split("\n");
      const excerpts = [];
      for (let i = 0; i < lines.length && excerpts.length < 5; i++) {
        const lineLower = lines[i].toLowerCase();
        if (words.some((w) => lineLower.includes(w))) {
          const start = Math.max(0, i - 1);
          const end = Math.min(lines.length, i + 2);
          excerpts.push(lines.slice(start, end).join("\n"));
        }
      }
      results.push({ path: relative(workspaceDir, filePath), excerpts, score });
    } catch {
    }
  }
  return results.sort((a, b) => b.score - a.score).slice(0, 10);
}
function parseSkillFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const yaml = match[1];
  const name = yaml.match(/^name:\s*(.+)$/m)?.[1]?.trim();
  const description = yaml.match(/^description:\s*(.+)$/m)?.[1]?.trim();
  let emoji;
  const emojiMatch = yaml.match(/"emoji":\s*"([^"]+)"/);
  if (emojiMatch) emoji = emojiMatch[1];
  let requires;
  const requiresMatch = yaml.match(/"requires":\s*\{([^}]+)\}/);
  if (requiresMatch) {
    requires = {};
    const pairs = requiresMatch[1].matchAll(/"(\w+)":\s*\[([^\]]*)\]/g);
    for (const pair of pairs) {
      const values = pair[2].match(/"([^"]+)"/g)?.map((v) => v.replace(/"/g, "")) || [];
      requires[pair[1]] = values;
    }
  }
  return { name, description, emoji, requires };
}
function discoverSkills(openclawDir) {
  const skills = [];
  const seen = /* @__PURE__ */ new Set();
  const extensionsDir = join(openclawDir, "extensions");
  if (!existsSync(extensionsDir)) return skills;
  for (const ext of readdirSync(extensionsDir, { withFileTypes: true })) {
    if (!ext.isDirectory() || ext.name.startsWith(".")) continue;
    const extDir = join(extensionsDir, ext.name);
    const searchDirs = [
      { dir: join(extDir, "node_modules", "openclaw", "skills"), source: "builtin" },
      { dir: join(extDir, "skills"), source: "custom" }
    ];
    for (const { dir, source } of searchDirs) {
      if (!existsSync(dir)) continue;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
        const skillDir = join(dir, entry.name);
        const skillMd = join(skillDir, "SKILL.md");
        if (!existsSync(skillMd)) continue;
        if (seen.has(entry.name)) continue;
        seen.add(entry.name);
        try {
          const content = readFileSync(skillMd, "utf-8");
          const frontmatter = parseSkillFrontmatter(content);
          const scriptsDir = join(skillDir, "scripts");
          let scripts = [];
          let hasScripts = false;
          if (existsSync(scriptsDir) && statSync(scriptsDir).isDirectory()) {
            scripts = readdirSync(scriptsDir).filter(
              (f) => f.endsWith(".sh") || f.endsWith(".py")
            );
            hasScripts = scripts.length > 0;
          }
          skills.push({
            name: frontmatter.name || entry.name,
            description: frontmatter.description || `OpenClaw skill: ${entry.name}`,
            skillDir,
            hasScripts,
            scripts,
            source,
            emoji: frontmatter.emoji,
            requires: frontmatter.requires
          });
        } catch {
        }
      }
    }
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}
async function executeSkillScript(skillDir, scripts, scriptName, args) {
  const scriptsDir = join(skillDir, "scripts");
  let script;
  if (scriptName) {
    if (!scripts.includes(scriptName)) {
      throw new Error(`Script "${scriptName}" not found. Available: ${scripts.join(", ")}`);
    }
    script = scriptName;
  } else if (scripts.length === 1) {
    script = scripts[0];
  } else {
    const sh = scripts.find((s) => s.endsWith(".sh"));
    script = sh || scripts[0];
  }
  const scriptPath = join(scriptsDir, script);
  const interpreter = script.endsWith(".py") ? "python3" : "bash";
  try {
    const { stdout, stderr } = await execAsync(
      `${interpreter} "${scriptPath}" ${args}`,
      {
        env: { ...process.env },
        timeout: 12e4,
        maxBuffer: 10 * 1024 * 1024
        // 10MB
      }
    );
    return stdout || stderr || "(no output)";
  } catch (err) {
    const output = err.stdout || err.stderr || err.message;
    throw new Error(`Script failed (exit ${err.code || "?"}): ${output}`);
  }
}
function readWorkspaceFile(workspaceDir, filePath) {
  const resolved = resolve(workspaceDir, filePath);
  if (!resolved.startsWith(resolve(workspaceDir))) {
    throw new Error("Path must be within workspace/");
  }
  if (!existsSync(resolved)) {
    const dir = resolved.endsWith(".md") ? join(resolved, "..") : resolved;
    if (existsSync(dir) && statSync(dir).isDirectory()) {
      const files = findMarkdownFiles(dir, 1);
      const listing = files.map((f) => relative(workspaceDir, f)).join("\n");
      throw new Error(`File not found: ${filePath}

Available files:
${listing}`);
    }
    throw new Error(`File not found: ${filePath}`);
  }
  return {
    content: readFileSync(resolved, "utf-8"),
    relativePath: relative(workspaceDir, resolved)
  };
}

export {
  LDM_ROOT,
  resolveConfig,
  resolveConfigMulti,
  resolveApiKey,
  resolveGatewayConfig,
  pushInbox,
  drainInbox,
  inboxCount,
  sendMessage,
  getQueryEmbedding,
  blobToEmbedding,
  cosineSimilarity,
  searchConversations,
  findMarkdownFiles,
  searchWorkspace,
  discoverSkills,
  executeSkillScript,
  readWorkspaceFile
};
