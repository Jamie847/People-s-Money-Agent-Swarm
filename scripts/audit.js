#!/usr/bin/env node
// Run the auditor on its own: `node scripts/audit.js`. Exits non-zero if any check fails.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAudit } from '../src/agents/auditor.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const result = runAudit(root);
for (const c of result.checks) console.log(`${c.status === 'ok' ? 'PASS' : 'FAIL'}  ${c.name}: ${c.detail}`);
process.exit(result.ok ? 0 : 1);
