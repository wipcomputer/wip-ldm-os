#!/usr/bin/env node
/**
 * ldm - LDM OS CLI
 * The kernel for agent-native software.
 *
 * Commands:
 *   ldm init              Scaffold ~/.ldm/ and write version.json
 *   ldm install <target>  Detect interfaces + deploy + register
 *   ldm install           Install/update all registered components
 *   ldm doctor            Check health of all extensions
 *   ldm status            Show LDM OS version and extension count
 *   ldm backup            Run a full backup now
 *   ldm backup --dry-run  Preview what would be backed up (with sizes)
 *   ldm backup --pin "x"  Pin the latest backup so rotation skips it
 *   ldm sessions          List active sessions
 *   ldm msg send <to> <b> Send a message to a session
 *   ldm msg list          List pending messages
 *   ldm msg broadcast <b> Send to all sessions
 *   ldm updates           Show available updates
 *   ldm --version         Show version
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, cpSync, chmodSync, unlinkSync, readlinkSync, renameSync } from 'node:fs';
import { join, basename, resolve, dirname } from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const HOME = process.env.HOME || '';
const LDM_ROOT = join(HOME, '.ldm');
const LDM_EXTENSIONS = join(LDM_ROOT, 'extensions');
const VERSION_PATH = join(LDM_ROOT, 'version.json');
const REGISTRY_PATH = join(LDM_EXTENSIONS, 'registry.json');
const LDM_TMP = join(LDM_ROOT, 'tmp');

// Install log (#101): append to ~/.ldm/logs/install.log
import { appendFileSync } from 'node:fs';
const LOG_DIR = join(LDM_ROOT, 'logs');
const LOG_PATH = join(LOG_DIR, 'install.log');
function installLog(msg) {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {}
}

// Read our own version from package.json
const pkgPath = join(__dirname, '..', 'package.json');
let PKG_VERSION = '0.2.0';
try {
  PKG_VERSION = JSON.parse(readFileSync(pkgPath, 'utf8')).version;
} catch {}

// Read catalog
const catalogPath = join(__dirname, '..', 'catalog.json');
let CATALOG = { components: [] };
try {
  CATALOG = JSON.parse(readFileSync(catalogPath, 'utf8'));
} catch {}

// Auto-sync version.json when CLI version drifts (#33)
// npm install -g updates the binary but not version.json. Fix it on any CLI invocation.
if (existsSync(VERSION_PATH)) {
  try {
    const v = JSON.parse(readFileSync(VERSION_PATH, 'utf8'));
    if (v.version && v.version !== PKG_VERSION) {
      v.version = PKG_VERSION;
      v.installed = new Date().toISOString(); // #86: update install date on CLI upgrade
      v.updated = new Date().toISOString();
      writeFileSync(VERSION_PATH, JSON.stringify(v, null, 2) + '\n');
    }
  } catch {}
}

// ── Install lockfile (#57) ──

const LOCK_PATH = join(LDM_ROOT, 'state', '.ldm-install.lock');

function acquireInstallLock() {
  try {
    // Child processes spawned by `ldm install` inherit this env var
    if (process.env.LDM_INSTALL_LOCK_PID) return true;

    if (existsSync(LOCK_PATH)) {
      const lock = JSON.parse(readFileSync(LOCK_PATH, 'utf8'));
      // Re-entrant: if we already hold the lock, allow it
      if (lock.pid === process.pid) return true;
      // Check if PID is still alive
      try {
        process.kill(lock.pid, 0); // signal 0 = just check if alive
        console.log(`  Another ldm install is running (PID ${lock.pid}, started ${lock.started}).`);
        console.log(`  Wait for it to finish, or remove ~/.ldm/state/.ldm-install.lock`);
        return false;
      } catch {
        // PID is dead, stale lock. Auto-clean.
        try { unlinkSync(LOCK_PATH); } catch {}
        console.log(`  Cleaned stale install lock (PID ${lock.pid} is dead).`);
      }
    }
    mkdirSync(dirname(LOCK_PATH), { recursive: true });
    writeFileSync(LOCK_PATH, JSON.stringify({ pid: process.pid, started: new Date().toISOString() }));
    process.env.LDM_INSTALL_LOCK_PID = String(process.pid);

    // Clean up on exit
    const cleanup = () => { try { if (existsSync(LOCK_PATH)) { const l = JSON.parse(readFileSync(LOCK_PATH, 'utf8')); if (l.pid === process.pid) unlinkSync(LOCK_PATH); } } catch {} };
    process.on('exit', cleanup);
    process.on('SIGINT', () => { cleanup(); process.exit(1); });
    process.on('SIGTERM', () => { cleanup(); process.exit(1); });
    return true;
  } catch {
    return true; // if lock fails, allow install anyway
  }
}

const args = process.argv.slice(2);

// Normalize dry-run flag variants before parsing (#239)
// --dryrun -> --dry-run
// --dry run (two words) -> --dry-run (consume the stray "run" so it doesn't
//   become a package target and install random npm packages)
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--dryrun') {
    args[i] = '--dry-run';
  } else if (args[i] === '--dry') {
    if (args[i + 1] === 'run') {
      args[i] = '--dry-run';
      args.splice(i + 1, 1);
    } else {
      // Bare --dry with no "run" after it. Treat as --dry-run since there
      // is no other --dry flag and the intent is obvious.
      args[i] = '--dry-run';
    }
  }
}

const command = args[0];
const DRY_RUN = args.includes('--dry-run');
const JSON_OUTPUT = args.includes('--json');
const YES_FLAG = args.includes('--yes') || args.includes('-y');
const NONE_FLAG = args.includes('--none');
const FIX_FLAG = args.includes('--fix');
const CLEANUP_FLAG = args.includes('--cleanup');
const CHECK_FLAG = args.includes('--check');

function readJSON(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function writeJSON(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
}

// ── CLI version check (#29) ──

function checkCliVersion() {
  try {
    const result = execSync('npm view @wipcomputer/wip-ldm-os version 2>/dev/null', {
      encoding: 'utf8',
      timeout: 10000,
    }).trim();
    if (result && result !== PKG_VERSION) {
      console.log('');
      console.log(`  CLI is outdated: v${PKG_VERSION} installed, v${result} available.`);
      console.log(`  Run: npm install -g @wipcomputer/wip-ldm-os@${result}`);
    }
  } catch {
    // npm check failed, skip silently
  }
}

// ── Dead backup trigger cleanup (#207) ──
// Three backup systems were competing. Only ai.openclaw.ldm-backup (3am) works.
// This removes: broken cron entry (LDMDevTools.app), old com.wipcomputer.daily-backup.

function cleanDeadBackupTriggers() {
  let cleaned = 0;

  // 1. Remove broken cron entries referencing LDMDevTools.app
  // Matches both "LDMDevTools.app" and "LDM Dev Tools.app" (old naming)
  try {
    const crontab = execSync('crontab -l 2>/dev/null', { encoding: 'utf8' });
    const lines = crontab.split('\n');
    const filtered = lines.filter(line => {
      const lower = line.toLowerCase();
      // Remove any line (active or commented) that references LDMDevTools
      if (lower.includes('ldmdevtools.app') || lower.includes('ldm dev tools.app')) {
        cleaned++;
        return false;
      }
      // Remove orphaned descriptive comment for the old backup verification cron
      if (line.trim() === '# Verify daily backup ran - 00:30 PST') return false;
      return true;
    });
    if (cleaned > 0) {
      // Write filtered crontab via temp file (avoids shell escaping issues)
      const tmpCron = join(LDM_TMP, 'crontab.tmp');
      mkdirSync(LDM_TMP, { recursive: true });
      writeFileSync(tmpCron, filtered.join('\n'));
      execSync(`crontab "${tmpCron}"`, { stdio: 'pipe' });
      try { unlinkSync(tmpCron); } catch {}
      console.log(`  + Removed ${cleaned} dead cron entry(s) (LDMDevTools.app)`);
    }
  } catch {
    // No crontab or crontab command failed. Not critical.
  }

  // 2. Unload and disable com.wipcomputer.daily-backup LaunchAgent
  const oldPlist = join(HOME, 'Library', 'LaunchAgents', 'com.wipcomputer.daily-backup.plist');
  const disabledPlist = oldPlist + '.disabled';
  if (existsSync(oldPlist)) {
    try { execSync(`launchctl unload "${oldPlist}" 2>/dev/null`, { stdio: 'pipe' }); } catch {}
    try {
      renameSync(oldPlist, disabledPlist);
    } catch {
      // If rename fails, just try to remove it
      try { unlinkSync(oldPlist); } catch {}
    }
    console.log('  + Disabled dead LaunchAgent: com.wipcomputer.daily-backup');
    cleaned++;
  }

  // 3. Unload and disable com.wipcomputer.cc-watcher LaunchAgent
  // Broken since Mar 24 migration (old iCloud path, wrong node path).
  // The agent communication channel needs redesign, not screen automation.
  const ccWatcherPlist = join(HOME, 'Library', 'LaunchAgents', 'com.wipcomputer.cc-watcher.plist');
  const ccWatcherDisabled = ccWatcherPlist + '.disabled';
  if (existsSync(ccWatcherPlist)) {
    try { execSync(`launchctl unload "${ccWatcherPlist}" 2>/dev/null`, { stdio: 'pipe' }); } catch {}
    try {
      renameSync(ccWatcherPlist, ccWatcherDisabled);
    } catch {
      try { unlinkSync(ccWatcherPlist); } catch {}
    }
    console.log('  + Disabled dead LaunchAgent: com.wipcomputer.cc-watcher');
    cleaned++;
  }

  return cleaned;
}

// ── Stale hook cleanup (#30) ──

function cleanStaleHooks() {
  const settingsPath = join(HOME, '.claude', 'settings.json');
  const settings = readJSON(settingsPath);
  if (!settings?.hooks) return 0;

  let cleaned = 0;

  for (const [event, hookGroups] of Object.entries(settings.hooks)) {
    if (!Array.isArray(hookGroups)) continue;

    // Filter out hook groups where ALL hooks point to non-existent paths
    const original = hookGroups.length;
    settings.hooks[event] = hookGroups.filter(group => {
      const hooks = group.hooks || [];
      if (hooks.length === 0) return true; // keep empty groups (matcher-only)

      // Check each hook command for stale paths
      const liveHooks = hooks.filter(h => {
        if (!h.command) return true;
        // Extract the path from "node /path/to/file.mjs" or "node \"/path/to/file.mjs\""
        const match = h.command.match(/node\s+"?([^"]+)"?\s*$/);
        if (!match) return true; // keep non-node commands
        const scriptPath = match[1];
        // /tmp/ paths will vanish on reboot, always treat as stale
        const isTmp = scriptPath.startsWith('/tmp/') || scriptPath.startsWith('/private/tmp/');
        if (existsSync(scriptPath) && !isTmp) return true;
        const reason = isTmp ? '(temp path, will break on reboot)' : '(missing)';
        console.log(`  + Removed stale hook: ${event} -> ${scriptPath} ${reason}`);
        cleaned++;
        return false;
      });

      // Keep the group if it still has live hooks
      group.hooks = liveHooks;
      return liveHooks.length > 0;
    });
  }

  if (cleaned > 0) {
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  }

  return cleaned;
}

// ── Boot hook sync (#49) ──

function syncBootHook() {
  const srcBoot = join(__dirname, '..', 'src', 'boot', 'boot-hook.mjs');
  const destBoot = join(LDM_ROOT, 'shared', 'boot', 'boot-hook.mjs');

  if (!existsSync(srcBoot)) return false;

  try {
    const srcContent = readFileSync(srcBoot, 'utf8');
    let destContent = '';
    try { destContent = readFileSync(destBoot, 'utf8'); } catch {}

    if (srcContent !== destContent) {
      mkdirSync(dirname(destBoot), { recursive: true });
      writeFileSync(destBoot, srcContent);
      return true;
    }
  } catch {}
  return false;
}

// ── Catalog helpers ──

function loadCatalog() {
  return CATALOG.components || [];
}

function findInCatalog(id) {
  const q = id.toLowerCase();
  // Strip org/ prefix for matching (e.g. "wipcomputer/openclaw-tavily" -> "openclaw-tavily")
  const qBase = q.includes('/') ? q.split('/').pop() : q;
  const catalog = loadCatalog();
  // Exact id match
  const exact = catalog.find(c => c.id === id || c.id === qBase);
  if (exact) return exact;
  // Exact repo match (e.g. "wipcomputer/openclaw-tavily" matches repo field directly)
  const byRepo = catalog.find(c => c.repo && c.repo.toLowerCase() === q);
  if (byRepo) return byRepo;
  // Partial id match (e.g. "xai-grok" matches "wip-xai-grok")
  // Check both directions but require word-boundary alignment (hyphen or start of string)
  // to prevent "openclaw" matching "openclaw-tavily"
  const partial = catalog.find(c => {
    const cid = c.id.toLowerCase();
    if (cid === qBase) return false;
    // Query is suffix of catalog id: "xai-grok" matches "wip-xai-grok"
    if (cid.endsWith(qBase) && (cid.length === qBase.length || cid[cid.length - qBase.length - 1] === '-')) return true;
    // Catalog id is suffix of query: "wip-xai-grok" matches when query is "wip-xai-grok-private"
    if (qBase.endsWith(cid) && (qBase.length === cid.length || qBase[qBase.length - cid.length - 1] === '-')) return true;
    return false;
  });
  if (partial) return partial;
  // Name match (case-insensitive, e.g. "xAI Grok")
  const byName = catalog.find(c => c.name && c.name.toLowerCase() === q);
  if (byName) return byName;
  // registryMatches match
  const byRegistry = catalog.find(c => (c.registryMatches || []).some(m => m.toLowerCase() === q || m.toLowerCase() === qBase));
  if (byRegistry) return byRegistry;
  return null;
}

// Install a single catalog component directly (no subprocess).
// Replaces the old execSync('ldm install ${c.repo}') which spawned
// a full installer process for each component.
async function installCatalogComponent(c) {
  const { installFromPath } = await import('../lib/deploy.mjs');
  const repoTarget = c.repo;
  const repoName = basename(repoTarget);
  const repoPath = join(LDM_TMP, repoName);
  const httpsUrl = `https://github.com/${repoTarget}.git`;
  const sshUrl = `git@github.com:${repoTarget}.git`;

  mkdirSync(LDM_TMP, { recursive: true });
  console.log(`  Cloning ${repoTarget}...`);
  try {
    if (existsSync(repoPath)) {
      execSync(`rm -rf "${repoPath}"`, { stdio: 'pipe' });
    }
    try {
      execSync(`git clone --depth 1 "${httpsUrl}" "${repoPath}"`, { stdio: 'pipe' });
    } catch {
      console.log(`  HTTPS failed. Trying SSH...`);
      if (existsSync(repoPath)) execSync(`rm -rf "${repoPath}"`, { stdio: 'pipe' });
      execSync(`git clone --depth 1 "${sshUrl}" "${repoPath}"`, { stdio: 'pipe' });
    }
  } catch (e) {
    console.error(`  x Clone failed: ${e.message}`);
    return;
  }

  await installFromPath(repoPath);

  // Clean up staging clone
  if (repoPath.startsWith(LDM_TMP)) {
    try { execSync(`rm -rf "${repoPath}"`, { stdio: 'pipe' }); } catch {}
  }
  console.log(`  ✓ Installed ${c.name}`);
}

// ── ldm init ──

async function cmdInit() {
  console.log('');
  console.log('  ldm init');
  console.log('  ────────────────────────────────────');

  const dirs = [
    join(LDM_ROOT, 'extensions'),
    join(LDM_ROOT, 'agents'),
    join(LDM_ROOT, 'memory'),
    join(LDM_ROOT, 'state'),
    join(LDM_ROOT, 'sessions'),
    join(LDM_ROOT, 'messages'),
    join(LDM_ROOT, 'shared', 'boot'),
    join(LDM_ROOT, 'shared', 'cron'),
    join(LDM_ROOT, 'shared', 'rules'),
    join(LDM_ROOT, 'shared', 'prompts'),
    join(LDM_ROOT, 'hooks'),
  ];

  // Migrate config-from-home.json into config.json (one-time merge)
  // config-from-home.json held org identity (coAuthors, paths, agents, backup, etc.)
  // config.json held runtime/harness info. Now they are one file.
  const configFromHomePath = join(LDM_ROOT, 'config-from-home.json');
  if (existsSync(configFromHomePath) && existsSync(join(LDM_ROOT, 'config.json'))) {
    try {
      const existing = JSON.parse(readFileSync(join(LDM_ROOT, 'config.json'), 'utf8'));
      const fromHome = JSON.parse(readFileSync(configFromHomePath, 'utf8'));
      // Merge: config-from-home.json wins where keys overlap (richer data)
      const merged = { ...existing, ...fromHome };
      // Preserve harnesses from existing config (not in config-from-home.json)
      if (existing.harnesses) merged.harnesses = existing.harnesses;
      // Preserve version and created from existing config
      if (existing.version) merged.version = existing.version;
      if (existing.created) merged.created = existing.created;
      // Update timestamp
      merged.updatedAt = new Date().toISOString();
      writeFileSync(join(LDM_ROOT, 'config.json'), JSON.stringify(merged, null, 2) + '\n');
      renameSync(configFromHomePath, configFromHomePath + '.migrated');
      console.log(`  + config-from-home.json merged into config.json`);
      console.log(`  + config-from-home.json renamed to config-from-home.json.migrated`);
    } catch (e) {
      console.log(`  ! config-from-home.json migration failed: ${e.message}`);
    }
  }

  // Scaffold per-agent memory dirs
  try {
    const config = JSON.parse(readFileSync(join(LDM_ROOT, 'config.json'), 'utf8'));
    const agents = config.agents || [];
    const agentList = Array.isArray(agents) ? agents : Object.keys(agents);
    for (const agentId of agentList) {
      for (const sub of ['memory/daily', 'memory/journals', 'memory/sessions', 'memory/transcripts']) {
        dirs.push(join(LDM_ROOT, 'agents', agentId, sub));
      }
    }

    // Scaffold workspace output dirs if workspace is configured
    const workspace = config.workspace;
    if (workspace && existsSync(workspace)) {
      // Per-agent workspace dirs
      const agentNameMap = { 'cc-mini': 'cc-mini', 'cc-air': 'cc-air', 'oc-lesa-mini': 'Lēsa' };
      for (const agentId of agentList) {
        const teamName = agentNameMap[agentId] || agentId;
        for (const sub of ['journals', 'automated/memory/summaries/daily', 'automated/memory/summaries/weekly', 'automated/memory/summaries/monthly', 'automated/memory/summaries/quarterly']) {
          dirs.push(join(workspace, 'team', teamName, sub));
        }
      }
      // Org-wide dirs
      for (const track of ['team', 'dev']) {
        for (const cadence of ['daily', 'weekly', 'monthly', 'quarterly']) {
          dirs.push(join(workspace, 'operations', 'updates', track, cadence));
        }
      }
    }
  } catch {} // config.json may not exist on first init

  const existing = existsSync(VERSION_PATH);

  if (DRY_RUN) {
    for (const dir of dirs) {
      if (existsSync(dir)) {
        console.log(`  - ${dir} (exists)`);
      } else {
        console.log(`  + would create ${dir}`);
      }
    }
    if (existing) {
      const v = readJSON(VERSION_PATH);
      console.log(`  - version.json exists (v${v?.version})`);
    } else {
      console.log(`  + would write version.json (v${PKG_VERSION})`);
    }
    console.log('');
    console.log('  Dry run complete. No changes made.');
    console.log('');
    return;
  }

  let created = 0;
  for (const dir of dirs) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      console.log(`  + ${dir}`);
      created++;
    } else {
      console.log(`  - ${dir} (exists)`);
    }
  }

  // Write or update version.json
  const now = new Date().toISOString();
  if (existing) {
    const v = readJSON(VERSION_PATH);
    v.version = PKG_VERSION;
    v.updated = now;
    writeJSON(VERSION_PATH, v);
    console.log(`  + version.json updated to v${PKG_VERSION}`);
  } else {
    writeJSON(VERSION_PATH, {
      version: PKG_VERSION,
      installed: now,
      updated: now,
    });
    console.log(`  + version.json created (v${PKG_VERSION})`);
  }

  // Seed registry if missing
  if (!existsSync(REGISTRY_PATH)) {
    writeJSON(REGISTRY_PATH, { _format: 'v1', extensions: {} });
    console.log(`  + registry.json created`);
  }

  // Install global git pre-commit hook (blocks commits on main)
  const hooksDir = join(LDM_ROOT, 'hooks');
  const preCommitDest = join(hooksDir, 'pre-commit');
  const preCommitSrc = join(__dirname, '..', 'templates', 'hooks', 'pre-commit');
  if (!existsSync(hooksDir)) mkdirSync(hooksDir, { recursive: true });
  if (existsSync(preCommitSrc)) {
    cpSync(preCommitSrc, preCommitDest);
    chmodSync(preCommitDest, 0o755);
    // Set global hooksPath if not already set to somewhere else
    try {
      const currentHooksPath = execSync('git config --global core.hooksPath', { encoding: 'utf8' }).trim();
      if (currentHooksPath !== hooksDir) {
        console.log(`  ! core.hooksPath already set to ${currentHooksPath}. Not overwriting.`);
      }
    } catch {
      // Not set. Set it.
      execSync(`git config --global core.hooksPath "${hooksDir}"`);
      console.log(`  + git pre-commit hook installed (blocks commits on main)`);
    }
  }

  // Deploy process monitor (#75)
  const monitorSrc = join(__dirname, '..', 'bin', 'process-monitor.sh');
  const monitorDest = join(LDM_ROOT, 'bin', 'process-monitor.sh');
  if (existsSync(monitorSrc)) {
    mkdirSync(join(LDM_ROOT, 'bin'), { recursive: true });
    cpSync(monitorSrc, monitorDest);
    chmodSync(monitorDest, 0o755);
    // Add cron entry if not already there
    try {
      const crontab = execSync('crontab -l 2>/dev/null', { encoding: 'utf8' });
      if (!crontab.includes('process-monitor')) {
        execSync(`(crontab -l 2>/dev/null; echo "*/3 * * * * ${monitorDest}") | crontab -`);
        console.log(`  + process monitor installed (every 3 min, kills zombie processes)`);
      }
    } catch {
      try {
        execSync(`echo "*/3 * * * * ${monitorDest}" | crontab -`);
        console.log(`  + process monitor installed (every 3 min)`);
      } catch {}
    }
  }

  // Deploy backup + restore scripts (#119)
  const backupSrc = join(__dirname, '..', 'scripts', 'ldm-backup.sh');
  const backupDest = join(LDM_ROOT, 'bin', 'ldm-backup.sh');
  if (existsSync(backupSrc)) {
    mkdirSync(join(LDM_ROOT, 'bin'), { recursive: true });
    cpSync(backupSrc, backupDest);
    chmodSync(backupDest, 0o755);
    console.log(`  + ldm-backup.sh deployed to ~/.ldm/bin/`);
  }
  const restoreSrc = join(__dirname, '..', 'scripts', 'ldm-restore.sh');
  const restoreDest = join(LDM_ROOT, 'bin', 'ldm-restore.sh');
  if (existsSync(restoreSrc)) {
    cpSync(restoreSrc, restoreDest);
    chmodSync(restoreDest, 0o755);
    console.log(`  + ldm-restore.sh deployed to ~/.ldm/bin/`);
  }
  const summarySrc = join(__dirname, '..', 'scripts', 'ldm-summary.sh');
  const summaryDest = join(LDM_ROOT, 'bin', 'ldm-summary.sh');
  if (existsSync(summarySrc)) {
    cpSync(summarySrc, summaryDest);
    chmodSync(summaryDest, 0o755);
    console.log(`  + ldm-summary.sh deployed to ~/.ldm/bin/`);
  }

  // Deploy shared rules to ~/.ldm/shared/rules/ and to harnesses
  const rulesSrc = join(__dirname, '..', 'shared', 'rules');
  const rulesDest = join(LDM_ROOT, 'shared', 'rules');
  if (existsSync(rulesSrc)) {
    mkdirSync(rulesDest, { recursive: true });
    let rulesCount = 0;
    for (const file of readdirSync(rulesSrc)) {
      if (!file.endsWith('.md')) continue;
      cpSync(join(rulesSrc, file), join(rulesDest, file));
      rulesCount++;
    }
    if (rulesCount > 0) {
      console.log(`  + ${rulesCount} shared rules deployed to ~/.ldm/shared/rules/`);

      // Deploy to Claude Code harness (~/.claude/rules/)
      const claudeRules = join(HOME, '.claude', 'rules');
      if (existsSync(join(HOME, '.claude'))) {
        mkdirSync(claudeRules, { recursive: true });
        for (const file of readdirSync(rulesDest)) {
          if (!file.endsWith('.md')) continue;
          cpSync(join(rulesDest, file), join(claudeRules, file));
        }
        console.log(`  + rules deployed to ~/.claude/rules/`);
      }

      // Deploy to OpenClaw harness (~/.openclaw/workspace/DEV-RULES.md)
      const ocWorkspace = join(HOME, '.openclaw', 'workspace');
      if (existsSync(ocWorkspace)) {
        let combined = '# Dev Rules (deployed by ldm install)\n\n';
        combined += '> Do not edit this file. It is regenerated by `ldm install`.\n';
        combined += '> Source: ~/.ldm/shared/rules/\n\n';
        for (const file of readdirSync(rulesDest).sort()) {
          if (!file.endsWith('.md')) continue;
          combined += readFileSync(join(rulesDest, file), 'utf8') + '\n\n---\n\n';
        }
        writeFileSync(join(ocWorkspace, 'DEV-RULES.md'), combined);
        console.log(`  + rules deployed to ~/.openclaw/workspace/DEV-RULES.md`);
      }
    }
  }

  // Deploy boot-config.json to ~/.ldm/shared/boot/
  const bootSrc = join(__dirname, '..', 'shared', 'boot');
  const bootDest = join(LDM_ROOT, 'shared', 'boot');
  if (existsSync(bootSrc)) {
    mkdirSync(bootDest, { recursive: true });
    const bootConfig = join(bootSrc, 'boot-config.json');
    if (existsSync(bootConfig)) {
      cpSync(bootConfig, join(bootDest, 'boot-config.json'));
      console.log(`  + boot-config.json deployed to ~/.ldm/shared/boot/`);
    }
  }

  // Deploy Level 1 CLAUDE.md template to ~/.claude/CLAUDE.md
  const claudeMdTemplate = join(__dirname, '..', 'shared', 'templates', 'claude-md-level1.md');
  const claudeMdDest = join(HOME, '.claude', 'CLAUDE.md');
  if (existsSync(claudeMdTemplate) && existsSync(join(HOME, '.claude'))) {
    cpSync(claudeMdTemplate, claudeMdDest);
    console.log(`  + Level 1 CLAUDE.md deployed to ~/.claude/CLAUDE.md`);
  }

  // Deploy shared templates to workspace settings/templates/
  const templatesSrc = join(__dirname, '..', 'shared', 'templates');
  if (existsSync(templatesSrc)) {
    // Read workspace path from ~/.ldm/config.json
    let workspacePath = '';
    try {
      const ldmConfig = JSON.parse(readFileSync(join(LDM_ROOT, 'config.json'), 'utf8'));
      workspacePath = (ldmConfig.workspace || '').replace('~', HOME);
    } catch {}
    if (workspacePath && existsSync(workspacePath)) {
      const templatesDest = join(workspacePath, 'settings', 'templates');
      mkdirSync(templatesDest, { recursive: true });
      let templatesCount = 0;
      for (const file of readdirSync(templatesSrc)) {
        if (file === 'claude-md-level1.md') continue; // deployed separately above
        cpSync(join(templatesSrc, file), join(templatesDest, file));
        templatesCount++;
      }
      if (templatesCount > 0) {
        console.log(`  + ${templatesCount} template(s) deployed to ${templatesDest.replace(HOME, '~')}/`);
      }
    }
  }

  // Deploy shared prompts to ~/.ldm/shared/prompts/
  const promptsSrc = join(__dirname, '..', 'shared', 'prompts');
  const promptsDest = join(LDM_ROOT, 'shared', 'prompts');
  if (existsSync(promptsSrc)) {
    mkdirSync(promptsDest, { recursive: true });
    let promptsCount = 0;
    for (const file of readdirSync(promptsSrc)) {
      if (!file.endsWith('.md')) continue;
      cpSync(join(promptsSrc, file), join(promptsDest, file));
      promptsCount++;
    }
    if (promptsCount > 0) {
      console.log(`  + ${promptsCount} shared prompts deployed to ~/.ldm/shared/prompts/`);
    }
  }

  // Detect installed harnesses (CC, OC, Codex, Cursor, Claude macOS)
  try {
    const { detectHarnesses } = await import('../lib/deploy.mjs');
    const { harnesses } = detectHarnesses();
    const detected = Object.entries(harnesses).filter(([,h]) => h.detected).map(([name]) => name);
    if (detected.length > 0) {
      console.log(`  + Harnesses detected: ${detected.join(', ')}`);
    }
  } catch {}

  // Deploy personalized docs to settings/docs/ (from templates + config.json)
  const docsSrc = join(__dirname, '..', 'shared', 'docs');
  if (existsSync(docsSrc)) {
    let workspacePath = '';
    try {
      const ldmConfig = JSON.parse(readFileSync(join(LDM_ROOT, 'config.json'), 'utf8'));
      workspacePath = (ldmConfig.workspace || '').replace('~', HOME);

      if (workspacePath && existsSync(workspacePath)) {
        const docsDest = join(workspacePath, 'settings', 'docs');
        mkdirSync(docsDest, { recursive: true });
        let docsCount = 0;

        // Build template values from ~/.ldm/config.json (unified config)
        // Legacy: settings/config.json was a separate file, now merged into config.json
        const sc = ldmConfig;
        const lc = ldmConfig;

        // Agents from settings config (rich objects with harness/machine/prefix)
        const agentsObj = sc.agents || {};
        const agentsList = Object.entries(agentsObj).map(([id, a]) => `${id} (${a.harness} on ${a.machine})`).join(', ');
        const agentsDetail = Object.entries(agentsObj).map(([id, a]) => `- **${id}**: ${a.harness} on ${a.machine}, branch prefix \`${a.prefix}/\``).join('\n');

        // Harnesses from ldm config
        const harnessConfig = lc.harnesses || {};
        const harnessesDetected = Object.entries(harnessConfig).filter(([,h]) => h.detected).map(([name]) => name);
        const harnessesList = harnessesDetected.length > 0 ? harnessesDetected.join(', ') : 'run ldm install to detect';

        const templateVars = {
          'name': sc.name || '',
          'org': sc.org || '',
          'timezone': sc.timezone || '',
          'paths.workspace': (sc.paths?.workspace || '').replace('~', HOME),
          'paths.ldm': (sc.paths?.ldm || '').replace('~', HOME),
          'paths.openclaw': (sc.paths?.openclaw || '').replace('~', HOME),
          'paths.icloud': (sc.paths?.icloud || '').replace('~', HOME),
          'memory.local': (sc.memory?.local || '').replace('~', HOME),
          'deploy.website': sc.deploy?.website || '',
          'backup.keep': String(sc.backup?.keep || 7),
          'agents_list': agentsList,
          'agents_detail': agentsDetail,
          'harnesses_list': harnessesList,
        };

        for (const file of readdirSync(docsSrc)) {
          if (!file.endsWith('.tmpl')) continue;
          let content = readFileSync(join(docsSrc, file), 'utf8');
          // Replace template vars
          content = content.replace(/\{\{([^}]+)\}\}/g, (match, key) => {
            return templateVars[key.trim()] || match;
          });
          const outName = file.replace('.tmpl', '');
          writeFileSync(join(docsDest, outName), content);
          docsCount++;
        }
        if (docsCount > 0) {
          console.log(`  + ${docsCount} personalized doc(s) deployed to ${docsDest.replace(HOME, '~')}/`);
        }
      }
    } catch {}
  }

  // Deploy LaunchAgents to ~/Library/LaunchAgents/
  // Templates use {{HOME}} and {{OPENCLAW_GATEWAY_TOKEN}} placeholders, replaced at deploy time.
  const launchSrc = join(__dirname, '..', 'shared', 'launchagents');
  const launchDest = join(HOME, 'Library', 'LaunchAgents');
  if (existsSync(launchSrc) && existsSync(launchDest)) {
    // Ensure log directory exists for LaunchAgent output
    mkdirSync(join(LDM_ROOT, 'logs'), { recursive: true });

    // Read gateway token from openclaw.json (if it exists)
    let gatewayToken = '';
    try {
      const ocConfig = JSON.parse(readFileSync(join(HOME, '.openclaw', 'openclaw.json'), 'utf8'));
      gatewayToken = ocConfig?.gateway?.auth?.token || '';
    } catch {}

    let launchCount = 0;
    let launchUpToDate = 0;
    for (const file of readdirSync(launchSrc)) {
      if (!file.endsWith('.plist')) continue;
      const src = join(launchSrc, file);
      const dest = join(launchDest, file);
      // Replace template placeholders with actual values
      let srcContent = readFileSync(src, 'utf8');
      srcContent = srcContent.replace(/\{\{HOME\}\}/g, HOME);
      srcContent = srcContent.replace(/\{\{OPENCLAW_GATEWAY_TOKEN\}\}/g, gatewayToken);
      const destContent = existsSync(dest) ? readFileSync(dest, 'utf8') : '';
      if (srcContent !== destContent) {
        // Unload old agent before overwriting
        try { execSync(`launchctl unload "${dest}" 2>/dev/null`, { stdio: 'pipe' }); } catch {}
        writeFileSync(dest, srcContent);
        try { execSync(`launchctl load "${dest}" 2>/dev/null`, { stdio: 'pipe' }); } catch {}
        const label = file.replace('.plist', '');
        console.log(`  + ${label} deployed and loaded`);
        installLog(`LaunchAgent deployed: ${file}`);
        launchCount++;
      } else {
        launchUpToDate++;
      }
    }
    if (launchCount > 0) {
      console.log(`  + ${launchCount} LaunchAgent(s) deployed to ~/Library/LaunchAgents/`);
    }
    if (launchUpToDate > 0) {
      console.log(`  - ${launchUpToDate} LaunchAgent(s) already up to date`);
    }
  }

  // Clean up dead backup triggers (#207)
  // Bug: three backup systems were competing. Only ai.openclaw.ldm-backup (3am) works.
  // The old cron entry (LDMDevTools.app) and com.wipcomputer.daily-backup are dead.
  cleanDeadBackupTriggers();

  console.log('');
  console.log(`  LDM OS v${PKG_VERSION} initialized at ${LDM_ROOT}`);
  console.log('');

  // Show catalog picker (unless --none or --dry-run)
  if (!NONE_FLAG && !DRY_RUN) {
    await showCatalogPicker();
  }
}

async function showCatalogPicker() {
  const components = loadCatalog();
  if (components.length === 0) return;

  // Check what's already installed
  const registry = readJSON(REGISTRY_PATH);
  const installed = Object.keys(registry?.extensions || {});

  const available = components.filter(c => c.status !== 'coming-soon' && !installed.includes(c.id));
  const comingSoon = components.filter(c => c.status === 'coming-soon');

  if (available.length === 0 && comingSoon.length === 0) return;

  console.log('  Available components:');
  console.log('');

  let idx = 1;
  const selectable = [];
  for (const c of available) {
    const rec = c.recommended ? ' (recommended)' : '';
    console.log(`    ${idx}. ${c.name}${rec}`);
    console.log(`       ${c.description}`);
    console.log('');
    selectable.push(c);
    idx++;
  }

  for (const c of comingSoon) {
    console.log(`    ${idx}. ${c.name} (coming soon)`);
    console.log(`       ${c.description}`);
    console.log('');
    idx++;
  }

  // If --yes, install recommended only
  if (YES_FLAG) {
    const recommended = selectable.filter(c => c.recommended);
    if (recommended.length > 0) {
      for (const c of recommended) {
        console.log(`  Installing ${c.name}...`);
        try {
          await installCatalogComponent(c);
        } catch (e) {
          console.error(`  x Failed to install ${c.name}: ${e.message}`);
        }
      }
    }
    return;
  }

  // Interactive prompt (skip if not a TTY)
  if (!process.stdin.isTTY) return;

  const { createInterface } = await import('node:readline');
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  const answer = await new Promise((resolve) => {
    rl.question('  Install components? [1,2,all,none]: ', (a) => {
      rl.close();
      resolve(a.trim().toLowerCase());
    });
  });

  if (!answer || answer === 'none' || answer === 'n') return;

  let toInstall = [];
  if (answer === 'all' || answer === 'a') {
    toInstall = selectable;
  } else {
    const nums = answer.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
    toInstall = nums.map(n => selectable[n - 1]).filter(Boolean);
  }

  for (const c of toInstall) {
    console.log('');
    console.log(`  Installing ${c.name}...`);
    try {
      await installCatalogComponent(c);
    } catch (e) {
      console.error(`  x Failed to install ${c.name}: ${e.message}`);
    }
  }
}

// ── ldm install ──

async function cmdInstall() {
  if (!DRY_RUN && !acquireInstallLock()) return;

  // Ensure LDM is initialized
  if (!existsSync(VERSION_PATH)) {
    console.log('  LDM OS not initialized. Running init first...');
    console.log('');
    cmdInit();
  }

  const { setFlags, installFromPath, installSingleTool, installToolbox, detectHarnesses } = await import('../lib/deploy.mjs');
  const { detectInterfacesJSON } = await import('../lib/detect.mjs');

  // Refresh harness detection (catches newly installed harnesses)
  detectHarnesses();

  setFlags({ dryRun: DRY_RUN, jsonOutput: JSON_OUTPUT });

  // --help flag (#81)
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
  ldm install                    Update all registered extensions + CLIs
  ldm install <org/repo>         Install from GitHub
  ldm install <npm-package>      Install from npm
  ldm install <path>             Install from local directory

  Flags:
    --dry-run    Show what would change, don't install
    --json       JSON output
    --yes        Auto-accept catalog prompts
    --none       Skip catalog prompts
`);
    process.exit(0);
  }

  // Find the target (skip flags)
  const target = args.slice(1).find(a => !a.startsWith('--'));

  if (!target) {
    // Bare `ldm install`: show catalog status + update registered
    return cmdInstallCatalog();
  }

  // If target is a private repo (org/name-private), redirect to public (#134)
  let resolvedTarget = target;
  if (target.match(/^[\w-]+\/[\w.-]+-private$/) && !existsSync(resolve(target))) {
    const publicRepo = target.replace(/-private$/, '');
    const catalogHit = findInCatalog(basename(publicRepo));
    if (catalogHit) {
      console.log(`  Redirecting ${target} to public repo: ${catalogHit.repo}`);
      resolvedTarget = catalogHit.repo;
    } else {
      console.log(`  Redirecting ${target} to public repo: ${publicRepo}`);
      resolvedTarget = publicRepo;
    }
  }

  // Check if target is a catalog ID (e.g. "memory-crystal")
  const catalogEntry = findInCatalog(resolvedTarget);
  if (catalogEntry) {
    console.log('');
    console.log(`  Resolved "${target}" via catalog to ${catalogEntry.repo}`);

    // Use the repo field to clone from GitHub
    const repoTarget = catalogEntry.repo;
    const repoName = basename(repoTarget);
    const repoPath = join(LDM_TMP, repoName);
    const httpsUrl = `https://github.com/${repoTarget}.git`;
    const sshUrl = `git@github.com:${repoTarget}.git`;

    mkdirSync(LDM_TMP, { recursive: true });
    console.log(`  Cloning ${repoTarget}...`);
    try {
      if (existsSync(repoPath)) {
        execSync(`rm -rf "${repoPath}"`, { stdio: 'pipe' });
      }
      try {
        execSync(`git clone "${httpsUrl}" "${repoPath}"`, { stdio: 'pipe' });
      } catch {
        console.log(`  HTTPS failed. Trying SSH...`);
        if (existsSync(repoPath)) execSync(`rm -rf "${repoPath}"`, { stdio: 'pipe' });
        execSync(`git clone "${sshUrl}" "${repoPath}"`, { stdio: 'pipe' });
      }
      console.log(`  + Cloned to ${repoPath}`);
    } catch (e) {
      console.error(`  x Clone failed: ${e.message}`);
      process.exit(1);
    }

    if (JSON_OUTPUT) {
      const result = detectInterfacesJSON(repoPath);
      console.log(JSON.stringify(result, null, 2));
      if (DRY_RUN) process.exit(0);
    }

    await installFromPath(repoPath);

    // Clean up staging clone after install (#32, #135)
    if (!DRY_RUN && repoPath.startsWith(LDM_TMP)) {
      try { execSync(`rm -rf "${repoPath}"`, { stdio: 'pipe' }); } catch {}
    }
    return;
  }

  // Resolve target: npm package, GitHub URL, org/repo shorthand, or local path
  let repoPath;

  // Check if target looks like an npm package (starts with @ or is a plain name without /)
  if (resolvedTarget.startsWith('@') || (!resolvedTarget.includes('/') && !existsSync(resolve(resolvedTarget)))) {
    // Try npm install to temp dir
    const npmName = resolvedTarget;
    const tempDir = join(LDM_TMP, `npm-${Date.now()}`);
    console.log('');
    console.log(`  Installing ${npmName} from npm...`);
    try {
      mkdirSync(tempDir, { recursive: true });
      execSync(`npm install ${npmName} --prefix "${tempDir}"`, { stdio: 'pipe' });
      // Find the installed package in node_modules
      const pkgName = npmName.startsWith('@') ? npmName : npmName;
      const installed = join(tempDir, 'node_modules', pkgName);
      if (existsSync(installed)) {
        console.log(`  + Installed from npm`);
        repoPath = installed;
      } else {
        console.error(`  x Package installed but not found at expected path`);
        process.exit(1);
      }
    } catch (e) {
      // npm failed, fall through to git clone or path resolution
      console.log(`  npm install failed, trying other methods...`);
      try { execSync(`rm -rf "${tempDir}"`, { stdio: 'pipe' }); } catch {}
    }
  }

  if (!repoPath && (resolvedTarget.startsWith('http') || resolvedTarget.startsWith('git@') || resolvedTarget.match(/^[\w-]+\/[\w.-]+$/))) {
    const isShorthand = resolvedTarget.match(/^[\w-]+\/[\w.-]+$/);
    const httpsUrl = isShorthand
      ? `https://github.com/${resolvedTarget}.git`
      : resolvedTarget;
    const sshUrl = isShorthand
      ? `git@github.com:${resolvedTarget}.git`
      : resolvedTarget.replace(/^https:\/\/github\.com\//, 'git@github.com:');
    const repoName = basename(httpsUrl).replace('.git', '');
    repoPath = join(LDM_TMP, repoName);

    mkdirSync(LDM_TMP, { recursive: true });
    console.log('');
    console.log(`  Cloning ${isShorthand ? resolvedTarget : httpsUrl}...`);
    try {
      if (existsSync(repoPath)) {
        execSync(`rm -rf "${repoPath}"`, { stdio: 'pipe' });
      }
      try {
        execSync(`git clone "${httpsUrl}" "${repoPath}"`, { stdio: 'pipe' });
      } catch {
        console.log(`  HTTPS failed. Trying SSH...`);
        if (existsSync(repoPath)) execSync(`rm -rf "${repoPath}"`, { stdio: 'pipe' });
        execSync(`git clone "${sshUrl}" "${repoPath}"`, { stdio: 'pipe' });
      }
      console.log(`  + Cloned to ${repoPath}`);
    } catch (e) {
      console.error(`  x Clone failed: ${e.message}`);
      process.exit(1);
    }
  } else if (!repoPath) {
    repoPath = resolve(resolvedTarget);
    if (!existsSync(repoPath)) {
      console.error(`  x Path not found: ${repoPath}`);
      process.exit(1);
    }
  }

  if (JSON_OUTPUT) {
    const result = detectInterfacesJSON(repoPath);
    console.log(JSON.stringify(result, null, 2));
    if (DRY_RUN) process.exit(0);
  }

  await installFromPath(repoPath);

  // Clean up staging clone after install (#32, #135)
  if (!DRY_RUN && repoPath.startsWith(LDM_TMP)) {
    try { execSync(`rm -rf "${repoPath}"`, { stdio: 'pipe' }); } catch {}
  }
}

// ── Auto-detect unregistered extensions ──

function autoDetectExtensions() {
  if (!existsSync(LDM_EXTENSIONS)) return;
  const registry = readJSON(REGISTRY_PATH);
  if (!registry) return;

  const registered = Object.keys(registry.extensions || {});
  let found = 0;

  try {
    const dirs = readdirSync(LDM_EXTENSIONS, { withFileTypes: true });
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      if (dir.name === '_trash' || dir.name.startsWith('.') || dir.name.startsWith('ldm-install-')) continue;

      const extPath = join(LDM_EXTENSIONS, dir.name);
      const pkgPath = join(extPath, 'package.json');
      if (!existsSync(pkgPath)) continue;

      // Check if already registered (by directory name or by ldmPath)
      const alreadyRegistered = registered.some(name => {
        const info = registry.extensions[name];
        return name === dir.name || info?.ldmPath === extPath;
      });
      if (alreadyRegistered) continue;

      // Auto-register
      const pkg = readJSON(pkgPath);
      if (!pkg) continue;

      registry.extensions[dir.name] = {
        name: dir.name,
        version: pkg.version || '?',
        source: null,
        interfaces: [],
        ldmPath: extPath,
        updatedAt: new Date().toISOString(),
        autoDetected: true,
      };
      found++;
    }
  } catch {}

  if (found > 0) {
    writeJSON(REGISTRY_PATH, registry);
  }
  return found;
}

// ── ldm install (bare): scan system, show real state, update if needed ──

async function cmdInstallCatalog() {
  // No lock here. cmdInstall() already holds it when calling this.
  installLog(`ldm install started (v${PKG_VERSION}, DRY_RUN=${DRY_RUN})`);

  // Self-update: check if CLI itself is outdated. Update first, then re-exec.
  // This breaks the chicken-and-egg: new features in ldm install are always
  // available because the installer upgrades itself before doing anything else.
  if (!DRY_RUN && !process.env.LDM_SELF_UPDATED) {
    try {
      const latest = execSync('npm view @wipcomputer/wip-ldm-os version 2>/dev/null', {
        encoding: 'utf8', timeout: 15000,
      }).trim();
      if (latest && latest !== PKG_VERSION) {
        console.log(`  LDM OS CLI v${PKG_VERSION} -> v${latest}. Updating first...`);
        try {
          execSync(`npm install -g @wipcomputer/wip-ldm-os@${latest}`, { stdio: 'inherit', timeout: 60000 });
          console.log(`  CLI updated to v${latest}. Re-running with new code...`);
          console.log('');
          // Re-exec with the new binary. LDM_SELF_UPDATED prevents infinite loop.
          // process.argv.slice(2) skips 'node' and the script path, keeps just 'install' + flags
          const reArgs = process.argv.slice(2).join(' ') || 'install';
          execSync(`LDM_SELF_UPDATED=1 ldm ${reArgs}`, { stdio: 'inherit' });
          process.exit(0);
        } catch (e) {
          console.log(`  ! Self-update failed: ${e.message}. Continuing with v${PKG_VERSION}.`);
        }
      }
    } catch {}
  }

  autoDetectExtensions();

  const { detectSystemState, reconcileState, formatReconciliation } = await import('../lib/state.mjs');
  const state = detectSystemState();
  const reconciled = reconcileState(state);

  // Check catalog: use registryMatches + cliMatches to detect what's really installed
  const registry = readJSON(REGISTRY_PATH);
  const components = loadCatalog();

  // Clean ghost entries from registry (#134, #135)
  // Run BEFORE system state display so ghosts don't appear in the installed list.
  if (registry?.extensions) {
    const names = Object.keys(registry.extensions);
    let cleaned = 0;
    for (const name of names) {
      // Remove -private duplicates (e.g. wip-xai-grok-private when wip-xai-grok exists)
      // Only public versions should be installed as extensions. Private repos are for development.
      const publicName = name.replace(/-private$/, '');
      if (name !== publicName && registry.extensions[publicName]) {
        delete registry.extensions[name];
        if (!DRY_RUN) {
          for (const base of [LDM_EXTENSIONS, join(HOME, '.openclaw', 'extensions')]) {
            const ghostDir = join(base, name);
            if (existsSync(ghostDir)) {
              const trashDir = join(LDM_TRASH, `${name}.ghost-${Date.now()}`);
              try { execSync(`mv "${ghostDir}" "${trashDir}"`, { stdio: 'pipe' }); } catch {}
            }
          }
        }
        cleaned++;
        continue;
      }
      // Fix -private path mismatch: registry says "wip-xai-x" but paths point to "wip-xai-x-private".
      // This happens when the installer cloned a public repo whose package.json had a -private name.
      // Rename the directories to match the public registry name.
      const ext = registry.extensions[name];
      if (ext && !name.endsWith('-private')) {
        const privateName = name + '-private';
        let pathFixed = false;
        for (const [pathKey, base] of [['ldmPath', LDM_EXTENSIONS], ['ocPath', join(HOME, '.openclaw', 'extensions')]]) {
          if (ext[pathKey] && ext[pathKey].endsWith(privateName)) {
            const privateDir = join(base, privateName);
            const publicDir = join(base, name);
            if (!DRY_RUN && existsSync(privateDir) && !existsSync(publicDir)) {
              try { execSync(`mv "${privateDir}" "${publicDir}"`, { stdio: 'pipe' }); } catch {}
            }
            ext[pathKey] = publicDir;
            pathFixed = true;
          }
        }
        if (pathFixed) cleaned++;
      }
      // Rename ldm-install- prefixed entries to clean names (#141)
      if (name.startsWith('ldm-install-')) {
        const cleanName = name.replace(/^ldm-install-/, '');
        // Transfer registry entry to clean name
        if (!registry.extensions[cleanName]) {
          registry.extensions[cleanName] = { ...registry.extensions[name] };
        }
        delete registry.extensions[name];
        // Rename the actual directory if it exists
        if (!DRY_RUN) {
          const ghostDir = join(LDM_EXTENSIONS, name);
          const cleanDir = join(LDM_EXTENSIONS, cleanName);
          if (existsSync(ghostDir) && !existsSync(cleanDir)) {
            try {
              execSync(`mv "${ghostDir}" "${cleanDir}"`, { stdio: 'pipe' });
            } catch {}
          } else if (existsSync(ghostDir) && existsSync(cleanDir)) {
            // Clean version exists, remove ghost
            try { execSync(`rm -rf "${ghostDir}"`, { stdio: 'pipe' }); } catch {}
          }
          // Same for OC extensions
          const ocGhost = join(HOME, '.openclaw', 'extensions', name);
          const ocClean = join(HOME, '.openclaw', 'extensions', cleanName);
          if (existsSync(ocGhost) && !existsSync(ocClean)) {
            try { execSync(`mv "${ocGhost}" "${ocClean}"`, { stdio: 'pipe' }); } catch {}
          } else if (existsSync(ocGhost) && existsSync(ocClean)) {
            try { execSync(`rm -rf "${ocGhost}"`, { stdio: 'pipe' }); } catch {}
          }
        }
        cleaned++;
      }
    }
    if (cleaned > 0 && !DRY_RUN) {
      writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2));
      installLog(`Cleaned ${cleaned} ghost registry entries`);
    }
  }

  // Clean orphaned -private directories (#132)
  // Pre-v0.4.30 installs could create -private extension dirs that linger
  // even after registry entries are cleaned. If the public name is in the
  // registry, rename the directory (or trash it if public dir already exists).
  try {
    const extDirs = readdirSync(LDM_EXTENSIONS, { withFileTypes: true })
      .filter(d => d.isDirectory() && d.name.endsWith('-private'));
    for (const d of extDirs) {
      const publicName = d.name.replace(/-private$/, '');
      // Only act if the public name is known (registry entry or catalog match)
      const inRegistry = !!registry?.extensions?.[publicName];
      const inCatalog = components.some(c =>
        c.id === publicName || (c.registryMatches || []).includes(publicName)
      );
      if (!inRegistry && !inCatalog) continue;

      const ghostDir = join(LDM_EXTENSIONS, d.name);
      const publicDir = join(LDM_EXTENSIONS, publicName);

      if (!DRY_RUN) {
        if (!existsSync(publicDir)) {
          // No public dir yet. Rename -private to public name.
          console.log(`  Renaming ghost: ${d.name} -> ${publicName}`);
          try { execSync(`mv "${ghostDir}" "${publicDir}"`, { stdio: 'pipe' }); } catch {}
        } else {
          // Public dir exists. Trash the ghost.
          console.log(`  Trashing ghost: ${d.name} (public "${publicName}" exists)`);
          const trashDir = join(LDM_EXTENSIONS, '_trash', d.name + '--' + new Date().toISOString().slice(0, 10));
          try {
            mkdirSync(join(LDM_EXTENSIONS, '_trash'), { recursive: true });
            execSync(`mv "${ghostDir}" "${trashDir}"`, { stdio: 'pipe' });
          } catch {}
        }
        // Fix registry paths that still reference the -private name
        if (registry?.extensions?.[publicName]) {
          const entry = registry.extensions[publicName];
          if (entry.ldmPath && entry.ldmPath.includes(d.name)) {
            entry.ldmPath = entry.ldmPath.replace(d.name, publicName);
          }
          if (entry.ocPath && entry.ocPath.includes(d.name)) {
            entry.ocPath = entry.ocPath.replace(d.name, publicName);
          }
          writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2));
        }
      } else {
        if (!existsSync(publicDir)) {
          console.log(`  Would rename ghost: ${d.name} -> ${publicName}`);
        } else {
          console.log(`  Would trash ghost: ${d.name} (public "${publicName}" exists)`);
        }
      }
      // Remove from reconciled so it doesn't appear in installed list or update checks
      delete reconciled[d.name];
    }
    // Same for OC extensions
    const ocExtDir = join(HOME, '.openclaw', 'extensions');
    if (existsSync(ocExtDir)) {
      const ocDirs = readdirSync(ocExtDir, { withFileTypes: true })
        .filter(d => d.isDirectory() && d.name.endsWith('-private'));
      for (const d of ocDirs) {
        const publicName = d.name.replace(/-private$/, '');
        const publicDir = join(ocExtDir, publicName);
        const ghostDir = join(ocExtDir, d.name);
        const inCatalog = components.some(c =>
          c.id === publicName || (c.registryMatches || []).includes(publicName)
        );
        if (!inCatalog) continue;
        if (!DRY_RUN) {
          if (!existsSync(publicDir)) {
            try { execSync(`mv "${ghostDir}" "${publicDir}"`, { stdio: 'pipe' }); } catch {}
          } else {
            const trashDir = join(ocExtDir, '_trash', d.name + '--' + new Date().toISOString().slice(0, 10));
            try {
              mkdirSync(join(ocExtDir, '_trash'), { recursive: true });
              execSync(`mv "${ghostDir}" "${trashDir}"`, { stdio: 'pipe' });
            } catch {}
          }
        }
        delete reconciled[d.name];
      }
    }
  } catch {}

  // Show the system state (after ghost cleanup, so ghosts don't appear)
  console.log(formatReconciliation(reconciled));

  const registeredNames = Object.keys(registry?.extensions || {});
  const reconciledNames = Object.keys(reconciled);

  function isCatalogItemInstalled(c) {
    // Direct ID match
    if (registeredNames.includes(c.id) || reconciled[c.id]) return true;
    // Check registryMatches (aliases)
    const matches = c.registryMatches || [];
    if (matches.some(m => registeredNames.includes(m) || reconciled[m])) return true;
    // Check CLI binaries
    const cliMatches = c.cliMatches || [];
    if (cliMatches.some(b => state.cliBinaries[b])) return true;
    return false;
  }

  const available = components.filter(c =>
    c.status !== 'coming-soon' && !isCatalogItemInstalled(c)
  );

  if (available.length > 0) {
    console.log('  Available in catalog (not yet installed):');
    for (const c of available) {
      console.log(`    [ ] ${c.name} ... ${c.description}`);
    }
    console.log('');
  } else {
    console.log('  All catalog components are installed.');
    console.log('');
  }

  // Build the update plan: check ALL installed extensions against npm (#55)
  const npmUpdates = [];

  // Check CLI self-update (#132)
  try {
    const cliLatest = execSync('npm view @wipcomputer/wip-ldm-os version 2>/dev/null', {
      encoding: 'utf8', timeout: 10000,
    }).trim();
    if (cliLatest && cliLatest !== PKG_VERSION) {
      npmUpdates.push({
        name: 'LDM OS CLI',
        catalogNpm: '@wipcomputer/wip-ldm-os',
        currentVersion: PKG_VERSION,
        latestVersion: cliLatest,
        hasUpdate: true,
        isCLI: true,
      });
    }
  } catch {}

  // Check every installed extension against npm via catalog
  console.log('  Checking npm for updates...');
  for (const [name, entry] of Object.entries(reconciled)) {
    if (!entry.deployedLdm && !entry.deployedOc) continue; // not installed

    // Get npm package name from the installed extension's own package.json
    const extPkgPath = join(LDM_EXTENSIONS, name, 'package.json');
    const extPkg = readJSON(extPkgPath);
    const npmPkg = extPkg?.name;
    if (!npmPkg) continue; // no package name, skip

    // Find catalog entry for the repo URL (used for clone if update needed)
    const catalogEntry = components.find(c => {
      const matches = c.registryMatches || [c.id];
      return matches.includes(name) || c.id === name;
    });

    // Skip pinned components (e.g. OpenClaw). Upgrades must be explicit.
    if (catalogEntry?.pinned) continue;

    // Fallback: use repository.url from extension's package.json (#82)
    let repoUrl = catalogEntry?.repo || null;
    if (!repoUrl && extPkg?.repository) {
      const raw = typeof extPkg.repository === 'string'
        ? extPkg.repository
        : extPkg.repository.url || '';
      const ghMatch = raw.match(/github\.com[:/]([^/]+\/[^/.]+)/);
      if (ghMatch) repoUrl = ghMatch[1];
    }

    const currentVersion = entry.ldmVersion || entry.ocVersion;
    if (!currentVersion) continue;

    try {
      const latestVersion = execSync(`npm view ${npmPkg} version 2>/dev/null`, {
        encoding: 'utf8', timeout: 10000,
      }).trim();

      if (latestVersion && latestVersion !== currentVersion) {
        npmUpdates.push({
          ...entry,
          catalogRepo: repoUrl,
          catalogNpm: npmPkg,
          currentVersion,
          latestVersion,
          hasUpdate: true,
        });
      }
    } catch {}
  }

  // Check global CLIs not tracked by extension loop (#81)
  for (const [binName, binInfo] of Object.entries(state.cliBinaries || {})) {
    const catalogComp = components.find(c =>
      (c.cliMatches || []).includes(binName)
    );
    if (!catalogComp || !catalogComp.npm) continue;
    // Skip if already covered by extension loop
    if (npmUpdates.some(e =>
      e.catalogNpm === catalogComp.npm ||
      (catalogComp.registryMatches || []).includes(e.name)
    )) continue;

    const currentVersion = binInfo.version;
    if (!currentVersion) continue;

    try {
      const latestVersion = execSync(`npm view ${catalogComp.npm} version 2>/dev/null`, {
        encoding: 'utf8', timeout: 10000,
      }).trim();
      if (latestVersion && latestVersion !== currentVersion) {
        npmUpdates.push({
          name: binName,
          catalogRepo: catalogComp.repo,
          catalogNpm: catalogComp.npm,
          currentVersion,
          latestVersion,
          hasUpdate: true,
          cliOnly: true,
        });
      }
    } catch {}
  }

  // Check parent packages for toolbox-style repos (#132)
  // If sub-tools are installed but the parent npm package has a newer version,
  // report the parent as needing an update (not the individual sub-tool).
  // Don't skip packages already found by the extension loop. The parent check
  // REPLACES sub-tool entries with the parent name.
  const checkedParentNpm = new Set();
  for (const comp of components) {
    if (!comp.npm || checkedParentNpm.has(comp.npm)) continue;
    if (!comp.registryMatches || comp.registryMatches.length === 0) continue;

    // If any registryMatch is installed, check the parent package
    const installedMatch = comp.registryMatches.find(m => reconciled[m]);
    if (!installedMatch) continue;

    const currentVersion = reconciled[installedMatch]?.ldmVersion || reconciled[installedMatch]?.ocVersion || '?';

    try {
      const latest = execSync(`npm view ${comp.npm} version 2>/dev/null`, {
        encoding: 'utf8', timeout: 10000,
      }).trim();
      if (latest && latest !== currentVersion) {
        // Remove any sub-tool entries that belong to this parent.
        // Match by name in registryMatches (sub-tools have their own npm names,
        // not the parent's, so catalogNpm comparison doesn't work).
        const parentMatches = new Set(comp.registryMatches || []);
        for (let i = npmUpdates.length - 1; i >= 0; i--) {
          if (!npmUpdates[i].isCLI && parentMatches.has(npmUpdates[i].name)) {
            npmUpdates.splice(i, 1);
          }
        }
        npmUpdates.push({
          name: comp.id,
          catalogRepo: comp.repo,
          catalogNpm: comp.npm,
          currentVersion,
          latestVersion: latest,
          hasUpdate: true,
          isParent: true,
          registryMatches: comp.registryMatches,
        });
      }
    } catch {}
    checkedParentNpm.add(comp.npm);
  }

  const totalUpdates = npmUpdates.length;

  if (DRY_RUN) {
    // Summary block (#80)
    const cliUpdate = npmUpdates.find(u => u.isCLI);

    const agentDirs = (() => {
      try {
        return readdirSync(join(LDM_ROOT, 'agents'), { withFileTypes: true })
          .filter(d => d.isDirectory() && d.name !== '_trash').map(d => d.name);
      } catch { return []; }
    })();

    const totalExtensions = Object.keys(reconciled).length;
    const majorBumps = npmUpdates.filter(e => {
      const curMajor = parseInt(e.currentVersion.split('.')[0], 10);
      const latMajor = parseInt(e.latestVersion.split('.')[0], 10);
      return latMajor > curMajor;
    });

    console.log('');
    console.log('  Summary');
    console.log('  ────────────────────────────────────');
    if (cliUpdate) {
      console.log(`  LDM OS CLI       v${PKG_VERSION}  ->  v${cliUpdate.latestVersion}`);
    } else {
      console.log(`  LDM OS CLI       v${PKG_VERSION} (latest)`);
    }
    if (npmUpdates.length > 0) {
      console.log(`  Extensions       ${totalExtensions} installed, ${npmUpdates.length} update(s)`);
    } else {
      console.log(`  Extensions       ${totalExtensions} installed, all up to date`);
    }
    for (const m of majorBumps) {
      console.log(`  Major bump       ${m.name} v${m.currentVersion} -> v${m.latestVersion}`);
    }
    if (agentDirs.length > 0) {
      console.log(`  Agents           ${agentDirs.join(', ')} (no change)`);
    }
    console.log(`  Data             crystal.db, agent files, secrets (never touched)`);

    if (npmUpdates.length > 0) {
      // Table output
      const nameW = Math.max(10, ...npmUpdates.map(e => e.name.length));
      const curW = Math.max(7, ...npmUpdates.map(e => e.currentVersion.length + 1));
      const latW = Math.max(9, ...npmUpdates.map(e => e.latestVersion.length + 1));
      const pkgW = Math.max(7, ...npmUpdates.map(e => e.catalogNpm.length));

      const pad = (s, w) => s + ' '.repeat(Math.max(0, w - s.length));
      const hr = `  ${'─'.repeat(nameW + curW + latW + pkgW + 13)}`;

      console.log('');
      console.log(`  ${npmUpdates.length} update(s) available:`);
      console.log('');
      console.log(`  ${pad('Extension', nameW)} │ ${pad('Current', curW)} │ ${pad('Available', latW)} │ ${pad('Package', pkgW)}`);
      console.log(hr);
      for (const e of npmUpdates) {
        console.log(`  ${pad(e.name, nameW)} │ ${pad('v' + e.currentVersion, curW)} │ ${pad('v' + e.latestVersion, latW)} │ ${pad(e.catalogNpm, pkgW)}`);
      }
      console.log('');
      console.log('  Old versions would be moved to ~/.ldm/_trash/ (never deleted).');
    }

    // Health check preview (dry-run)
    const healthIssues = [];

    // Check missing CLIs
    for (const comp of components) {
      if (!comp.npm || !comp.cliMatches || comp.cliMatches.length === 0) continue;
      if (!isCatalogItemInstalled(comp)) continue;
      for (const binName of comp.cliMatches) {
        try { execSync(`which ${binName} 2>/dev/null`, { encoding: 'utf8' }); }
        catch { healthIssues.push(`  ! CLI "${binName}" missing (would reinstall ${comp.npm})`); }
      }
    }

    // Check /tmp/ symlinks
    try {
      const npmPrefix = execSync('npm config get prefix', { encoding: 'utf8', timeout: 5000 }).trim();
      const globalModules = join(npmPrefix, 'lib', 'node_modules', '@wipcomputer');
      if (existsSync(globalModules)) {
        for (const entry of readdirSync(globalModules, { withFileTypes: true })) {
          if (!entry.isSymbolicLink()) continue;
          try {
            const target = readlinkSync(join(globalModules, entry.name));
            if (target.includes('/tmp/') || target.includes('/private/tmp/')) {
              healthIssues.push(`  ! @wipcomputer/${entry.name} symlinked to /tmp/ (would reinstall from npm)`);
            }
          } catch {}
        }
      }
    } catch {}

    // Check orphaned staging dirs (old /tmp/ and new ~/.ldm/tmp/)
    try {
      const tmpCount = readdirSync('/private/tmp').filter(d => d.startsWith('ldm-install-')).length;
      if (tmpCount > 0) {
        healthIssues.push(`  ! ${tmpCount} orphaned /tmp/ldm-install-* dirs (would clean up)`);
      }
    } catch {}
    try {
      if (existsSync(LDM_TMP)) {
        const ldmTmpCount = readdirSync(LDM_TMP).filter(d => d.startsWith('ldm-install-')).length;
        if (ldmTmpCount > 0) {
          healthIssues.push(`  ! ${ldmTmpCount} orphaned ~/.ldm/tmp/ldm-install-* dirs (would clean up)`);
        }
      }
    } catch {}

    if (healthIssues.length > 0) {
      console.log('');
      console.log('  Health issues (would fix on install):');
      for (const h of healthIssues) console.log(h);
    }

    console.log('');
    console.log('  Dry run complete. No changes made.');
    console.log('');
    return;
  }

  if (totalUpdates === 0 && available.length === 0) {
    console.log('  Everything is up to date.');
    console.log('');
    return;
  }

  if (totalUpdates === 0 && available.length > 0) {
    // Nothing to update, but catalog items available
    if (!YES_FLAG && !NONE_FLAG && process.stdin.isTTY) {
      const { createInterface } = await import('node:readline');
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await new Promise((resolve) => {
        rl.question('  Install from catalog? [number,all,none]: ', (a) => {
          rl.close();
          resolve(a.trim().toLowerCase());
        });
      });
      if (answer && answer !== 'none' && answer !== 'n') {
        let toInstall = [];
        if (answer === 'all' || answer === 'a') {
          toInstall = available;
        } else {
          const nums = answer.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
          toInstall = nums.map(n => available[n - 1]).filter(Boolean);
        }
        for (const c of toInstall) {
          console.log(`  Installing ${c.name}...`);
          try {
            execSync(`ldm install ${c.repo}`, { stdio: 'inherit' });
          } catch (e) {
            console.error(`  x Failed to install ${c.name}: ${e.message}`);
          }
        }
      }
    }
    return;
  }

  // Write revert manifest before starting
  const { createRevertManifest } = await import('../lib/safe.mjs');
  const manifestPath = createRevertManifest(
    `ldm install (update ${totalUpdates} extensions)`,
    npmUpdates.map(e => ({
      action: 'update-from-catalog',
      name: e.name,
      currentVersion: e.currentVersion,
      latestVersion: e.latestVersion,
      repo: e.catalogRepo,
    }))
  );
  console.log(`  Revert plan saved: ${manifestPath}`);
  console.log('');

  const { setFlags, installFromPath } = await import('../lib/deploy.mjs');
  setFlags({ dryRun: DRY_RUN, jsonOutput: JSON_OUTPUT });

  let updated = 0;

  // Update from npm via catalog repos (#55) and CLIs (#81)
  for (const entry of npmUpdates) {
    // CLI self-update is handled by the self-update block at the top of cmdInstallCatalog()
    if (entry.isCLI) continue;

    // CLI-only entries: install directly from npm (#81)
    if (entry.cliOnly) {
      console.log(`  Updating CLI ${entry.name} v${entry.currentVersion} -> v${entry.latestVersion}...`);
      try {
        execSync(`npm install -g ${entry.catalogNpm}@${entry.latestVersion}`, { stdio: 'inherit' });
        updated++;
      } catch (e) {
        console.error(`  x Failed to update CLI ${entry.name}: ${e.message}`);
      }
      continue;
    }

    if (!entry.catalogRepo) {
      console.log(`  Skipping ${entry.name}: no catalog repo (install manually with ldm install <org/repo>)`);
      continue;
    }
    console.log(`  Updating ${entry.name} v${entry.currentVersion} -> v${entry.latestVersion} (from ${entry.catalogRepo})...`);
    try {
      execSync(`ldm install ${entry.catalogRepo}`, { stdio: 'inherit' });
      updated++;

      // For parent packages, update registry version for all sub-tools (#139)
      if (entry.isParent && entry.registryMatches) {
        const registry = readJSON(REGISTRY_PATH);
        if (registry?.extensions) {
          for (const subTool of entry.registryMatches) {
            if (registry.extensions[subTool]) {
              registry.extensions[subTool].version = entry.latestVersion;
              registry.extensions[subTool].updatedAt = new Date().toISOString();
            }
          }
          writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2));
          console.log(`  + Updated registry for ${entry.registryMatches.length} sub-tools`);
        }
      }
    } catch (e) {
      console.error(`  x Failed to update ${entry.name}: ${e.message}`);
    }
  }

  // Health check: fix missing CLIs + dead symlinks (#90)
  console.log('');
  console.log('  Running health check...');
  let healthFixes = 0;

  // 1. Check catalog CLIs exist on disk
  for (const comp of components) {
    if (!comp.npm || !comp.cliMatches || comp.cliMatches.length === 0) continue;
    if (!isCatalogItemInstalled(comp)) continue;

    for (const binName of comp.cliMatches) {
      try {
        execSync(`which ${binName} 2>/dev/null`, { encoding: 'utf8' });
      } catch {
        // CLI binary missing. Reinstall from npm.
        console.log(`  ! CLI "${binName}" missing. Reinstalling ${comp.npm}...`);
        try {
          execSync(`npm install -g ${comp.npm}`, { stdio: 'inherit', timeout: 60000 });
          healthFixes++;
          console.log(`  + CLI: ${binName} restored`);
        } catch (e) {
          console.error(`  x Failed to restore ${binName}: ${e.message}`);
        }
      }
    }
  }

  // 2. Check for /tmp/ symlinks in global npm modules
  try {
    const npmPrefix = execSync('npm config get prefix', { encoding: 'utf8', timeout: 5000 }).trim();
    const globalModules = join(npmPrefix, 'lib', 'node_modules', '@wipcomputer');
    if (existsSync(globalModules)) {
      for (const entry of readdirSync(globalModules, { withFileTypes: true })) {
        if (!entry.isSymbolicLink()) continue;
        try {
          const target = readlinkSync(join(globalModules, entry.name));
          if (target.includes('/tmp/') || target.includes('/private/tmp/')) {
            const pkgName = `@wipcomputer/${entry.name}`;
            console.log(`  ! ${pkgName} symlinked to ${target} (will break on reboot). Reinstalling...`);
            try {
              execSync(`npm install -g ${pkgName}`, { stdio: 'inherit', timeout: 60000 });
              healthFixes++;
              console.log(`  + ${pkgName}: replaced /tmp/ symlink with registry install`);
            } catch (e) {
              console.error(`  x Failed to fix ${pkgName}: ${e.message}`);
            }
          }
        } catch {}
      }
    }
  } catch {}

  // 3. Clean orphaned staging dirs (old /tmp/ and new ~/.ldm/tmp/)
  try {
    const tmpDirs = readdirSync('/private/tmp').filter(d => d.startsWith('ldm-install-'));
    if (tmpDirs.length > 0) {
      console.log(`  Cleaning ${tmpDirs.length} orphaned /tmp/ldm-install-* dirs...`);
      for (const d of tmpDirs) {
        try { execSync(`rm -rf "/private/tmp/${d}"`, { stdio: 'pipe', timeout: 10000 }); } catch {}
      }
      healthFixes++;
      console.log(`  + Cleaned ${tmpDirs.length} orphaned /tmp/ clone(s)`);
    }
  } catch {}
  try {
    if (existsSync(LDM_TMP)) {
      const ldmTmpDirs = readdirSync(LDM_TMP).filter(d => d.startsWith('ldm-install-'));
      if (ldmTmpDirs.length > 0) {
        console.log(`  Cleaning ${ldmTmpDirs.length} orphaned ~/.ldm/tmp/ dirs...`);
        for (const d of ldmTmpDirs) {
          try { execSync(`rm -rf "${join(LDM_TMP, d)}"`, { stdio: 'pipe', timeout: 10000 }); } catch {}
        }
        healthFixes++;
        console.log(`  + Cleaned ${ldmTmpDirs.length} orphaned ~/.ldm/tmp/ clone(s)`);
      }
    }
  } catch {}

  if (healthFixes > 0) {
    console.log(`  ${healthFixes} health issue(s) fixed.`);
  } else {
    console.log('  All healthy.');
  }

  // Sync boot hook from npm package (#49)
  if (syncBootHook()) {
    ok('Boot hook updated (sessions, messages, updates now active)');
  }

  console.log('');
  console.log(`  Updated ${updated}/${totalUpdates} extension(s).`);
  installLog(`ldm install complete: ${updated}/${totalUpdates} updated, ${healthFixes} health fix(es)`);

  // Check if CLI itself is outdated (#29)
  checkCliVersion();

  console.log('');
}

async function cmdUpdateAll() {
  // Delegate to the catalog flow which now has full state awareness
  return cmdInstallCatalog();
}

// ── ldm doctor ──

async function cmdDoctor() {
  console.log('');
  console.log('  ldm doctor');
  console.log('  ────────────────────────────────────');

  // Auto-detect unregistered extensions before checking
  const detected = autoDetectExtensions();
  if (detected > 0) {
    console.log(`  + Auto-detected ${detected} unregistered extension(s)`);
  }

  let issues = 0;

  // 1. Check LDM root
  if (!existsSync(LDM_ROOT)) {
    console.log('  x ~/.ldm/ does not exist. Run: ldm init');
    issues++;
  } else {
    console.log('  + ~/.ldm/ exists');
  }

  // 2. Check version.json
  const version = readJSON(VERSION_PATH);
  if (!version) {
    console.log('  x version.json missing. Run: ldm init');
    issues++;
  } else {
    console.log(`  + version.json: v${version.version} (installed ${version.installed?.split('T')[0]})`);
  }

  // 3. Full system state scan
  const { detectSystemState, reconcileState, formatReconciliation } = await import('../lib/state.mjs');
  const state = detectSystemState();
  const reconciled = reconcileState(state);

  // Show reconciled view
  console.log(formatReconciliation(reconciled, { verbose: true }));

  // Count issues from reconciliation
  const registeredMissing = [];
  for (const [name, entry] of Object.entries(reconciled)) {
    if (entry.status === 'registered-missing') {
      issues++;
      registeredMissing.push(name);
    }
    if (entry.issues.length > 0 && entry.status !== 'installed-unlinked' && entry.status !== 'external') {
      issues += entry.issues.length;
    }
  }

  // --fix: clean up registered-missing entries
  if (FIX_FLAG && registeredMissing.length > 0) {
    const registry = readJSON(REGISTRY_PATH);
    if (registry?.extensions) {
      for (const name of registeredMissing) {
        delete registry.extensions[name];
        console.log(`  + Removed stale registry entry: ${name}`);
        issues--;
      }
      writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2) + '\n');
    }
  }

  // --fix: clean stale hook paths in settings.json (#30)
  if (FIX_FLAG) {
    const hooksCleaned = cleanStaleHooks();
    if (hooksCleaned > 0) {
      issues = Math.max(0, issues - hooksCleaned);
    }
  }

  // --fix: clean registry entries with /tmp/ sources or ldm-install- names (#54)
  if (FIX_FLAG) {
    const registry = readJSON(REGISTRY_PATH);
    if (registry?.extensions) {
      const staleNames = [];
      for (const [name, info] of Object.entries(registry.extensions)) {
        const src = info?.source || '';
        const isTmpSource = src.startsWith('/tmp/') || src.startsWith('/private/tmp/');
        const isTmpName = name.startsWith('ldm-install-');
        if (isTmpSource || isTmpName) {
          staleNames.push(name);
        }
      }
      for (const name of staleNames) {
        delete registry.extensions[name];
        console.log(`  + Removed stale registry entry: ${name} (/tmp/ clone)`);
        issues = Math.max(0, issues - 1);
      }
      if (staleNames.length > 0) {
        writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2) + '\n');
      }
    }
  }

  // --fix: clean stale MCP entries from ~/.claude.json (tmp paths, ldm-install- names)
  if (FIX_FLAG) {
    const ccUserPath = join(HOME, '.claude.json');
    const ccUser = readJSON(ccUserPath);
    if (ccUser?.mcpServers) {
      const staleMcp = [];
      for (const [name, cfg] of Object.entries(ccUser.mcpServers)) {
        const args = cfg.args || [];
        const isTmpPath = args.some(a => a.startsWith('/tmp/') || a.startsWith('/private/tmp/'));
        const isTmpName = name.startsWith('ldm-install-') || name.startsWith('wip-install-');
        if (isTmpPath || isTmpName) staleMcp.push(name);
      }
      for (const name of staleMcp) {
        delete ccUser.mcpServers[name];
        console.log(`  + Removed stale MCP: ${name}`);
        issues = Math.max(0, issues - 1);
      }
      if (staleMcp.length > 0) {
        writeFileSync(ccUserPath, JSON.stringify(ccUser, null, 2) + '\n');
      }
    }
  }

  // 4. Check sacred locations
  const sacred = [
    { path: join(LDM_ROOT, 'memory'), label: 'memory/' },
    { path: join(LDM_ROOT, 'agents'), label: 'agents/' },
    { path: join(LDM_ROOT, 'state'), label: 'state/' },
    { path: join(LDM_ROOT, 'sessions'), label: 'sessions/' },
    { path: join(LDM_ROOT, 'messages'), label: 'messages/' },
  ];

  for (const s of sacred) {
    if (existsSync(s.path)) {
      console.log(`  + ${s.label} exists`);
    } else {
      console.log(`  ! ${s.label} missing (run: ldm init)`);
      issues++;
    }
  }

  // 5. Check settings.json for hooks
  const settingsPath = join(HOME, '.claude', 'settings.json');
  const settings = readJSON(settingsPath);
  if (settings?.hooks) {
    const hookCount = Object.values(settings.hooks).reduce((sum, arr) => sum + (arr?.length || 0), 0);
    console.log(`  + Claude Code hooks: ${hookCount} configured`);

    // Check for stale hook paths
    let staleHooks = 0;
    for (const [event, hookGroups] of Object.entries(settings.hooks)) {
      if (!Array.isArray(hookGroups)) continue;
      for (const group of hookGroups) {
        for (const h of (group.hooks || [])) {
          if (!h.command) continue;
          const match = h.command.match(/node\s+"?([^"]+)"?\s*$/);
          if (!match) continue;
          const hookPath = match[1];
          const isTmpPath = hookPath.startsWith('/tmp/') || hookPath.startsWith('/private/tmp/');
          if (!existsSync(hookPath) || isTmpPath) {
            staleHooks++;
            if (!FIX_FLAG) {
              const reason = isTmpPath ? '(temp path)' : '(missing)';
              console.log(`  ! Stale hook: ${event} -> ${hookPath} ${reason}`);
            }
          }
        }
      }
    }
    if (staleHooks > 0 && !FIX_FLAG) {
      console.log(`    Run: ldm doctor --fix to clean ${staleHooks} stale hook(s)`);
      issues += staleHooks;
    }
  } else {
    console.log(`  - Claude Code hooks: none configured`);
  }

  // 6. MCP servers
  const mcpCount = Object.keys(state.mcp).length;
  console.log(`  + MCP servers: ${mcpCount} registered`);

  // 7. CLI binaries
  const binCount = Object.keys(state.cliBinaries).length;
  if (binCount > 0) {
    console.log(`  + CLI binaries: ${Object.keys(state.cliBinaries).join(', ')}`);
  }

  // 8. LaunchAgents health check
  const managedAgents = [
    'ai.openclaw.ldm-backup',
    'ai.openclaw.healthcheck',
    'ai.openclaw.gateway',
  ];
  const launchAgentsDir = join(HOME, 'Library', 'LaunchAgents');
  const launchAgentsSrc = join(__dirname, '..', 'shared', 'launchagents');

  // Read gateway token for template comparison
  let doctorGatewayToken = '';
  try {
    const ocConfig = JSON.parse(readFileSync(join(HOME, '.openclaw', 'openclaw.json'), 'utf8'));
    doctorGatewayToken = ocConfig?.gateway?.auth?.token || '';
  } catch {}

  let launchOk = 0;
  let launchIssues = 0;
  for (const label of managedAgents) {
    const plistFile = `${label}.plist`;
    const deployedPath = join(launchAgentsDir, plistFile);
    const srcPath = join(launchAgentsSrc, plistFile);

    if (!existsSync(deployedPath)) {
      console.log(`  x LaunchAgent ${label}: plist missing from ~/Library/LaunchAgents/`);
      launchIssues++;
      continue;
    }

    // Check if deployed plist matches source template (after placeholder substitution)
    if (existsSync(srcPath)) {
      let srcContent = readFileSync(srcPath, 'utf8');
      srcContent = srcContent.replace(/\{\{HOME\}\}/g, HOME);
      srcContent = srcContent.replace(/\{\{OPENCLAW_GATEWAY_TOKEN\}\}/g, doctorGatewayToken);
      const deployedContent = readFileSync(deployedPath, 'utf8');
      if (srcContent !== deployedContent) {
        console.log(`  ! LaunchAgent ${label}: plist out of date (run: ldm install)`);
        launchIssues++;
        continue;
      }
    }

    // Check if loaded via launchctl
    try {
      const result = execSync(`launchctl list 2>/dev/null | grep "${label}"`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
      if (result.trim()) {
        launchOk++;
      } else {
        console.log(`  ! LaunchAgent ${label}: plist exists but not loaded`);
        launchIssues++;
      }
    } catch {
      console.log(`  ! LaunchAgent ${label}: plist exists but not loaded`);
      launchIssues++;
    }
  }
  if (launchOk > 0) {
    console.log(`  + LaunchAgents: ${launchOk}/${managedAgents.length} loaded`);
  }
  if (launchIssues > 0) {
    issues += launchIssues;
  }

  console.log('');
  if (issues === 0) {
    console.log('  All checks passed.');
  } else {
    console.log(`  ${issues} issue(s) found.`);
  }
  console.log('');
}

// ── ldm status ──

function cmdStatus() {
  const version = readJSON(VERSION_PATH);
  const registry = readJSON(REGISTRY_PATH);
  const extCount = Object.keys(registry?.extensions || {}).length;

  if (JSON_OUTPUT) {
    console.log(JSON.stringify({
      version: version?.version || null,
      installed: version?.installed || null,
      updated: version?.updated || null,
      extensions: extCount,
      ldmRoot: LDM_ROOT,
    }, null, 2));
    return;
  }

  if (!version) {
    console.log('  LDM OS not installed. Run: ldm init');
    return;
  }

  // Check CLI version against npm
  let cliUpdate = null;
  try {
    const latest = execSync('npm view @wipcomputer/wip-ldm-os version 2>/dev/null', {
      encoding: 'utf8', timeout: 10000,
    }).trim();
    if (latest && latest !== PKG_VERSION) cliUpdate = latest;
  } catch {}

  // Check extensions against npm
  const updates = [];
  for (const [name, info] of Object.entries(registry?.extensions || {})) {
    const extPkgPath = join(LDM_EXTENSIONS, name, 'package.json');
    const extPkg = readJSON(extPkgPath);
    const npmPkg = extPkg?.name;
    if (!npmPkg) continue;
    const currentVersion = extPkg.version || info.version;
    if (!currentVersion) continue;
    try {
      const latest = execSync(`npm view ${npmPkg} version 2>/dev/null`, {
        encoding: 'utf8', timeout: 10000,
      }).trim();
      if (latest && latest !== currentVersion) {
        updates.push({ name, current: currentVersion, latest, npm: npmPkg });
      }
    } catch {}
  }

  console.log('');
  console.log(`  LDM OS v${version.version}${cliUpdate ? ` (v${cliUpdate} available)` : ' (latest)'}`);
  console.log(`  Installed: ${version.installed?.split('T')[0]}`);
  console.log(`  Updated:   ${version.updated?.split('T')[0]}`);
  console.log(`  Extensions: ${extCount}${updates.length > 0 ? `, ${updates.length} update(s) available` : ', all up to date'}`);
  console.log(`  Root: ${LDM_ROOT}`);

  if (updates.length > 0) {
    console.log('');
    console.log('  Updates available:');
    for (const u of updates) {
      console.log(`    ${u.name}: v${u.current} -> v${u.latest} (${u.npm})`);
    }
    console.log('');
    console.log('  Run: ldm install');
  }

  if (cliUpdate) {
    console.log(`  CLI update: npm install -g @wipcomputer/wip-ldm-os@${cliUpdate}`);
  }

  console.log('');
}

// ── ldm sessions ──

// ── ldm backup ──

async function cmdBackup() {
  const BACKUP_SCRIPT = join(LDM_ROOT, 'bin', 'ldm-backup.sh');

  if (!existsSync(BACKUP_SCRIPT)) {
    console.error('  x Backup script not found at ' + BACKUP_SCRIPT);
    console.error('  Run: ldm install (deploys the backup script)');
    process.exit(1);
  }

  const backupArgs = [];
  if (DRY_RUN) backupArgs.push('--dry-run');

  // --full is explicit but currently all backups are full (incrementals are Phase 2)
  // Accept it as a no-op so the command reads naturally: ldm backup --full
  const FULL_FLAG = args.includes('--full');

  // --keep N: pass through to backup script
  const keepIndex = args.indexOf('--keep');
  if (keepIndex !== -1 && args[keepIndex + 1]) {
    backupArgs.push('--keep', args[keepIndex + 1]);
  }

  // --pin: mark the latest backup to skip rotation
  const pinIndex = args.indexOf('--pin');
  if (pinIndex !== -1) {
    const reason = args[pinIndex + 1] || 'pinned';
    // Find latest backup dir
    const backupRoot = join(LDM_ROOT, 'backups');
    let dirs = [];
    try {
      dirs = readdirSync(backupRoot)
        .filter(d => d.match(/^20\d\d-\d\d-\d\d--/))
        .sort()
        .reverse();
    } catch {}
    if (dirs.length === 0) {
      console.error('  x No backups found to pin.');
      process.exit(1);
    }
    const latest = dirs[0];
    const pinFile = join(backupRoot, latest, '.pinned');
    writeFileSync(pinFile, `Pinned: ${reason}\nDate: ${new Date().toISOString()}\n`);
    console.log(`  + Pinned backup ${latest}: ${reason}`);
    console.log('  This backup will be skipped during rotation.');
    return;
  }

  // --unpin: remove .pinned marker from the latest (or specified) backup
  const unpinIndex = args.indexOf('--unpin');
  if (unpinIndex !== -1) {
    const backupRoot = join(LDM_ROOT, 'backups');
    let dirs = [];
    try {
      dirs = readdirSync(backupRoot)
        .filter(d => d.match(/^20\d\d-\d\d-\d\d--/))
        .sort()
        .reverse();
    } catch {}
    // Find first pinned backup
    let unpinned = false;
    for (const d of dirs) {
      const pinFile = join(backupRoot, d, '.pinned');
      if (existsSync(pinFile)) {
        unlinkSync(pinFile);
        console.log(`  - Unpinned backup ${d}`);
        unpinned = true;
        break;
      }
    }
    if (!unpinned) {
      console.log('  No pinned backups found.');
    }
    return;
  }

  // --list: show existing backups with pinned status
  const LIST_FLAG = args.includes('--list');
  if (LIST_FLAG) {
    const backupRoot = join(LDM_ROOT, 'backups');
    let dirs = [];
    try {
      dirs = readdirSync(backupRoot)
        .filter(d => d.match(/^20\d\d-\d\d-\d\d--/))
        .sort()
        .reverse();
    } catch {}
    if (dirs.length === 0) {
      console.log('  No backups found.');
      return;
    }
    console.log('');
    console.log('  Backups:');
    for (const d of dirs) {
      const pinFile = join(backupRoot, d, '.pinned');
      const pinned = existsSync(pinFile);
      let size = '?';
      try {
        size = execSync(`du -sh "${join(backupRoot, d)}" | cut -f1`, { encoding: 'utf8', timeout: 10000 }).trim();
      } catch {}
      const marker = pinned ? ' [pinned]' : '';
      console.log(`  ${d}  ${size}${marker}`);
    }
    console.log('');
    return;
  }

  if (FULL_FLAG) {
    console.log('  Running full backup...');
  } else {
    console.log('  Running backup...');
  }
  console.log('');
  try {
    execSync(`bash "${BACKUP_SCRIPT}" ${backupArgs.join(' ')}`, {
      stdio: 'inherit',
      timeout: 600000,
    });
  } catch (e) {
    console.error('  x Backup failed: ' + e.message);
    process.exit(1);
  }
}

// ── ldm sessions ──

async function cmdSessions() {
  const { listSessions } = await import('../lib/sessions.mjs');
  const sessions = listSessions({ includeStale: CLEANUP_FLAG });

  if (CLEANUP_FLAG) {
    // listSessions already cleans stale when includeStale is false.
    // With --cleanup, we list stale ones so user can see them, then re-run without stale.
    const stale = sessions.filter(s => !s.alive);
    if (stale.length > 0) {
      const { deregisterSession } = await import('../lib/sessions.mjs');
      for (const s of stale) {
        deregisterSession(s.name);
      }
      console.log(`  Cleaned ${stale.length} stale session(s).`);
    } else {
      console.log('  No stale sessions found.');
    }
    console.log('');
    return;
  }

  const live = sessions.filter(s => s.alive);

  if (JSON_OUTPUT) {
    console.log(JSON.stringify(live, null, 2));
    return;
  }

  console.log('');
  console.log('  Active Sessions');
  console.log('  ────────────────────────────────────');

  if (live.length === 0) {
    console.log('  No active sessions.');
  } else {
    for (const s of live) {
      const age = timeSince(s.startTime);
      console.log(`  ${s.name}  agent=${s.agentId}  pid=${s.pid}  up=${age}`);
    }
  }

  console.log('');
}

function timeSince(isoString) {
  try {
    const ms = Date.now() - new Date(isoString).getTime();
    const secs = Math.floor(ms / 1000);
    if (secs < 60) return `${secs}s`;
    const mins = Math.floor(secs / 60);
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ${mins % 60}m`;
    const days = Math.floor(hours / 24);
    return `${days}d ${hours % 24}h`;
  } catch {
    return '?';
  }
}

// ── ldm msg ──

async function cmdMsg() {
  const subcommand = args[1];

  if (!subcommand || subcommand === 'list') {
    return cmdMsgList();
  }
  if (subcommand === 'send') {
    return cmdMsgSend();
  }
  if (subcommand === 'broadcast') {
    return cmdMsgBroadcast();
  }

  console.error(`  Unknown msg subcommand: ${subcommand}`);
  console.error('  Usage: ldm msg [send <to> <body> | list | broadcast <body>]');
  process.exit(1);
}

async function cmdMsgList() {
  const { readMessages } = await import('../lib/messages.mjs');
  const sessionName = process.env.CLAUDE_SESSION_NAME || 'unknown';
  const messages = readMessages(sessionName, { markRead: false });

  if (JSON_OUTPUT) {
    console.log(JSON.stringify(messages, null, 2));
    return;
  }

  console.log('');
  console.log(`  Messages for "${sessionName}"`);
  console.log('  ────────────────────────────────────');

  if (messages.length === 0) {
    console.log('  No pending messages.');
  } else {
    for (const m of messages) {
      const ts = m.timestamp?.split('T')[1]?.split('.')[0] || '';
      console.log(`  [${m.type}] ${ts} from=${m.from}: ${m.body}`);
    }
  }

  console.log('');
}

async function cmdMsgSend() {
  const { sendMessage } = await import('../lib/messages.mjs');
  // args: ['msg', 'send', '<to>', '<body...>']
  const to = args[2];
  const body = args.slice(3).filter(a => !a.startsWith('--')).join(' ');

  if (!to || !body) {
    console.error('  Usage: ldm msg send <to> <body>');
    process.exit(1);
  }

  const sessionName = process.env.CLAUDE_SESSION_NAME || 'ldm-cli';
  const id = sendMessage({ from: sessionName, to, body, type: 'chat' });

  if (id) {
    console.log(`  Message sent to "${to}" (id: ${id})`);
  } else {
    console.error('  x Failed to send message.');
    process.exit(1);
  }
}

async function cmdMsgBroadcast() {
  const { sendMessage } = await import('../lib/messages.mjs');
  // args: ['msg', 'broadcast', '<body...>']
  const body = args.slice(2).filter(a => !a.startsWith('--')).join(' ');

  if (!body) {
    console.error('  Usage: ldm msg broadcast <body>');
    process.exit(1);
  }

  const sessionName = process.env.CLAUDE_SESSION_NAME || 'ldm-cli';
  const id = sendMessage({ from: sessionName, to: 'all', body, type: 'chat' });

  if (id) {
    console.log(`  Broadcast sent (id: ${id})`);
  } else {
    console.error('  x Failed to send broadcast.');
    process.exit(1);
  }
}

// ── ldm updates ──

async function cmdUpdates() {
  if (CHECK_FLAG) {
    // Re-check npm registry
    const { checkForUpdates } = await import('../lib/updates.mjs');
    console.log('  Checking npm for updates...');
    console.log('');
    const result = checkForUpdates();

    if (JSON_OUTPUT) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (result.updatesAvailable === 0) {
      console.log(`  Checked ${result.checked} extensions. Everything is up to date.`);
    } else {
      console.log(`  Checked ${result.checked} extensions. ${result.updatesAvailable} update(s) available:`);
      console.log('');
      for (const u of result.updates) {
        console.log(`    ${u.name}: ${u.currentVersion} -> ${u.latestVersion} (${u.packageName})`);
      }
      console.log('');
      console.log('  Run: ldm install');
    }
    console.log('');
    return;
  }

  // Show cached results
  const { readUpdateManifest } = await import('../lib/updates.mjs');
  const manifest = readUpdateManifest();

  if (JSON_OUTPUT) {
    console.log(JSON.stringify(manifest || {}, null, 2));
    return;
  }

  console.log('');
  console.log('  Available Updates');
  console.log('  ────────────────────────────────────');

  if (!manifest) {
    console.log('  No update check has been run yet.');
    console.log('  Run: ldm updates --check');
  } else if (manifest.updatesAvailable === 0) {
    console.log(`  Everything is up to date. (checked ${manifest.checkedAt?.split('T')[0] || 'unknown'})`);
  } else {
    console.log(`  ${manifest.updatesAvailable} update(s) available (checked ${manifest.checkedAt?.split('T')[0] || 'unknown'}):`);
    console.log('');
    for (const u of manifest.updates) {
      console.log(`    ${u.name}: ${u.currentVersion} -> ${u.latestVersion}`);
    }
    console.log('');
    console.log('  Run: ldm install');
  }

  console.log('');
}

// ── ldm stack ──

async function cmdStack() {
  const subcommand = args[1];

  if (!subcommand || subcommand === 'list') {
    return cmdStackList();
  }
  if (subcommand === 'install') {
    return cmdStackInstall();
  }

  console.error(`  Unknown stack subcommand: ${subcommand}`);
  console.error('  Usage: ldm stack [list | install <name>]');
  process.exit(1);
}

function loadStacks() {
  return CATALOG.stacks || {};
}

function resolveStack(name) {
  const stacks = loadStacks();
  const stack = stacks[name];
  if (!stack) return null;

  // Resolve "includes" (compose stacks from other stacks)
  let components = [...(stack.components || [])];
  let mcpServers = [...(stack.mcpServers || [])];

  if (stack.includes) {
    for (const inc of stack.includes) {
      const sub = stacks[inc];
      if (sub) {
        components = [...(sub.components || []), ...components];
        mcpServers = [...(sub.mcpServers || []), ...mcpServers];
      }
    }
  }

  // Deduplicate
  components = [...new Set(components)];
  const seenMcp = new Set();
  mcpServers = mcpServers.filter(m => {
    if (seenMcp.has(m.name)) return false;
    seenMcp.add(m.name);
    return true;
  });

  return { ...stack, components, mcpServers };
}

function cmdStackList() {
  const stacks = loadStacks();

  console.log('');
  console.log('  Available Stacks');
  console.log('  ────────────────────────────────────');

  if (Object.keys(stacks).length === 0) {
    console.log('  No stacks defined in catalog.');
    console.log('');
    return;
  }

  for (const [id, stack] of Object.entries(stacks)) {
    const resolved = resolveStack(id);
    console.log(`  ${id}: ${stack.name}`);
    console.log(`    ${stack.description}`);
    if (resolved.components.length > 0) {
      console.log(`    Components:`);
      for (const compId of resolved.components) {
        const entry = findInCatalog(compId);
        console.log(`      - ${entry?.name || compId}`);
      }
    }
    if (resolved.mcpServers.length > 0) {
      console.log(`    MCP Servers:`);
      for (const mcp of resolved.mcpServers) {
        console.log(`      - ${mcp.name}`);
      }
    }
    console.log('');
  }

  console.log('  Install: ldm stack install <name>');
  console.log('  Preview: ldm stack install <name> --dry-run');
  console.log('');
}

async function cmdStackInstall() {
  const stackName = args.slice(2).find(a => !a.startsWith('--'));

  if (!stackName) {
    console.error('  Usage: ldm stack install <name> [--dry-run]');
    console.error('  Run: ldm stack list');
    process.exit(1);
  }

  const stack = resolveStack(stackName);
  if (!stack) {
    console.error(`  Unknown stack: "${stackName}"`);
    console.error('  Run: ldm stack list');
    process.exit(1);
  }

  console.log('');
  console.log(`  Stack: ${stack.name}`);
  console.log(`  ────────────────────────────────────`);
  console.log(`  ${stack.description}`);
  console.log('');

  // Check what's already installed
  const registry = readJSON(REGISTRY_PATH);
  const registeredNames = Object.keys(registry?.extensions || {});

  const ccUserPath = join(HOME, '.claude.json');
  const ccUser = readJSON(ccUserPath);
  const registeredMcp = Object.keys(ccUser?.mcpServers || {});

  // Components
  const componentsToInstall = [];
  const componentsInstalled = [];
  for (const compId of stack.components) {
    const entry = findInCatalog(compId);
    if (!entry) continue;

    // Check if already installed
    const matches = entry.registryMatches || [compId];
    const installed = matches.some(m => registeredNames.includes(m));
    if (installed) {
      componentsInstalled.push(entry);
    } else {
      componentsToInstall.push(entry);
    }
  }

  // MCP servers
  const mcpToInstall = [];
  const mcpInstalled = [];
  for (const mcp of stack.mcpServers) {
    if (registeredMcp.includes(mcp.name)) {
      mcpInstalled.push(mcp);
    } else {
      mcpToInstall.push(mcp);
    }
  }

  // Show status
  if (componentsInstalled.length > 0) {
    console.log(`  Already installed (${componentsInstalled.length}):`);
    for (const c of componentsInstalled) {
      console.log(`    [x] ${c.name}`);
    }
    console.log('');
  }

  if (mcpInstalled.length > 0) {
    console.log(`  MCP servers already registered (${mcpInstalled.length}):`);
    for (const m of mcpInstalled) {
      console.log(`    [x] ${m.name}`);
    }
    console.log('');
  }

  if (componentsToInstall.length > 0) {
    console.log(`  Components to install (${componentsToInstall.length}):`);
    for (const c of componentsToInstall) {
      console.log(`    [ ] ${c.name} (${c.repo})`);
    }
    console.log('');
  }

  if (mcpToInstall.length > 0) {
    console.log(`  MCP servers to add (${mcpToInstall.length}):`);
    for (const m of mcpToInstall) {
      console.log(`    [ ] ${m.name} (${m.command} ${m.args.join(' ')})`);
    }
    console.log('');
  }

  if (componentsToInstall.length === 0 && mcpToInstall.length === 0) {
    console.log('  Everything in this stack is already installed.');
    console.log('');
    return;
  }

  if (DRY_RUN) {
    console.log(`  Would install ${componentsToInstall.length} component(s) and ${mcpToInstall.length} MCP server(s).`);
    console.log('  Dry run complete. No changes made.');
    console.log('');
    return;
  }

  // Install components via ldm install
  let installed = 0;
  for (const c of componentsToInstall) {
    console.log(`  Installing ${c.name}...`);
    try {
      execSync(`ldm install ${c.repo}`, { stdio: 'inherit' });
      installed++;
    } catch (e) {
      console.error(`  x Failed to install ${c.name}: ${e.message}`);
    }
  }

  // Register MCP servers
  let mcpAdded = 0;
  for (const mcp of mcpToInstall) {
    console.log(`  Adding MCP: ${mcp.name}...`);
    try {
      const mcpArgs = mcp.args.map(a => `"${a}"`).join(' ');
      execSync(`claude mcp add --scope user ${mcp.name} -- ${mcp.command} ${mcpArgs}`, { stdio: 'pipe' });
      console.log(`  + MCP: ${mcp.name} registered (user scope)`);
      mcpAdded++;
    } catch (e) {
      // Fallback: write directly to ~/.claude.json
      try {
        const config = readJSON(ccUserPath) || {};
        if (!config.mcpServers) config.mcpServers = {};
        config.mcpServers[mcp.name] = {
          command: mcp.command,
          args: mcp.args,
        };
        writeJSON(ccUserPath, config);
        console.log(`  + MCP: ${mcp.name} registered in ~/.claude.json (fallback)`);
        mcpAdded++;
      } catch (e2) {
        console.error(`  x MCP: ${mcp.name} failed: ${e2.message}`);
      }
    }
  }

  console.log('');
  console.log(`  Done. ${installed} component(s) installed, ${mcpAdded} MCP server(s) added.`);
  console.log('  Restart your session to load new MCP servers.');
  console.log('');
}

// ── ldm catalog show ──

function cmdCatalogShow() {
  const subcommand = args[1];
  const target = args[2];

  if (subcommand === 'show' && target) {
    const entry = loadCatalog().find(c => c.id === target || c.name.toLowerCase() === target.toLowerCase());
    if (!entry) {
      console.error(`  Unknown component: "${target}"`);
      console.error('  Run: ldm catalog');
      process.exit(1);
    }

    console.log('');
    console.log(`  ${entry.name}`);
    console.log('  ────────────────────────────────────');
    console.log(`  ${entry.description}`);
    console.log('');
    console.log(`  Status: ${entry.status}`);
    if (entry.repo) console.log(`  Repo: github.com/${entry.repo}`);
    if (entry.npm) console.log(`  npm: ${entry.npm}`);

    const inst = entry.installs;
    if (inst) {
      console.log('');
      console.log('  What gets installed:');
      if (inst.cli) console.log(`    CLI: ${Array.isArray(inst.cli) ? inst.cli.join(', ') : inst.cli}`);
      if (inst.mcp) console.log(`    MCP tools: ${Array.isArray(inst.mcp) ? inst.mcp.join(', ') : inst.mcp}`);
      if (inst.ocPlugin) console.log(`    OpenClaw plugin: ${inst.ocPlugin}`);
      if (inst.ccHook) console.log(`    CC hooks: ${inst.ccHook}`);
      if (inst.cron) console.log(`    Cron: ${inst.cron}`);
      if (inst.data) console.log(`    Data: ${inst.data}`);
      if (inst.tools) console.log(`    Tools: ${inst.tools}`);
      if (inst.web) console.log(`    Web: ${inst.web}`);
      if (inst.runtime) console.log(`    Runtime: ${inst.runtime}`);
      if (inst.plugins) console.log(`    Plugins: ${inst.plugins}`);
      if (inst.skill) console.log(`    Skill: ${inst.skill}`);
      if (inst.docs) console.log(`    Docs: ${inst.docs}`);
      if (inst.note) console.log(`    Note: ${inst.note}`);
    }

    console.log('');
    return;
  }

  // Default: list all catalog items
  const components = loadCatalog();
  console.log('');
  console.log('  Catalog');
  console.log('  ────────────────────────────────────');
  for (const c of components) {
    console.log(`  ${c.id}: ${c.name} (${c.status})`);
    console.log(`    ${c.description}`);
    console.log('');
  }
  console.log('  Show details: ldm catalog show <name>');
  console.log('');
}

// ── Main ──

async function main() {
  if (!command || command === '--help' || command === '-h') {
    console.log('');
    console.log('  ldm ... LDM OS kernel');
    console.log('');
    console.log('  Usage:');
    console.log('    ldm init                    Scaffold ~/.ldm/ and write version.json');
    console.log('    ldm install <org/repo>      Install from GitHub (clones, detects, deploys)');
    console.log('    ldm install /path/to/repo   Install from local path');
    console.log('    ldm install                 Update all registered extensions');
    console.log('    ldm doctor                  Check health of all extensions');
    console.log('    ldm status                  Show version and extension list');
    console.log('    ldm sessions                List active sessions');
    console.log('    ldm sessions --cleanup      Remove stale session entries');
    console.log('    ldm msg send <to> <body>    Send a message to a session');
    console.log('    ldm msg list                List pending messages');
    console.log('    ldm msg broadcast <body>    Send to all sessions');
    console.log('    ldm stack list               Show available stacks');
    console.log('    ldm stack install <name>     Install a stack (core, web, all)');
    console.log('    ldm backup                  Run a full backup now');
    console.log('    ldm backup --dry-run        Preview what would be backed up (with sizes)');
    console.log('    ldm backup --keep N         Keep last N backups (default: 7)');
    console.log('    ldm backup --pin "reason"   Pin latest backup so rotation skips it');
    console.log('    ldm updates                 Show available updates from cache');
    console.log('    ldm updates --check         Re-check npm registry for updates');
    console.log('');
    console.log('  Flags:');
    console.log('    --dry-run   Show what would happen without making changes');
    console.log('    --json      Output results as JSON');
    console.log('    --cleanup   Remove stale entries (sessions)');
    console.log('    --check     Re-check registry (updates)');
    console.log('');
    console.log('  Interfaces detected:');
    console.log('    CLI        ... package.json bin -> npm install -g');
    console.log('    Module     ... ESM main/exports -> importable');
    console.log('    MCP Server ... mcp-server.mjs -> claude mcp add --scope user');
    console.log('    OpenClaw   ... openclaw.plugin.json -> ~/.ldm/extensions/ + ~/.openclaw/extensions/');
    console.log('    Skill      ... SKILL.md -> ~/.openclaw/skills/<tool>/');
    console.log('    CC Hook    ... guard.mjs or claudeCode.hook -> ~/.claude/settings.json');
    console.log('');
    console.log(`  v${PKG_VERSION}`);
    console.log('');
    process.exit(0);
  }

  // ── ldm enable / disable (#111) ──

  async function cmdEnable() {
    const target = args.slice(1).find(a => !a.startsWith('--'));
    if (!target) {
      console.log('  Usage: ldm enable <extension|stack>');
      console.log('  Example: ldm enable devops-toolbox');
      console.log('  Stacks: core, web, all');
      process.exit(1);
    }

    const { enableExtension } = await import('../lib/deploy.mjs');
    const stacks = loadCatalog()?.stacks || {};
    const components = loadCatalog()?.components || [];

    // Resolve stack to component list
    let names = [target];
    if (stacks[target]) {
      const stack = stacks[target];
      names = stack.components || [];
      if (stack.includes) {
        for (const inc of stack.includes) {
          if (stacks[inc]?.components) names.push(...stacks[inc].components);
        }
      }
    }
    // Map catalog IDs to registry names
    const resolvedNames = [];
    for (const n of names) {
      const comp = components.find(c => c.id === n);
      if (comp) {
        resolvedNames.push(comp.id);
        for (const m of (comp.registryMatches || [])) resolvedNames.push(m);
      } else {
        resolvedNames.push(n);
      }
    }
    const uniqueNames = [...new Set(resolvedNames)];

    const registry = readJSON(REGISTRY_PATH);
    console.log('');
    for (const name of uniqueNames) {
      if (!registry?.extensions?.[name]) continue;
      const result = await enableExtension(name);
      if (result.ok) {
        console.log(`  + ${name}: ${result.reason}`);
      } else {
        console.log(`  ! ${name}: ${result.reason}`);
      }
    }
    console.log('');
  }

  async function cmdDisable() {
    const target = args.slice(1).find(a => !a.startsWith('--'));
    if (!target) {
      console.log('  Usage: ldm disable <extension|stack>');
      process.exit(1);
    }

    const { disableExtension } = await import('../lib/deploy.mjs');
    const stacks = loadCatalog()?.stacks || {};
    const components = loadCatalog()?.components || [];

    let names = [target];
    if (stacks[target]) {
      const stack = stacks[target];
      names = stack.components || [];
      if (stack.includes) {
        for (const inc of stack.includes) {
          if (stacks[inc]?.components) names.push(...stacks[inc].components);
        }
      }
    }
    const resolvedNames = [];
    for (const n of names) {
      const comp = components.find(c => c.id === n);
      if (comp) {
        resolvedNames.push(comp.id);
        for (const m of (comp.registryMatches || [])) resolvedNames.push(m);
      } else {
        resolvedNames.push(n);
      }
    }
    const uniqueNames = [...new Set(resolvedNames)];

    const registry = readJSON(REGISTRY_PATH);
    console.log('');
    for (const name of uniqueNames) {
      if (!registry?.extensions?.[name]) continue;
      const result = disableExtension(name);
      if (result.ok) {
        console.log(`  - ${name}: ${result.reason}`);
      } else {
        console.log(`  ! ${name}: ${result.reason}`);
      }
    }
    console.log('');
  }

  // ── ldm uninstall (#114) ──

  async function cmdUninstall() {
    const keepData = !args.includes('--all');
    const isDryRun = args.includes('--dry-run');

    console.log('');
    console.log('  LDM OS Uninstall');
    console.log('  ────────────────────────────────────');

    if (keepData) {
      console.log('  Your data will be PRESERVED:');
      console.log('    ~/.ldm/memory/     (crystal.db, shared memory)');
      console.log('    ~/.ldm/agents/     (identity, journals, daily logs)');
      console.log('');
      console.log('  Use --all to remove everything including data.');
    } else {
      console.log('  WARNING: --all flag set. ALL data will be removed.');
      console.log('  This includes crystal.db, agent files, journals, everything.');
    }

    console.log('');
    console.log('  Will remove:');

    // 1. MCP servers
    const claudeJsonPath = join(HOME, '.claude.json');
    try {
      const claudeJson = JSON.parse(readFileSync(claudeJsonPath, 'utf8'));
      const mcpNames = Object.keys(claudeJson.mcpServers || {}).filter(n =>
        n.includes('crystal') || n.includes('wip-') || n.includes('memory') ||
        n.includes('grok') || n.includes('lesa') || n.includes('1password')
      );
      if (mcpNames.length > 0) {
        console.log(`    MCP servers: ${mcpNames.join(', ')}`);
      }
    } catch {}

    // 2. CC hooks
    const settingsPath = join(HOME, '.claude', 'settings.json');
    try {
      const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
      let hookCount = 0;
      for (const [event, entries] of Object.entries(settings.hooks || {})) {
        for (const entry of (Array.isArray(entries) ? entries : [])) {
          for (const h of (entry.hooks || [])) {
            if (h.command?.includes('.ldm') || h.command?.includes('wip-')) hookCount++;
          }
        }
      }
      if (hookCount > 0) console.log(`    CC hooks: ${hookCount} hook(s)`);
    } catch {}

    // 3. Skills
    const skillsDir = join(HOME, '.openclaw', 'skills');
    try {
      const skills = readdirSync(skillsDir).filter(d => d !== '.DS_Store');
      if (skills.length > 0) console.log(`    Skills: ${skills.join(', ')}`);
    } catch {}

    // 4. Cron jobs
    try {
      const crontab = execSync('crontab -l 2>/dev/null', { encoding: 'utf8' });
      const ldmLines = crontab.split('\n').filter(l => l.includes('.ldm') || l.includes('crystal-capture') || l.includes('process-monitor'));
      if (ldmLines.length > 0) console.log(`    Cron jobs: ${ldmLines.length}`);
    } catch {}

    // 5. Global npm packages
    try {
      const npmList = execSync('npm list -g --depth=0 --json 2>/dev/null', { encoding: 'utf8' });
      const deps = JSON.parse(npmList).dependencies || {};
      const wipPkgs = Object.keys(deps).filter(n => n.startsWith('@wipcomputer/'));
      if (wipPkgs.length > 0) console.log(`    npm packages: ${wipPkgs.join(', ')}`);
    } catch {}

    // 6. Directories
    console.log(`    ~/.ldm/extensions/`);
    if (!keepData) {
      console.log(`    ~/.ldm/memory/`);
      console.log(`    ~/.ldm/agents/`);
    }
    console.log(`    ~/.ldm/state/, bin/, hooks/, logs/, sessions/, messages/`);

    if (isDryRun) {
      console.log('');
      console.log('  Dry run. Nothing removed.');
      console.log('');
      return;
    }

    // Confirm
    if (process.stdin.isTTY) {
      const { createInterface } = await import('readline');
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await new Promise(resolve => {
        rl.question('\n  Type "uninstall" to confirm: ', resolve);
      });
      rl.close();
      if (answer.trim() !== 'uninstall') {
        console.log('  Cancelled.');
        return;
      }
    }

    console.log('');
    console.log('  Removing...');

    // 1. Unregister MCP servers
    try {
      const claudeJson = JSON.parse(readFileSync(claudeJsonPath, 'utf8'));
      const mcpNames = Object.keys(claudeJson.mcpServers || {}).filter(n =>
        n.includes('crystal') || n.includes('wip-') || n.includes('memory') ||
        n.includes('grok') || n.includes('lesa') || n.includes('1password')
      );
      for (const name of mcpNames) {
        delete claudeJson.mcpServers[name];
      }
      writeFileSync(claudeJsonPath, JSON.stringify(claudeJson, null, 2) + '\n');
      console.log(`  + Removed ${mcpNames.length} MCP server(s)`);
    } catch {}

    // 2. Remove CC hooks
    try {
      const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
      let removed = 0;
      for (const [event, entries] of Object.entries(settings.hooks || {})) {
        if (!Array.isArray(entries)) continue;
        for (const entry of entries) {
          if (!entry.hooks) continue;
          const before = entry.hooks.length;
          entry.hooks = entry.hooks.filter(h => !h.command?.includes('.ldm') && !h.command?.includes('wip-'));
          removed += before - entry.hooks.length;
        }
        settings.hooks[event] = entries.filter(e => e.hooks?.length > 0);
      }
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
      console.log(`  + Removed ${removed} CC hook(s)`);
    } catch {}

    // 3. Remove skills
    try {
      const skills = readdirSync(skillsDir).filter(d => d !== '.DS_Store');
      for (const s of skills) {
        execSync(`rm -rf "${join(skillsDir, s)}"`, { stdio: 'pipe' });
      }
      console.log(`  + Removed ${skills.length} skill(s)`);
    } catch {}

    // 4. Remove cron jobs
    try {
      const crontab = execSync('crontab -l 2>/dev/null', { encoding: 'utf8' });
      const filtered = crontab.split('\n').filter(l =>
        !l.includes('.ldm') && !l.includes('crystal-capture') && !l.includes('process-monitor')
      ).join('\n');
      execSync(`echo "${filtered}" | crontab -`, { stdio: 'pipe' });
      console.log('  + Cleaned cron jobs');
    } catch {}

    // 5. Remove npm packages
    try {
      const npmList = execSync('npm list -g --depth=0 --json 2>/dev/null', { encoding: 'utf8' });
      const deps = JSON.parse(npmList).dependencies || {};
      const wipPkgs = Object.keys(deps).filter(n => n.startsWith('@wipcomputer/'));
      for (const pkg of wipPkgs) {
        if (pkg === '@wipcomputer/wip-ldm-os') continue; // uninstall self last
        try { execSync(`npm uninstall -g ${pkg}`, { stdio: 'pipe', timeout: 30000 }); } catch {}
      }
      console.log(`  + Removed ${wipPkgs.length - 1} npm package(s)`);
    } catch {}

    // 6. Remove directories
    const dirsToRemove = ['extensions', 'state', 'bin', 'hooks', 'logs', 'sessions', 'messages', 'shared', '_trash'];
    if (!keepData) {
      dirsToRemove.push('memory', 'agents', 'secrets', 'backups');
    }
    for (const dir of dirsToRemove) {
      const p = join(LDM_ROOT, dir);
      if (existsSync(p)) {
        execSync(`rm -rf "${p}"`, { stdio: 'pipe' });
      }
    }
    // Remove config and version files
    for (const f of ['version.json', 'config.json']) {
      const p = join(LDM_ROOT, f);
      if (existsSync(p)) unlinkSync(p);
    }
    console.log('  + Removed ~/.ldm/ contents');

    if (keepData) {
      console.log('');
      console.log('  Preserved:');
      console.log('    ~/.ldm/memory/   (your data)');
      console.log('    ~/.ldm/agents/   (identity + journals)');
    }

    // 7. Self-uninstall
    console.log('');
    console.log('  To finish, run: npm uninstall -g @wipcomputer/wip-ldm-os');
    console.log('');
    console.log('  LDM OS uninstalled.');
    console.log('');
  }

  // ── ldm worktree ──

  async function cmdWorktree() {
    const sub = args[1] || 'list';

    if (sub === '--help' || sub === '-h') {
      console.log(`
  ldm worktree add <branch>       Create worktree in .worktrees/ (auto-detects repo)
  ldm worktree list                List all worktrees across repos
  ldm worktree clean               Prune worktrees for merged branches
  ldm worktree remove <path>       Remove a specific worktree
`);
      process.exit(0);
    }

    if (sub === 'add') {
      const branchName = args[2];
      if (!branchName) {
        console.error('  Usage: ldm worktree add <branch-name>');
        console.error('  Example: ldm worktree add cc-mini/fix-bug');
        process.exit(1);
      }

      // Auto-detect repo from CWD
      let repoRoot;
      try {
        repoRoot = execSync('git rev-parse --show-toplevel 2>/dev/null', {
          encoding: 'utf8', timeout: 3000
        }).trim();
      } catch {
        console.error('  Not inside a git repo. cd into a repo first.');
        process.exit(1);
      }

      const repoName = basename(repoRoot);
      const branchSuffix = branchName.replace(/\//g, '--');
      const worktreesDir = join(dirname(repoRoot), '.worktrees');
      const worktreePath = join(worktreesDir, `${repoName}--${branchSuffix}`);

      mkdirSync(worktreesDir, { recursive: true });

      console.log(`  Creating worktree for ${repoName}...`);
      console.log(`  Branch: ${branchName}`);
      console.log(`  Path: ${worktreePath}`);

      try {
        execSync(`git worktree add "${worktreePath}" -b "${branchName}"`, {
          cwd: repoRoot, stdio: 'inherit'
        });
        console.log('');
        console.log(`  Done. Work in: ${worktreePath}`);
        console.log(`  When done: ldm worktree remove "${worktreePath}"`);
      } catch (e) {
        console.error(`  Failed: ${e.message}`);
        process.exit(1);
      }
      return;
    }

    if (sub === 'list') {
      // Find all repos and list their worktrees
      const reposBase = process.env.LDM_REPOS || process.cwd();
      let found = 0;

      // Check CWD repo
      try {
        const root = execSync('git rev-parse --show-toplevel 2>/dev/null', {
          encoding: 'utf8', timeout: 3000
        }).trim();
        const result = execSync('git worktree list', {
          cwd: root, encoding: 'utf8', timeout: 5000
        }).trim();
        if (result.split('\n').length > 1) {
          console.log(`  ${basename(root)}:`);
          for (const line of result.split('\n')) {
            console.log(`    ${line}`);
          }
          found++;
        }
      } catch {}

      // Also check .worktrees/ dir
      const worktreesDir = join(dirname(process.cwd()), '.worktrees');
      if (existsSync(worktreesDir)) {
        try {
          const entries = readdirSync(worktreesDir, { withFileTypes: true })
            .filter(d => d.isDirectory());
          if (entries.length > 0) {
            console.log(`  .worktrees/:`);
            for (const d of entries) {
              console.log(`    ${d.name}`);
            }
            found++;
          }
        } catch {}
      }

      if (found === 0) {
        console.log('  No active worktrees found.');
      }
      return;
    }

    if (sub === 'remove') {
      const wtPath = args[2];
      if (!wtPath) {
        console.error('  Usage: ldm worktree remove <path>');
        process.exit(1);
      }
      try {
        // Find the repo root for this worktree
        const root = execSync('git rev-parse --show-toplevel 2>/dev/null', {
          cwd: resolve(wtPath), encoding: 'utf8', timeout: 3000
        }).trim();
        const mainRoot = execSync('git -C "' + root + '" worktree list --porcelain 2>/dev/null', {
          encoding: 'utf8', timeout: 5000
        }).split('\n').find(l => l.startsWith('worktree '))?.replace('worktree ', '');

        execSync(`git worktree remove "${resolve(wtPath)}"`, {
          cwd: mainRoot || root, stdio: 'inherit'
        });
        console.log(`  Removed worktree: ${wtPath}`);
      } catch (e) {
        console.error(`  Failed: ${e.message}`);
        process.exit(1);
      }
      return;
    }

    if (sub === 'clean') {
      console.log('  Pruning stale worktrees...');
      try {
        const root = execSync('git rev-parse --show-toplevel 2>/dev/null', {
          encoding: 'utf8', timeout: 3000
        }).trim();
        execSync('git worktree prune', { cwd: root, stdio: 'inherit' });
        console.log('  Done.');
      } catch (e) {
        console.error(`  Failed: ${e.message}`);
      }
      return;
    }

    console.error(`  Unknown subcommand: ${sub}`);
    console.error('  Run: ldm worktree --help');
    process.exit(1);
  }

  if (command === '--version' || command === '-v') {
    console.log(PKG_VERSION);
    process.exit(0);
  }

  switch (command) {
    case 'init':
      await cmdInit();
      break;
    case 'install':
      await cmdInstall();
      break;
    case 'update':
      // Alias: `ldm update` = `ldm install` (update all registered)
      await cmdUpdateAll();
      break;
    case 'doctor':
      await cmdDoctor();
      break;
    case 'status':
      cmdStatus();
      break;
    case 'sessions':
      await cmdSessions();
      break;
    case 'msg':
      await cmdMsg();
      break;
    case 'stack':
      await cmdStack();
      break;
    case 'catalog':
      cmdCatalogShow();
      break;
    case 'updates':
      await cmdUpdates();
      break;
    case 'enable':
      await cmdEnable();
      break;
    case 'disable':
      await cmdDisable();
      break;
    case 'uninstall':
      await cmdUninstall();
      break;
    case 'worktree':
      await cmdWorktree();
      break;
    case 'backup':
      await cmdBackup();
      break;
    default:
      console.error(`  Unknown command: ${command}`);
      console.error(`  Run: ldm --help`);
      process.exit(1);
  }
}

main().catch(e => {
  console.error(`  x ${e.message}`);
  process.exit(1);
});
