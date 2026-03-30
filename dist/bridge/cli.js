#!/usr/bin/env node
import {
  discoverSkills,
  readWorkspaceFile,
  resolveApiKey,
  resolveConfig,
  resolveGatewayConfig,
  searchConversations,
  searchWorkspace,
  sendMessage
} from "./chunk-QZ4DNVJM.js";

// cli.ts
import { existsSync, statSync } from "fs";
var config = resolveConfig();
function usage() {
  console.log(`wip-bridge: Claude Code CLI \u2194 OpenClaw TUI agent bridge

Usage:
  lesa send <message>         Send a message to the OpenClaw agent
  lesa search <query>         Semantic search over conversation history
  lesa memory <query>         Keyword search across workspace files
  lesa read <path>            Read a workspace file (relative to workspace/)
  lesa status                 Show bridge configuration
  lesa diagnose               Check gateway, inbox, DB, skills health
  lesa help                   Show this help

Examples:
  lesa send "What are you working on?"
  lesa search "API key resolution"
  lesa memory "compaction"
  lesa read MEMORY.md
  lesa read memory/2026-02-10.md`);
}
async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  if (!command || command === "help" || command === "--help" || command === "-h") {
    usage();
    process.exit(0);
  }
  const arg = args.slice(1).join(" ");
  switch (command) {
    case "send": {
      if (!arg) {
        console.error("Error: message required. Usage: lesa send <message>");
        process.exit(1);
      }
      try {
        const reply = await sendMessage(config.openclawDir, arg);
        console.log(reply);
      } catch (err) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
      break;
    }
    case "search": {
      if (!arg) {
        console.error("Error: query required. Usage: lesa search <query>");
        process.exit(1);
      }
      try {
        const results = await searchConversations(config, arg);
        if (results.length === 0) {
          console.log("No results found.");
        } else {
          const icon = { fresh: "\u{1F7E2}", recent: "\u{1F7E1}", aging: "\u{1F7E0}", stale: "\u{1F534}" };
          for (const [i, r] of results.entries()) {
            const sim = r.similarity !== void 0 ? ` (${(r.similarity * 100).toFixed(1)}%)` : "";
            const fresh = r.freshness ? ` ${icon[r.freshness]} ${r.freshness}` : "";
            console.log(`[${i + 1}]${sim}${fresh} ${r.sessionKey} ${r.date}`);
            console.log(r.text);
            if (i < results.length - 1) console.log("\n---\n");
          }
        }
      } catch (err) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
      break;
    }
    case "memory": {
      if (!arg) {
        console.error("Error: query required. Usage: lesa memory <query>");
        process.exit(1);
      }
      try {
        const results = searchWorkspace(config.workspaceDir, arg);
        if (results.length === 0) {
          console.log(`No workspace files matched "${arg}".`);
        } else {
          for (const r of results) {
            console.log(`### ${r.path}`);
            for (const excerpt of r.excerpts) {
              console.log(`  ${excerpt.replace(/\n/g, "\n  ")}`);
            }
            console.log();
          }
        }
      } catch (err) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
      break;
    }
    case "read": {
      if (!arg) {
        console.error("Error: path required. Usage: lesa read <path>");
        process.exit(1);
      }
      try {
        const result = readWorkspaceFile(config.workspaceDir, arg);
        console.log(result.content);
      } catch (err) {
        console.error(err.message);
        process.exit(1);
      }
      break;
    }
    case "status": {
      console.log(`wip-bridge status`);
      console.log(`  OpenClaw dir:  ${config.openclawDir}`);
      console.log(`  Workspace:     ${config.workspaceDir}`);
      console.log(`  Database:      ${config.dbPath}`);
      console.log(`  Inbox port:    ${config.inboxPort}`);
      console.log(`  Embedding:     ${config.embeddingModel} (${config.embeddingDimensions}d)`);
      break;
    }
    case "diagnose": {
      console.log("wip-bridge diagnose\n");
      let issues = 0;
      if (existsSync(config.openclawDir)) {
        console.log(`  \u2713 OpenClaw dir exists: ${config.openclawDir}`);
      } else {
        console.log(`  \u2717 OpenClaw dir missing: ${config.openclawDir}`);
        issues++;
      }
      try {
        const gw = resolveGatewayConfig(config.openclawDir);
        console.log(`  \u2713 Gateway config found (port ${gw.port}, token present)`);
        try {
          const resp = await fetch(`http://127.0.0.1:${gw.port}/health`, { signal: AbortSignal.timeout(3e3) });
          if (resp.ok) {
            console.log(`  \u2713 Gateway responding on port ${gw.port}`);
          } else {
            console.log(`  \u2717 Gateway returned ${resp.status}`);
            issues++;
          }
        } catch {
          console.log(`  \u2717 Gateway not reachable on port ${gw.port}`);
          issues++;
        }
      } catch (err) {
        console.log(`  \u2717 Gateway config: ${err.message}`);
        issues++;
      }
      try {
        const resp = await fetch(`http://127.0.0.1:${config.inboxPort}/status`, { signal: AbortSignal.timeout(3e3) });
        const data = await resp.json();
        if (data.ok) {
          console.log(`  \u2713 Inbox endpoint responding (${data.pending} pending)`);
        } else {
          console.log(`  \u2717 Inbox endpoint returned unexpected response`);
          issues++;
        }
      } catch {
        console.log(`  - Inbox not running (normal if MCP server isn't started)`);
      }
      if (existsSync(config.dbPath)) {
        const stats = statSync(config.dbPath);
        const sizeMB = (stats.size / 1024 / 1024).toFixed(1);
        console.log(`  \u2713 Embeddings DB exists (${sizeMB} MB)`);
      } else {
        console.log(`  \u2717 Embeddings DB missing: ${config.dbPath}`);
        issues++;
      }
      const apiKey = resolveApiKey(config.openclawDir);
      if (apiKey) {
        console.log(`  \u2713 OpenAI API key found (semantic search enabled)`);
      } else {
        console.log(`  - No OpenAI API key (text search fallback)`);
      }
      try {
        const skills = discoverSkills(config.openclawDir);
        const executable = skills.filter((s) => s.hasScripts).length;
        console.log(`  \u2713 Skills discovered: ${skills.length} total, ${executable} executable`);
      } catch (err) {
        console.log(`  \u2717 Skill discovery failed: ${err.message}`);
        issues++;
      }
      if (existsSync(config.workspaceDir)) {
        console.log(`  \u2713 Workspace dir exists`);
      } else {
        console.log(`  \u2717 Workspace dir missing: ${config.workspaceDir}`);
        issues++;
      }
      console.log();
      if (issues === 0) {
        console.log("  All checks passed.");
      } else {
        console.log(`  ${issues} issue(s) found.`);
      }
      break;
    }
    default:
      console.error(`Unknown command: ${command}`);
      usage();
      process.exit(1);
  }
}
main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
