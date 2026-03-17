// wip-bridge/core.ts: Pure logic. Zero framework deps.
// Handles messaging, memory search, and workspace access for OpenClaw agents.

import { execSync, exec } from "node:child_process";
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { promisify } from "node:util";

const execAsync = promisify(exec);

// ── Constants ─────────────────────────────────────────────────────────

const HOME = process.env.HOME || "/Users/lesa";
export const LDM_ROOT = process.env.LDM_ROOT || join(HOME, ".ldm");

// ── Types ────────────────────────────────────────────────────────────

export interface BridgeConfig {
  openclawDir: string;
  workspaceDir: string;
  dbPath: string;
  inboxPort: number;
  embeddingModel: string;
  embeddingDimensions: number;
}

export interface GatewayConfig {
  token: string;
  port: number;
}

export interface InboxMessage {
  from: string;
  message: string;
  timestamp: string;
}

export interface ConversationResult {
  text: string;
  role: string;
  sessionKey: string;
  date: string;
  similarity?: number;
  recencyScore?: number;
  freshness?: "fresh" | "recent" | "aging" | "stale";
}

export interface WorkspaceSearchResult {
  path: string;
  excerpts: string[];
  score: number;
}

// ── Config resolution ────────────────────────────────────────────────

export function resolveConfig(overrides?: Partial<BridgeConfig>): BridgeConfig {
  const openclawDir = overrides?.openclawDir || process.env.OPENCLAW_DIR || join(process.env.HOME || "~", ".openclaw");
  return {
    openclawDir,
    workspaceDir: overrides?.workspaceDir || join(openclawDir, "workspace"),
    dbPath: overrides?.dbPath || join(openclawDir, "memory", "context-embeddings.sqlite"),
    inboxPort: overrides?.inboxPort || parseInt(process.env.LESA_BRIDGE_INBOX_PORT || "18790", 10),
    embeddingModel: overrides?.embeddingModel || "text-embedding-3-small",
    embeddingDimensions: overrides?.embeddingDimensions || 1536,
  };
}

/**
 * Multi-config resolver. Checks ~/.ldm/config.json first, falls back to OPENCLAW_DIR.
 * This is the LDM OS native path. resolveConfig() is the legacy OpenClaw path.
 * Both return the same BridgeConfig shape.
 */
export function resolveConfigMulti(overrides?: Partial<BridgeConfig>): BridgeConfig {
  // Check LDM OS config first
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
        embeddingDimensions: raw.embeddingDimensions || overrides?.embeddingDimensions || 1536,
      };
    } catch {
      // LDM config unreadable, fall through to legacy
    }
  }

  // Fallback to legacy OpenClaw resolution
  return resolveConfig(overrides);
}

// ── API key resolution ───────────────────────────────────────────────

let cachedApiKey: string | null | undefined = undefined;

export function resolveApiKey(openclawDir: string): string | null {
  if (cachedApiKey !== undefined) return cachedApiKey;

  // 1. Environment variable
  if (process.env.OPENAI_API_KEY) {
    cachedApiKey = process.env.OPENAI_API_KEY;
    return cachedApiKey;
  }

  // 2. 1Password via service account token
  const tokenPath = join(openclawDir, "secrets", "op-sa-token");
  if (existsSync(tokenPath)) {
    try {
      const saToken = readFileSync(tokenPath, "utf-8").trim();
      const key = execSync(
        `op read "op://Agent Secrets/OpenAI API/api key" 2>/dev/null`,
        {
          env: { ...process.env, OP_SERVICE_ACCOUNT_TOKEN: saToken },
          timeout: 10000,
          encoding: "utf-8",
        }
      ).trim();
      if (key && key.startsWith("sk-")) {
        cachedApiKey = key;
        return cachedApiKey;
      }
    } catch {
      // 1Password not available
    }
  }

  cachedApiKey = null;
  return null;
}

// ── Gateway config ───────────────────────────────────────────────────

let cachedGatewayConfig: GatewayConfig | null = null;

export function resolveGatewayConfig(openclawDir: string): GatewayConfig {
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

// ── Inbox ────────────────────────────────────────────────────────────

const inboxQueue: InboxMessage[] = [];

export function pushInbox(msg: InboxMessage): number {
  inboxQueue.push(msg);
  return inboxQueue.length;
}

export function drainInbox(): InboxMessage[] {
  const messages = [...inboxQueue];
  inboxQueue.length = 0;
  return messages;
}

export function inboxCount(): number {
  return inboxQueue.length;
}

// ── Send message to OpenClaw agent ───────────────────────────────────

export async function sendMessage(
  openclawDir: string,
  message: string,
  options?: { agentId?: string; user?: string; senderLabel?: string }
): Promise<string> {
  const { token, port } = resolveGatewayConfig(openclawDir);
  const agentId = options?.agentId || "main";
  const senderLabel = options?.senderLabel || "Claude Code";

  // Send user: "main" to route to the main session (agent:main:main).
  // This ensures Parker sees CC's messages in the same stream as iMessage.
  // The OpenClaw gateway treats user: "main" as "use the default session."
  const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: agentId,
      user: "main",
      messages: [
        {
          role: "user",
          content: `[${senderLabel}]: ${message}`,
        },
      ],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Gateway returned ${response.status}: ${body}`);
  }

  const data = (await response.json()) as {
    choices: Array<{ message: { content: string } }>;
  };

  const reply = data.choices?.[0]?.message?.content;
  if (!reply) {
    throw new Error("No response content from gateway");
  }

  return reply;
}

// ── Embedding helpers ────────────────────────────────────────────────

export async function getQueryEmbedding(
  text: string,
  apiKey: string,
  model = "text-embedding-3-small",
  dimensions = 1536
): Promise<number[]> {
  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      input: [text],
      model,
      dimensions,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenAI embeddings failed (${response.status}): ${body}`);
  }

  const data = (await response.json()) as { data: Array<{ embedding: number[] }> };
  return data.data[0].embedding;
}

export function blobToEmbedding(blob: Buffer): number[] {
  const floats: number[] = [];
  for (let i = 0; i < blob.length; i += 4) {
    floats.push(blob.readFloatLE(i));
  }
  return floats;
}

export function cosineSimilarity(a: number[], b: number[]): number {
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

// ── Recency scoring ─────────────────────────────────────────────────

function recencyWeight(ageDays: number): number {
  // Linear decay with floor at 0.5. Old stuff never fully disappears
  // but fresh context wins ties. ~50 days to hit the floor.
  return Math.max(0.5, 1.0 - ageDays * 0.01);
}

function freshnessLabel(ageDays: number): "fresh" | "recent" | "aging" | "stale" {
  if (ageDays < 3) return "fresh";
  if (ageDays < 7) return "recent";
  if (ageDays < 14) return "aging";
  return "stale";
}

// ── Conversation search ──────────────────────────────────────────────

export async function searchConversations(
  config: BridgeConfig,
  query: string,
  limit = 5
): Promise<ConversationResult[]> {
  // Lazy import to avoid requiring better-sqlite3 if not needed
  const Database = (await import("better-sqlite3")).default;

  if (!existsSync(config.dbPath)) {
    throw new Error(`Database not found: ${config.dbPath}`);
  }

  const db = new Database(config.dbPath, { readonly: true });
  db.pragma("journal_mode = WAL");

  try {
    const apiKey = resolveApiKey(config.openclawDir);

    if (apiKey) {
      // Vector search
      const queryEmbedding = await getQueryEmbedding(
        query, apiKey, config.embeddingModel, config.embeddingDimensions
      );

      const rows = db
        .prepare(
          `SELECT chunk_text, role, session_key, timestamp, embedding
           FROM conversation_chunks
           WHERE embedding IS NOT NULL
           ORDER BY timestamp DESC
           LIMIT 1000`
        )
        .all() as Array<{
        chunk_text: string;
        role: string;
        session_key: string;
        timestamp: number;
        embedding: Buffer;
      }>;

      const now = Date.now();
      return rows
        .map((row) => {
          const cosine = cosineSimilarity(queryEmbedding, blobToEmbedding(row.embedding));
          const ageDays = (now - row.timestamp) / (1000 * 60 * 60 * 24);
          const weight = recencyWeight(ageDays);
          return {
            text: row.chunk_text,
            role: row.role,
            sessionKey: row.session_key,
            date: new Date(row.timestamp).toISOString().split("T")[0],
            similarity: cosine * weight,
            recencyScore: weight,
            freshness: freshnessLabel(ageDays),
          };
        })
        .sort((a, b) => (b.similarity || 0) - (a.similarity || 0))
        .slice(0, limit);
    } else {
      // Fallback: text search
      const rows = db
        .prepare(
          `SELECT chunk_text, role, session_key, timestamp
           FROM conversation_chunks
           WHERE chunk_text LIKE ?
           ORDER BY timestamp DESC
           LIMIT ?`
        )
        .all(`%${query}%`, limit) as Array<{
        chunk_text: string;
        role: string;
        session_key: string;
        timestamp: number;
      }>;

      return rows.map((row) => ({
        text: row.chunk_text,
        role: row.role,
        sessionKey: row.session_key,
        date: new Date(row.timestamp).toISOString().split("T")[0],
      }));
    }
  } finally {
    db.close();
  }
}

// ── Workspace search ─────────────────────────────────────────────────

export function findMarkdownFiles(dir: string, maxDepth = 4, depth = 0): string[] {
  if (depth > maxDepth || !existsSync(dir)) return [];

  const files: string[] = [];
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

export function searchWorkspace(workspaceDir: string, query: string): WorkspaceSearchResult[] {
  const files = findMarkdownFiles(workspaceDir);
  const queryLower = query.toLowerCase();
  const words = queryLower.split(/\s+/).filter((w) => w.length > 2);
  const results: WorkspaceSearchResult[] = [];

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
      const excerpts: string[] = [];
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
      // Skip unreadable files
    }
  }

  return results.sort((a, b) => b.score - a.score).slice(0, 10);
}

// ── Read workspace file ──────────────────────────────────────────────

export interface WorkspaceFileResult {
  content: string;
  relativePath: string;
}

// ── Skill types ─────────────────────────────────────────────────────

export interface SkillInfo {
  name: string;
  description: string;
  skillDir: string;
  hasScripts: boolean;
  scripts: string[];
  source: "builtin" | "custom";
  emoji?: string;
  requires?: Record<string, string[]>;
}

// ── Skill discovery ─────────────────────────────────────────────────

function parseSkillFrontmatter(content: string): { name?: string; description?: string; emoji?: string; requires?: Record<string, string[]> } {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};

  const yaml = match[1];
  const name = yaml.match(/^name:\s*(.+)$/m)?.[1]?.trim();
  const description = yaml.match(/^description:\s*(.+)$/m)?.[1]?.trim();

  // Extract emoji from metadata block (handles both YAML and JSON-in-YAML formats)
  let emoji: string | undefined;
  const emojiMatch = yaml.match(/"emoji":\s*"([^"]+)"/);
  if (emojiMatch) emoji = emojiMatch[1];

  // Extract requires
  let requires: Record<string, string[]> | undefined;
  const requiresMatch = yaml.match(/"requires":\s*\{([^}]+)\}/);
  if (requiresMatch) {
    requires = {};
    const pairs = requiresMatch[1].matchAll(/"(\w+)":\s*\[([^\]]*)\]/g);
    for (const pair of pairs) {
      const values = pair[2].match(/"([^"]+)"/g)?.map(v => v.replace(/"/g, "")) || [];
      requires[pair[1]] = values;
    }
  }

  return { name, description, emoji, requires };
}

export function discoverSkills(openclawDir: string): SkillInfo[] {
  const skills: SkillInfo[] = [];
  const seen = new Set<string>();

  // Two places skills live:
  // 1. Built-in: extensions/*/node_modules/openclaw/skills/
  // 2. Custom: extensions/*/skills/
  const extensionsDir = join(openclawDir, "extensions");
  if (!existsSync(extensionsDir)) return skills;

  for (const ext of readdirSync(extensionsDir, { withFileTypes: true })) {
    if (!ext.isDirectory() || ext.name.startsWith(".")) continue;
    const extDir = join(extensionsDir, ext.name);

    const searchDirs: Array<{ dir: string; source: "builtin" | "custom" }> = [
      { dir: join(extDir, "node_modules", "openclaw", "skills"), source: "builtin" },
      { dir: join(extDir, "skills"), source: "custom" },
    ];

    for (const { dir, source } of searchDirs) {
      if (!existsSync(dir)) continue;

      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue;

        const skillDir = join(dir, entry.name);
        const skillMd = join(skillDir, "SKILL.md");
        if (!existsSync(skillMd)) continue;

        // Deduplicate by skill name (same skill may appear in multiple extensions)
        if (seen.has(entry.name)) continue;
        seen.add(entry.name);

        try {
          const content = readFileSync(skillMd, "utf-8");
          const frontmatter = parseSkillFrontmatter(content);

          const scriptsDir = join(skillDir, "scripts");
          let scripts: string[] = [];
          let hasScripts = false;

          if (existsSync(scriptsDir) && statSync(scriptsDir).isDirectory()) {
            scripts = readdirSync(scriptsDir).filter(f =>
              f.endsWith(".sh") || f.endsWith(".py")
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
            requires: frontmatter.requires,
          });
        } catch {
          // Skip unreadable skills
        }
      }
    }
  }

  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

// ── Skill execution ─────────────────────────────────────────────────

export async function executeSkillScript(
  skillDir: string,
  scripts: string[],
  scriptName: string | undefined,
  args: string
): Promise<string> {
  const scriptsDir = join(skillDir, "scripts");

  // Find the script to run
  let script: string;
  if (scriptName) {
    if (!scripts.includes(scriptName)) {
      throw new Error(`Script "${scriptName}" not found. Available: ${scripts.join(", ")}`);
    }
    script = scriptName;
  } else if (scripts.length === 1) {
    script = scripts[0];
  } else {
    // Default: prefer .sh over .py, take the first
    const sh = scripts.find(s => s.endsWith(".sh"));
    script = sh || scripts[0];
  }

  const scriptPath = join(scriptsDir, script);

  // Determine interpreter
  const interpreter = script.endsWith(".py") ? "python3" : "bash";

  try {
    const { stdout, stderr } = await execAsync(
      `${interpreter} "${scriptPath}" ${args}`,
      {
        env: { ...process.env },
        timeout: 120000,
        maxBuffer: 10 * 1024 * 1024, // 10MB
      }
    );
    return stdout || stderr || "(no output)";
  } catch (err: any) {
    // exec errors include stdout/stderr on the error object
    const output = err.stdout || err.stderr || err.message;
    throw new Error(`Script failed (exit ${err.code || "?"}): ${output}`);
  }
}

export function readWorkspaceFile(workspaceDir: string, filePath: string): WorkspaceFileResult {
  const resolved = resolve(workspaceDir, filePath);
  if (!resolved.startsWith(resolve(workspaceDir))) {
    throw new Error("Path must be within workspace/");
  }

  if (!existsSync(resolved)) {
    // List available files at the requested directory level
    const dir = resolved.endsWith(".md") ? join(resolved, "..") : resolved;
    if (existsSync(dir) && statSync(dir).isDirectory()) {
      const files = findMarkdownFiles(dir, 1);
      const listing = files.map((f) => relative(workspaceDir, f)).join("\n");
      throw new Error(`File not found: ${filePath}\n\nAvailable files:\n${listing}`);
    }
    throw new Error(`File not found: ${filePath}`);
  }

  return {
    content: readFileSync(resolved, "utf-8"),
    relativePath: relative(workspaceDir, resolved),
  };
}
