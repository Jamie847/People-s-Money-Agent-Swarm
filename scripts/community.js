#!/usr/bin/env node
// COMMUNITY AGENT SANDBOX
// Anyone can add an agent in community/<agent-id>/ (see community/README.md). This runner gives each one
// a read-only copy of the latest public record on stdin and takes back a short JSON report on stdout.
//
// What a community agent can never do:
//   - change the rule, the calculators, the ledger, the executor or any published number
//   - see secrets (it runs with an empty environment)
//   - reach the network (with --isolate it runs in its own network namespace, as the 'nobody' user)
//   - run forever (20-second limit) or flood the record (64 KB output limit)
// Its report is published as ADVISORY, attributed to its author, and fingerprinted into the ledger.
//
//   node scripts/community.js              run every agent, write data/community.json
//   node scripts/community.js --isolate    same, but require network isolation (used by the daily job)
//   node scripts/community.js --only <id>  run one agent (try yours locally)

import { spawnSync, execFileSync } from 'node:child_process';
import { readdirSync, existsSync, readFileSync, mkdtempSync, cpSync, chmodSync, rmSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { readJSON, writeJSON, sha256 } from '../src/lib/util.js';
import { parseFredCsv, parseBisCsv } from '../src/agents/sensors.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const isolate = args.includes('--isolate');
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
const TIMEOUT_MS = 20000;
const MAX_OUT = 64 * 1024;
const ROLES = ['sentinel', 'auditor', 'analyst', 'reporter'];
const STATUSES = ['ok', 'calm', 'watch', 'stress', 'info'];
const INTERPRETERS = { node: process.execPath, python3: '/usr/bin/python3' };

export function validateManifest(m, dirName) {
  const errs = [];
  if (!m || typeof m !== 'object') return ['agent.json is not an object'];
  if (m.id !== dirName) errs.push(`id must equal the folder name (${dirName})`);
  if (!/^[a-z0-9][a-z0-9-]{1,48}$/.test(m.id || '')) errs.push('id: lowercase letters, digits and hyphens, 2-49 characters');
  for (const k of ['name', 'author', 'description']) if (typeof m[k] !== 'string' || !m[k].trim()) errs.push(`${k} is required`);
  if (!ROLES.includes(m.role)) errs.push(`role must be one of ${ROLES.join(', ')}`);
  if (!Array.isArray(m.command) || !m.command.length || !INTERPRETERS[m.command[0]]) errs.push(`command must start with one of: ${Object.keys(INTERPRETERS).join(', ')}`);
  else if (m.command.slice(1).some((a) => typeof a !== 'string' || a.includes('..') || a.startsWith('/'))) errs.push('command arguments must be files inside the agent folder');
  return errs;
}

export function validateReport(r) {
  const errs = [];
  if (!r || typeof r !== 'object') return ['output is not a JSON object'];
  if (!STATUSES.includes(r.status)) errs.push(`status must be one of ${STATUSES.join(', ')}`);
  if (typeof r.headline !== 'string' || !r.headline.trim() || r.headline.length > 160) errs.push('headline: 1-160 characters');
  if (r.findings !== undefined) {
    if (!Array.isArray(r.findings) || r.findings.length > 12) errs.push('findings: an array of at most 12 items');
    else r.findings.forEach((f, i) => { if (!f || typeof f.label !== 'string') errs.push(`findings[${i}].label is required`); });
  }
  return errs;
}

// The read-only context every agent receives: the latest public record and the raw inputs.
export function buildContext() {
  const latest = readJSON(join(root, 'data', 'latest.json'), null);
  const { sources } = readJSON(join(root, 'config', 'sources.json'));
  const inputs = {};
  for (const s of sources) {
    const p = join(root, 'data', 'inputs', `${s.id}.csv`);
    if (!existsSync(p)) continue;
    const text = readFileSync(p, 'utf8');
    try { inputs[s.id] = { title: s.title, agency: s.agency, units: s.units, observations: (s.transport === 'bis' ? parseBisCsv(text) : parseFredCsv(text)).map((o) => [o.date, o.value]) }; } catch { /* skip unreadable */ }
  }
  if (latest) {
    for (const g of Object.values(latest.sentinels || {})) for (const r of g.readings || []) delete r.history;
    delete latest.report;
  }
  return { schema: 1, note: 'Read-only copy of the public record. Reply with one JSON object on stdout.', latest, inputs };
}

export const sandboxPrefix = () => {
  const inner = ['/usr/bin/unshare', '--net', '--', '/usr/sbin/runuser', '-u', 'nobody', '--', 'env', '-i', 'PATH=/usr/bin:/bin', 'HOME=/tmp', 'LANG=C.UTF-8'];
  const isRoot = process.getuid && process.getuid() === 0;
  const prefix = isRoot ? inner : ['/usr/bin/sudo', '-n', ...inner];
  try { execFileSync(prefix[0], [...prefix.slice(1), '/bin/true'], { stdio: 'ignore', timeout: 10000 }); return prefix; } catch { return null; }
};

export function runAgent(dir, manifest, contextText, prefix) {
  // Copy the agent to a world-readable temp folder so the 'nobody' user can read it, and nothing else.
  const work = mkdtempSync(join(tmpdir(), `swarm-agent-${manifest.id}-`));
  cpSync(dir, work, { recursive: true });
  chmodSync(work, 0o755);
  const ctxFile = join(work, '.context.json');
  writeFileSync(ctxFile, contextText);
  const cmd = [INTERPRETERS[manifest.command[0]], ...manifest.command.slice(1)];
  const full = prefix ? [...prefix, ...cmd] : cmd;
  const started = Date.now();
  // stdin comes from the context file, so an agent that never reads stdin cannot break the pipe.
  const fd = openSync(ctxFile, 'r');
  const res = spawnSync(full[0], full.slice(1), { cwd: work, stdio: [fd, 'pipe', 'pipe'], timeout: TIMEOUT_MS, maxBuffer: MAX_OUT * 4, env: { PATH: '/usr/bin:/bin:/usr/sbin', HOME: tmpdir() }, encoding: 'utf8' });
  closeSync(fd);
  rmSync(work, { recursive: true, force: true });
  const out = { duration_ms: Date.now() - started, isolated: Boolean(prefix) };
  if (res.error) return { ...out, error: res.error.code === 'ETIMEDOUT' ? `timed out after ${TIMEOUT_MS / 1000}s` : String(res.error.message).slice(0, 200) };
  if (res.status !== 0) return { ...out, error: `exited with code ${res.status}: ${(res.stderr || '').slice(-300)}` };
  if (Buffer.byteLength(res.stdout || '') > MAX_OUT) return { ...out, error: 'output larger than 64 KB' };
  let report;
  try { report = JSON.parse(res.stdout); } catch { return { ...out, error: 'output is not valid JSON' }; }
  const errs = validateReport(report);
  if (errs.length) return { ...out, error: `invalid report: ${errs.join('; ')}` };
  return { ...out, report: { status: report.status, headline: report.headline, findings: (report.findings || []).map((f) => ({ label: String(f.label).slice(0, 120), value: f.value === undefined ? null : String(f.value).slice(0, 120), note: f.note ? String(f.note).slice(0, 300) : null })) }, output_sha256: sha256(res.stdout) };
}

function main() {
  const base = join(root, 'community');
  const dirs = existsSync(base) ? readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) : [];
  const prefix = isolate || process.env.SWARM_ISOLATE === '1' ? sandboxPrefix() : null;
  const contextText = JSON.stringify(buildContext());
  const results = [];
  for (const name of dirs.sort()) {
    if (only && name !== only) continue;
    const dir = join(base, name);
    const manifest = readJSON(join(dir, 'agent.json'), null);
    const errs = validateManifest(manifest, name);
    const meta = manifest ? { id: name, name: manifest.name, author: manifest.author, role: manifest.role, description: manifest.description, homepage: manifest.homepage || null } : { id: name };
    if (errs.length) { results.push({ ...meta, error: `invalid agent.json: ${errs.join('; ')}` }); continue; }
    if (isolate && !prefix) { results.push({ ...meta, error: 'not run: network isolation unavailable on this machine (fail closed)' }); continue; }
    results.push({ ...meta, ...runAgent(dir, manifest, contextText, prefix) });
  }
  const summary = { ran_at: new Date().toISOString(), isolated: Boolean(prefix), context_sha256: sha256(contextText), agents: results };
  if (!only) writeJSON(join(root, 'data', 'community.json'), summary);
  for (const r of results) console.log(`${r.error ? 'FAIL' : 'OK  '}  ${r.id}${r.error ? `: ${r.error}` : `: [${r.report.status}] ${r.report.headline}`}${r.isolated ? ' (isolated)' : ''}`);
  if (args.includes('--validate') && results.some((r) => r.error)) process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
