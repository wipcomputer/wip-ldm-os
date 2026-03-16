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
 *   ldm sessions          List active sessions
 *   ldm msg send <to> <b> Send a message to a session
 *   ldm msg list          List pending messages
 *   ldm msg broadcast <b> Send to all sessions
 *   ldm updates           Show available updates
 *   ldm --version         Show version
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, cpSync, chmodSync, unlinkSync } from 'node:fs';
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
      v.updated = new Date().toISOString();
      writeFileSync(VERSION_PATH, JSON.stringify(v, null, 2) + '\n');
    }
  } catch {}
}

// ── Install lockfile (#57) ──

const LOCK_PATH = join(LDM_ROOT, 'state', '.ldm-install.lock');

function acquireInstallLock() {
  try {
    if (existsSync(LOCK_PATH)) {
      const lock = JSON.parse(readFileSync(LOCK_PATH, 'utf8'));
      // Check if PID is still alive
      try {
        process.kill(lock.pid, 0); // signal 0 = just check if alive
        console.log(`  Another ldm install is running (PID ${lock.pid}, started ${lock.started}).`);
        console.log(`  Wait for it to finish, or remove ~/.ldm/state/.ldm-install.lock`);
        return false;
      } catch {
        // PID is dead, stale lock. Clean it up.
      }
    }
    mkdirSync(dirname(LOCK_PATH), { recursive: true });
    writeFileSync(LOCK_PATH, JSON.stringify({ pid: process.pid, started: new Date().toISOString() }));

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
  return loadCatalog().find(c => c.id === id);
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
    join(LDM_ROOT, 'hooks'),
  ];

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
          execSync(`ldm install ${c.repo}`, { stdio: 'inherit' });
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
      execSync(`ldm install ${c.repo}`, { stdio: 'inherit' });
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

  const { setFlags, installFromPath, installSingleTool, installToolbox } = await import('../lib/deploy.mjs');
  const { detectInterfacesJSON } = await import('../lib/detect.mjs');

  setFlags({ dryRun: DRY_RUN, jsonOutput: JSON_OUTPUT });

  // Find the target (skip flags)
  const target = args.slice(1).find(a => !a.startsWith('--'));

  if (!target) {
    // Bare `ldm install`: show catalog status + update registered
    return cmdInstallCatalog();
  }

  // Check if target is a catalog ID (e.g. "memory-crystal")
  const catalogEntry = findInCatalog(target);
  if (catalogEntry) {
    console.log('');
    console.log(`  Resolved "${target}" via catalog to ${catalogEntry.repo}`);

    // Use the repo field to clone from GitHub
    const repoTarget = catalogEntry.repo;
    const repoName = basename(repoTarget);
    const repoPath = join('/tmp', `ldm-install-${repoName}`);
    const httpsUrl = `https://github.com/${repoTarget}.git`;
    const sshUrl = `git@github.com:${repoTarget}.git`;

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
    return;
  }

  // Resolve target: npm package, GitHub URL, org/repo shorthand, or local path
  let repoPath;

  // Check if target looks like an npm package (starts with @ or is a plain name without /)
  if (target.startsWith('@') || (!target.includes('/') && !existsSync(resolve(target)))) {
    // Try npm install to temp dir
    const npmName = target;
    const tempDir = join('/tmp', `ldm-install-npm-${Date.now()}`);
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

  if (!repoPath && (target.startsWith('http') || target.startsWith('git@') || target.match(/^[\w-]+\/[\w.-]+$/))) {
    const isShorthand = target.match(/^[\w-]+\/[\w.-]+$/);
    const httpsUrl = isShorthand
      ? `https://github.com/${target}.git`
      : target;
    const sshUrl = isShorthand
      ? `git@github.com:${target}.git`
      : target.replace(/^https:\/\/github\.com\//, 'git@github.com:');
    const repoName = basename(httpsUrl).replace('.git', '');
    repoPath = join('/tmp', `ldm-install-${repoName}`);

    console.log('');
    console.log(`  Cloning ${isShorthand ? target : httpsUrl}...`);
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
    repoPath = resolve(target);
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
  if (!DRY_RUN && !acquireInstallLock()) return;

  autoDetectExtensions();

  const { detectSystemState, reconcileState, formatReconciliation } = await import('../lib/state.mjs');
  const state = detectSystemState();
  const reconciled = reconcileState(state);

  // Show the real system state
  console.log(formatReconciliation(reconciled));

  // Check catalog: use registryMatches + cliMatches to detect what's really installed
  const registry = readJSON(REGISTRY_PATH);
  const registeredNames = Object.keys(registry?.extensions || {});
  const reconciledNames = Object.keys(reconciled);
  const components = loadCatalog();

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

  // Check every installed extension against npm via catalog
  console.log('  Checking npm for updates...');
  for (const [name, entry] of Object.entries(reconciled)) {
    if (!entry.deployedLdm && !entry.deployedOc) continue; // not installed

    // Get npm package name from the installed extension's own package.json
    const extPkgPath = join(LDM_EXTENSIONS, name, 'package.json');
    const extPkg = readJSON(extPkgPath);
    const npmPkg = extPkg?.name;
    if (!npmPkg || !npmPkg.startsWith('@')) continue; // skip unscoped packages

    // Find catalog entry for the repo URL (used for clone if update needed)
    const catalogEntry = components.find(c => {
      const matches = c.registryMatches || [c.id];
      return matches.includes(name) || c.id === name;
    });

    const currentVersion = entry.ldmVersion || entry.ocVersion;
    if (!currentVersion) continue;

    try {
      const latestVersion = execSync(`npm view ${npmPkg} version 2>/dev/null`, {
        encoding: 'utf8', timeout: 10000,
      }).trim();

      if (latestVersion && latestVersion !== currentVersion) {
        npmUpdates.push({
          ...entry,
          catalogRepo: catalogEntry?.repo || null,
          catalogNpm: npmPkg,
          currentVersion,
          latestVersion,
          hasUpdate: true,
        });
      }
    } catch {}
  }

  const totalUpdates = npmUpdates.length;

  if (DRY_RUN) {
    if (npmUpdates.length > 0) {
      console.log(`  Would update ${npmUpdates.length} extension(s) from npm:`);
      for (const e of npmUpdates) {
        console.log(`    ${e.name}: v${e.currentVersion} -> v${e.latestVersion} (${e.catalogNpm})`);
      }
    }
    if (totalUpdates > 0) {
      console.log('  No data (crystal.db, agent files) would be touched.');
      console.log('  Old versions would be moved to ~/.ldm/_trash/ (never deleted).');
    } else {
      console.log('  Everything is up to date. No changes needed.');
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

  // Update from npm via catalog repos (#55)
  for (const entry of npmUpdates) {
    console.log(`  Updating ${entry.name} v${entry.currentVersion} -> v${entry.latestVersion} (from ${entry.catalogRepo})...`);
    try {
      execSync(`ldm install ${entry.catalogRepo}`, { stdio: 'inherit' });
      updated++;
    } catch (e) {
      console.error(`  x Failed to update ${entry.name}: ${e.message}`);
    }
  }

  // Sync boot hook from npm package (#49)
  if (syncBootHook()) {
    ok('Boot hook updated (sessions, messages, updates now active)');
  }

  console.log('');
  console.log(`  Updated ${updated}/${totalUpdates} extension(s).`);

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
    if (!npmPkg || !npmPkg.startsWith('@')) continue;
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
    case 'updates':
      await cmdUpdates();
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
