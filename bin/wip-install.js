#!/usr/bin/env node
// wip-install: thin bootstrap + delegate to ldm install.
// If ldm is on PATH, delegates immediately.
// If not, installs LDM OS from npm, then delegates.
// Replaces the standalone 700-line install.js from wip-ai-devops-toolbox.

import { run } from '../lib/bootstrap.mjs';
run(process.argv.slice(2));
