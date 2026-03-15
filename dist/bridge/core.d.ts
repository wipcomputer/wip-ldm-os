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
    from: string;
    message: string;
    timestamp: string;
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
declare function pushInbox(msg: InboxMessage): number;
declare function drainInbox(): InboxMessage[];
declare function inboxCount(): number;
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

export { type BridgeConfig, type ConversationResult, type GatewayConfig, type InboxMessage, LDM_ROOT, type SkillInfo, type WorkspaceFileResult, type WorkspaceSearchResult, blobToEmbedding, cosineSimilarity, discoverSkills, drainInbox, executeSkillScript, findMarkdownFiles, getQueryEmbedding, inboxCount, pushInbox, readWorkspaceFile, resolveApiKey, resolveConfig, resolveConfigMulti, resolveGatewayConfig, searchConversations, searchWorkspace, sendMessage };
