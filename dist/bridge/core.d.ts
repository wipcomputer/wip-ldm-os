declare const LDM_ROOT: string;
interface BridgeConfig {
    openclawDir: string;
    workspaceDir: string;
    dbPath: string;
    inboxPort: number;
    embeddingModel: string;
    embeddingDimensions: number;
}
interface GatewayConfig {
    token: string;
    port: number;
}
interface InboxMessage {
    id: string;
    type: string;
    from: string;
    to: string;
    body: string;
    message?: string;
    timestamp: string;
    read: boolean;
}
interface ConversationResult {
    text: string;
    role: string;
    sessionKey: string;
    date: string;
    similarity?: number;
    recencyScore?: number;
    freshness?: "fresh" | "recent" | "aging" | "stale";
}
interface WorkspaceSearchResult {
    path: string;
    excerpts: string[];
    score: number;
}
declare function resolveConfig(overrides?: Partial<BridgeConfig>): BridgeConfig;
/**
 * Multi-config resolver. Checks ~/.ldm/config.json first, falls back to OPENCLAW_DIR.
 * This is the LDM OS native path. resolveConfig() is the legacy OpenClaw path.
 * Both return the same BridgeConfig shape.
 */
declare function resolveConfigMulti(overrides?: Partial<BridgeConfig>): BridgeConfig;
declare function resolveApiKey(openclawDir: string): string | null;
declare function resolveGatewayConfig(openclawDir: string): GatewayConfig;
declare function setSessionIdentity(agentId: string, sessionName: string): void;
declare function getSessionIdentity(): {
    agentId: string;
    sessionName: string;
};
/**
 * Write a message to the file-based inbox.
 * Creates a JSON file at ~/.ldm/messages/{uuid}.json.
 */
declare function pushInbox(msg: {
    from: string;
    message?: string;
    body?: string;
    to?: string;
    type?: string;
}): number;
/**
 * Read and drain all messages for this session from the inbox.
 * Moves processed messages to ~/.ldm/messages/_processed/.
 */
declare function drainInbox(): InboxMessage[];
/**
 * Count pending messages for this session without draining.
 */
declare function inboxCount(): number;
/**
 * Get pending message counts broken down by session.
 * Used by GET /status to show per-session counts.
 */
declare function inboxCountBySession(): Record<string, number>;
/**
 * Send a message to another agent or session via the file-based inbox.
 * Phase 4: Cross-agent messaging. Works for any agent, any session.
 * This is the file-based path. For OpenClaw agents, use sendMessage() (gateway).
 */
declare function sendLdmMessage(opts: {
    from?: string;
    to: string;
    body: string;
    type?: string;
}): string | null;
interface SessionInfo {
    name: string;
    agentId: string;
    pid: number;
    startTime: string;
    cwd: string;
    alive: boolean;
    meta?: Record<string, unknown>;
}
/**
 * Register this bridge session in ~/.ldm/sessions/.
 * Uses the agent--session naming convention.
 */
declare function registerBridgeSession(): SessionInfo | null;
/**
 * List active sessions. Validates PID liveness and cleans stale entries.
 */
declare function listActiveSessions(agentFilter?: string): SessionInfo[];
declare function sendMessage(openclawDir: string, message: string, options?: {
    agentId?: string;
    user?: string;
    senderLabel?: string;
}): Promise<string>;
declare function getQueryEmbedding(text: string, apiKey: string, model?: string, dimensions?: number): Promise<number[]>;
declare function blobToEmbedding(blob: Buffer): number[];
declare function cosineSimilarity(a: number[], b: number[]): number;
declare function searchConversations(config: BridgeConfig, query: string, limit?: number): Promise<ConversationResult[]>;
declare function findMarkdownFiles(dir: string, maxDepth?: number, depth?: number): string[];
declare function searchWorkspace(workspaceDir: string, query: string): WorkspaceSearchResult[];
interface WorkspaceFileResult {
    content: string;
    relativePath: string;
}
interface SkillInfo {
    name: string;
    description: string;
    skillDir: string;
    hasScripts: boolean;
    scripts: string[];
    source: "builtin" | "custom";
    emoji?: string;
    requires?: Record<string, string[]>;
}
declare function discoverSkills(openclawDir: string): SkillInfo[];
declare function executeSkillScript(skillDir: string, scripts: string[], scriptName: string | undefined, args: string): Promise<string>;
declare function readWorkspaceFile(workspaceDir: string, filePath: string): WorkspaceFileResult;

export { type BridgeConfig, type ConversationResult, type GatewayConfig, type InboxMessage, LDM_ROOT, type SessionInfo, type SkillInfo, type WorkspaceFileResult, type WorkspaceSearchResult, blobToEmbedding, cosineSimilarity, discoverSkills, drainInbox, executeSkillScript, findMarkdownFiles, getQueryEmbedding, getSessionIdentity, inboxCount, inboxCountBySession, listActiveSessions, pushInbox, readWorkspaceFile, registerBridgeSession, resolveApiKey, resolveConfig, resolveConfigMulti, resolveGatewayConfig, searchConversations, searchWorkspace, sendLdmMessage, sendMessage, setSessionIdentity };
