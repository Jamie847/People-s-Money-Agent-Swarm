// AUDITOR AGENT
// Job: check the swarm's own work after every run, using only what is published in this repository.
//  1. The ledger's hash chain is unbroken.
//  2. The raw input files match the fingerprints in the latest ledger entry.
//  3. Every frozen live reading still matches the fingerprint it was frozen with.
//  4. Every frozen live reading's outputs can be recomputed from its stored inputs.
//  5. The rule parameters in force match the fingerprint in the latest ledger entry.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { sha256, stableStringify, readJSON } from '../lib/util.js';
import { readLedger, verifyLedger } from './ledger.js';
import { calculatorA, OUTPUT_KEYS } from './calculators.js';

export function runAudit(root) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, status: ok ? 'ok' : 'fail', detail });
  const entries = readLedger(join(root, 'data', 'ledger.jsonl'));
  const chain = verifyLedger(entries);
  add('ledger-chain', chain.ok, chain.ok ? `${chain.entries} entries; head ${chain.head.slice(0, 16)}…` : `Broken at entry ${chain.at}: ${chain.reason}`);
  const last = entries[entries.length - 1];

  if (last) {
    // Files retrieved through FRED are not published (FRED's terms). During a run they are on disk and are
    // checked like any other file; in a copy of the repo they are simply absent, which is expected. A file that
    // is present must always match its seal, and a missing file from any other source is a failure.
    let fredIds = new Set();
    try { fredIds = new Set(JSON.parse(readFileSync(join(root, 'config', 'sources.json'), 'utf8')).sources.filter((s) => s.transport === 'fred').map((s) => s.id)); } catch { /* no config: treat every file as published */ }
    const unpublished = [];
    const mismatched = Object.entries(last.inputs_sha256 || {}).filter(([id, h]) => {
      if (!h) return false;
      const p = join(root, 'data', 'inputs', `${id}.csv`);
      if (!existsSync(p)) { if (fredIds.has(id)) { unpublished.push(id); return false; } return true; }
      return sha256(readFileSync(p, 'utf8')) !== h;
    });
    const sealed = Object.values(last.inputs_sha256 || {}).filter(Boolean).length;
    add('input-fingerprints', mismatched.length === 0, mismatched.length ? `Changed since sealed: ${mismatched.map((m) => m[0]).join(', ')}`
      : `${sealed - unpublished.length} raw files match the ledger` + (unpublished.length ? `; ${unpublished.length} FRED files are not published in this copy (FRED's terms) and were checked during the run` : ''));
    const rulePath = join(root, 'config', 'rule.json');
    add('rule-fingerprint', sha256(readFileSync(rulePath, 'utf8')) === last.rule_sha256, 'config/rule.json matches the ledger');
    const histText = existsSync(join(root, 'data', 'live-history.json')) ? readFileSync(join(root, 'data', 'live-history.json'), 'utf8') : '[]\n';
    add('live-history-fingerprint', sha256(histText) === last.live_history_sha256, 'data/live-history.json matches the ledger');
  } else {
    add('ledger-present', false, 'No ledger entries yet');
  }

  const rule = readJSON(join(root, 'config', 'rule.json'));
  const history = readJSON(join(root, 'data', 'live-history.json'), []);
  let frozenOk = 0; let recomputedOk = 0; const problems = [];
  for (const h of history) {
    const { frozen_sha256: fs, ...rest } = h;
    if (sha256(stableStringify(rest)) === fs) frozenOk++; else problems.push(`${h.quarter}: frozen fingerprint mismatch`);
    if (h.available && h.inputs) {
      const r = calculatorA({ ...h.inputs }, rule);
      const bad = OUTPUT_KEYS.filter((k) => Math.abs(r[k] - h.outputs[k]) > 1e-9);
      if (bad.length) problems.push(`${h.quarter}: recomputed ${bad.join(', ')} differ`); else recomputedOk++;
    }
  }
  add('frozen-readings', problems.length === 0, problems.length ? problems.join('; ') : `${frozenOk} frozen readings intact; ${recomputedOk} recomputed from stored inputs`);
  return { ok: checks.every((c) => c.status === 'ok'), checks };
}
