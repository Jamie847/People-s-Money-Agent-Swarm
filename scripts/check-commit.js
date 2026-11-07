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
// Committed but not published on the dashboard (a separate allowance from the public site's): internal packet
// bookkeeping and the monthly newsletter drafts, checked like any JSON; and the BIS file (not FRED data), allowed
// only if it really has the BIS layout.
export const EXTRA_FILES = ['data/new-packets.json', 'data/packets-seen.json', /^data\/newsletter\/\d{4}-\d{2}\.json$/];
export const BIS_FILES = ['data/inputs/OFFSHORE_CREDIT.csv'];

export function filesToCommit(root) {
  const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
  // What `git add data` would stage: tracked files that still exist, plus new files that aren't ignored.
  const tracked = git(['ls-files', '--', 'data']);
  const deleted = new Set(git(['ls-files', '--deleted', '--', 'data']));
  return [...tracked.filter((f) => !deleted.has(f)), ...git(['ls-files', '--others', '--exclude-standard', '--', 'data'])];
}

export function checkCommit(root) {
  const problems = [];
  // The daily save commits only data/ (git commit -- data); anything already staged elsewhere is a red flag.
  const staged = execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
  for (const f of staged) if (!f.startsWith('data/')) problems.push(`staged outside data/: ${f}`);
  const tmp = mkdtempSync(join(tmpdir(), 'commit-check-'));
  try {
    for (const rel of filesToCommit(root)) {
      mkdirSync(dirname(join(tmp, rel)), { recursive: true });
      cpSync(join(root, rel), join(tmp, rel));
    }
    return [...problems, ...scanSite(tmp, { extraFiles: EXTRA_FILES, bisFiles: BIS_FILES })];
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const rootArg = process.argv.indexOf('--root');
  const root = rootArg > 0 ? process.argv[rootArg + 1] : join(dirname(fileURLToPath(import.meta.url)), '..');
  const today = process.env.SWARM_TODAY || new Date().toISOString().slice(0, 10);
  if (!validDate(today)) { console.error(`Invalid run date ${JSON.stringify(today)}`); process.exit(2); }
  const enforced = today >= GATE_FROM;
  let problems;
  try { problems = checkCommit(root); } catch (err) { problems = [`the check itself failed: ${String(err && err.message || err).slice(0, 160)}`]; }
  if (!problems.length) { console.log(`Pre-save check passed (${enforced ? 'enforced' : `warning only until ${GATE_FROM}`}).`); process.exit(0); }
  const list = problems.slice(0, 30).map((p) => `- ${p}`).join('\n');
  if (enforced) {
    console.error(`Pre-save check FAILED: this save is stopped (for the first daily save, nothing is saved or published today; for the witness copy, the day's record is already saved but the witness copy and dashboard update are skipped).\n${list}\nA reading due today is recomputed by the next run from the same dated snapshot if FRED's archive still serves it; if not, the code falls back to current revised data and says so in the record.`);
    process.exit(1);
  }
  for (const p of problems.slice(0, 30)) console.log(`::warning::Pre-save check (not enforced until ${GATE_FROM}): ${p}`);
  console.log(`Pre-save check found ${problems.length} problem(s); saving anyway because it is enforced only from ${GATE_FROM}.`);
}
