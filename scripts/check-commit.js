#!/usr/bin/env node
// Checks everything the daily save is about to commit under data/, with the same rules as the dashboard's
// publication check, so a prohibited payload (raw FRED data, observation series, table-like text) can't enter
// Git history. From November 16, 2026 a failure stops the run before the save; before that it only warns, so
// it can never block the November 15 reading being saved. (Jamie, Nov 6, 2026.)
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanSite } from './build-site.js';
import { validDate } from '../src/lib/fred-api-policy.js';

export const GATE_FROM = '2026-11-16';
// Committed but not published on the dashboard: internal packet bookkeeping, and the BIS file (not FRED data).
export const EXTRA_FILES = ['data/new-packets.json', 'data/packets-seen.json'];
export const SKIP_FILES = ['data/inputs/OFFSHORE_CREDIT.csv'];

export function filesToCommit(root) {
  const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
  // What `git add data` would stage: tracked files that still exist, plus new files that aren't ignored.
  const tracked = git(['ls-files', '--', 'data']);
  const deleted = new Set(git(['ls-files', '--deleted', '--', 'data']));
  return [...tracked.filter((f) => !deleted.has(f)), ...git(['ls-files', '--others', '--exclude-standard', '--', 'data'])];
}

export function checkCommit(root) {
  const tmp = mkdtempSync(join(tmpdir(), 'commit-check-'));
  try {
    for (const rel of filesToCommit(root)) {
      mkdirSync(dirname(join(tmp, rel)), { recursive: true });
      cpSync(join(root, rel), join(tmp, rel));
    }
    return scanSite(tmp, { extraFiles: EXTRA_FILES, skipFiles: SKIP_FILES });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const rootArg = process.argv.indexOf('--root');
  const root = rootArg > 0 ? process.argv[rootArg + 1] : join(dirname(fileURLToPath(import.meta.url)), '..');
  const today = process.env.SWARM_TODAY || new Date().toISOString().slice(0, 10);
  if (!validDate(today)) { console.error(`Invalid run date ${JSON.stringify(today)}`); process.exit(2); }
  const problems = checkCommit(root);
  const enforced = today >= GATE_FROM;
  if (!problems.length) { console.log(`Pre-save check passed (${enforced ? 'enforced' : `warning only until ${GATE_FROM}`}).`); process.exit(0); }
  const list = problems.slice(0, 30).map((p) => `- ${p}`).join('\n');
  if (enforced) {
    console.error(`Pre-save check FAILED: nothing will be saved or published today.\n${list}`);
    process.exit(1);
  }
  for (const p of problems.slice(0, 30)) console.log(`::warning::Pre-save check (not enforced until ${GATE_FROM}): ${p}`);
  console.log(`Pre-save check found ${problems.length} problem(s); saving anyway because it is enforced only from ${GATE_FROM}.`);
}
