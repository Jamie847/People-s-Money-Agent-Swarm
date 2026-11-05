#!/usr/bin/env node
// RED TEAM AGENT
// Every run, before the swarm computes anything, this agent attacks a throwaway copy of the record and checks
// that each control catches the attack. Results are published (data/redteam.json). An attack that is NOT caught
// raises an urgent human-gate packet. The book (Ch. 9): controls "have to be designed first, then attacked in a
// published red-team exercise."
//
// Optional: with ANTHROPIC_API_KEY set, once a week (Mondays) a low-cost model suggests new attacks for humans
// to consider. Suggestions are advisory text only; nothing they say is executed.

import { mkdtempSync, cpSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJSON, readJSON } from '../src/lib/util.js';
import { runAudit } from '../src/agents/auditor.js';
import { readLedger, verifyLedger, sealEntry, GENESIS } from '../src/agents/ledger.js';
import { calculatorA, calculatorB, consensus } from '../src/agents/calculators.js';
import { shadowInstruction } from '../src/agents/executor.js';
import { allowedNumbers, verifyNumbers } from '../src/agents/reporter.js';
import { runBrake } from '../src/agents/brake.js';
import { runAgent, sandboxPrefix } from './community.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const scratchCopy = () => {
  const dir = mkdtempSync(join(tmpdir(), 'redteam-'));
  cpSync(join(root, 'data'), join(dir, 'data'), { recursive: true });
  cpSync(join(root, 'config'), join(dir, 'config'), { recursive: true });
  return dir;
};
const auditFails = (dir, checkName) => runAudit(dir).checks.find((c) => c.name === checkName)?.status === 'fail';

const attacks = [];
const attack = (id, description, fn) => {
  let caught = false; let detail = '';
  try { [caught, detail] = fn(); } catch (e) { caught = false; detail = `attack harness error: ${String(e.message).slice(0, 160)}`; }
  attacks.push({ id, description, caught, detail });
};

const hasLedger = existsSync(join(root, 'data', 'ledger.jsonl')) && readLedger(join(root, 'data', 'ledger.jsonl')).length > 0;

attack('edit-raw-input', 'Change one digit in a raw input file after it was sealed', () => {
  const d = scratchCopy();
  const p = join(d, 'data', 'inputs', 'CPI.csv');
  writeFileSync(p, readFileSync(p, 'utf8').replace(/(\d)(\r?\n)$/, (m, a, b) => `${(Number(a) + 1) % 10}${b}`));
  const caught = auditFails(d, 'input-fingerprints'); rmSync(d, { recursive: true, force: true });
  return [caught, caught ? 'auditor: input fingerprint mismatch' : 'auditor did not notice the edited input'];
});

attack('rewrite-old-ledger-entry', 'Quietly rewrite an old ledger entry', () => {
  if (!hasLedger) return [true, 'no ledger yet (skipped)'];
  const d = scratchCopy();
  const p = join(d, 'data', 'ledger.jsonl');
  const lines = readFileSync(p, 'utf8').split('\n').filter(Boolean);
  const e = JSON.parse(lines[0]); e.brake_phase = 'engaged'; lines[0] = JSON.stringify(e);
  writeFileSync(p, lines.join('\n') + '\n');
  const caught = !verifyLedger(readLedger(p)).ok && auditFails(d, 'ledger-chain'); rmSync(d, { recursive: true, force: true });
  return [caught, caught ? 'ledger chain broken at the edited entry' : 'edited entry went unnoticed'];
});

attack('reseal-rewritten-entry', 'Rewrite an old entry AND recompute its own seal', () => {
  if (!hasLedger) return [true, 'no ledger yet (skipped)'];
  const d = scratchCopy();
  const p = join(d, 'data', 'ledger.jsonl');
  const entries = readLedger(p);
  if (entries.length < 2) { rmSync(d, { recursive: true, force: true }); return [true, 'needs 2+ entries (skipped)']; }
  // Even with a correctly recomputed seal on entry 0, entry 1's link to it no longer matches.
  const { hash, ...body } = entries[0]; body.mode = 'forged';
  entries[0] = { ...body, hash: sealEntry(body, GENESIS) };
  writeFileSync(p, entries.map((x) => JSON.stringify(x)).join('\n') + '\n');
  const caught = !verifyLedger(readLedger(p)).ok; rmSync(d, { recursive: true, force: true });
  return [caught, caught ? 'chain link to the next entry broken' : 'forged re-seal accepted'];
});

attack('rewrite-entire-ledger', 'Rewrite history and re-seal EVERY entry so the chain looks perfect', () => {
  if (!hasLedger) return [true, 'no ledger yet (skipped)'];
  const d = scratchCopy();
  const p = join(d, 'data', 'ledger.jsonl');
  const entries = readLedger(p);
  let prev = GENESIS;
  const forged = entries.map((e, i) => { const { hash, ...body } = e; if (i === 0) body.brake_phase = 'engaged'; body.prev_hash = prev; const h = sealEntry(body, prev); prev = h; return { ...body, hash: h }; });
  writeFileSync(p, forged.map((x) => JSON.stringify(x)).join('\n') + '\n');
  const chainLooksFine = verifyLedger(readLedger(p)).ok;
  // Only the outside witnesses can catch this: their checkpoints hold the ORIGINAL hashes.
  const cps = (readJSON(join(d, 'data', 'witnesses.json'), { checkpoints: [] }).checkpoints || []);
  const mismatched = cps.filter((c) => forged[c.ledger_seq] && forged[c.ledger_seq].hash !== c.ledger_entry_hash);
  rmSync(d, { recursive: true, force: true });
  if (!cps.length) return [false, 'no witnessed checkpoint yet: a full rewrite would pass the chain check'];
  const caught = chainLooksFine && mismatched.length > 0;
  return [caught, caught ? `chain re-sealed perfectly, but ${mismatched.length} witnessed checkpoint(s) expose it` : 'full rewrite not detected by witnesses'];
});

attack('edit-frozen-reading', 'Change a frozen live reading after it was published', () => {
  const d = scratchCopy();
  const p = join(d, 'data', 'live-history.json');
  const h = readJSON(p, []);
  if (!h.length || !h[0].outputs) { rmSync(d, { recursive: true, force: true }); return [true, 'no frozen readings yet (skipped)']; }
  h[0].outputs.allowance_pct += 0.25; writeFileSync(p, JSON.stringify(h, null, 2) + '\n');
  const caught = auditFails(d, 'frozen-readings') && auditFails(d, 'live-history-fingerprint'); rmSync(d, { recursive: true, force: true });
  return [caught, caught ? 'frozen fingerprint and ledger fingerprint both fail' : 'edited reading went unnoticed'];
});

attack('change-rule-quietly', 'Change the feedback strength without a recorded run', () => {
  const d = scratchCopy();
  const p = join(d, 'config', 'rule.json');
  const r = JSON.parse(readFileSync(p, 'utf8')); r.feedback_strength = 0.25; writeFileSync(p, JSON.stringify(r, null, 2) + '\n');
  const caught = auditFails(d, 'rule-fingerprint'); rmSync(d, { recursive: true, force: true });
  return [caught, caught ? 'rule fingerprint mismatch' : 'rule change went unnoticed'];
});

attack('one-calculator-lies', 'One calculator returns a slightly different answer', () => {
  const inp = { base: { cpi: [100, 100, 100], pce: [50, 50, 50] }, cur: { cpi: [101, 101, 101], pce: [50.5, 50.5, 50.5] }, gdp_levels: Array.from({ length: 11 }, (_, i) => 100 * 1.02 ** i) };
  const rule = { feedback_strength: 0.5, path_growth_floor_pct: 0, path_growth_ceiling_pct: 4 };
  const a = calculatorA(inp, rule); const b = { ...calculatorB(inp, rule), allowance_pct: a.allowance_pct + 0.0001 };
  const c = consensus({ A: a, B: b });
  const ins = shadowInstruction({ liveLatest: { quarter: 'X', complete: true, missing: [] }, consensusResult: c, brake: { current: { phase: 'off' } } });
  const caught = !c.agreed && !ins.authorized;
  return [caught, caught ? 'consensus refused; executor refused to act' : 'disagreement slipped through'];
});

attack('reporter-invents-number', 'The AI reporter claims a dollar figure the engine never produced', () => {
  const allowed = allowedNumbers({ gap: 0.47, allowance: 2.23, quarter: '2026-Q3' });
  const v = verifyNumbers('The rule would issue $312 billion this quarter.', allowed);
  return [!v.ok, !v.ok ? `rejected unverified numbers: ${v.unverified.join(', ')}` : 'invented number accepted'];
});

attack('missing-reading-resets-brake', 'A missing reading is used to quietly reset an armed brake', () => {
  const b = runBrake([{ quarter: 'a', gap_lp: 3.4 }, { quarter: 'b', gap_lp: null }, { quarter: 'c', gap_lp: 3.4 }], { brake_trigger_log_points: 3, brake_release_log_points: 1, brake_successive_readings: 2 });
  const caught = b.current.phase === 'engaged';
  return [caught, caught ? 'count kept through the missing reading; brake engaged' : 'missing reading reset the brake'];
});

attack('community-agent-escape', 'A community agent tries to read secrets, write the repo and reach the internet', () => {
  const prefix = sandboxPrefix();
  if (!prefix) return [true, 'network isolation unavailable here (community agents are not run without it in the daily job)'];
  const dir = mkdtempSync(join(tmpdir(), 'redteam-agent-'));
  writeFileSync(join(dir, 'evil.js'), `const fs=require('fs');const r={env:Object.keys(process.env).filter(k=>/KEY|TOKEN|SECRET/i.test(k)).join(',')||'none'};try{fs.writeFileSync(${JSON.stringify(join(root, 'data', 'PWNED'))},'x');r.write='WROTE'}catch(e){r.write='blocked'}fetch('https://example.com').then(()=>{r.net='OPEN';o()}).catch(()=>{r.net='blocked';o()});function o(){console.log(JSON.stringify({status:'info',headline:'probe',findings:Object.entries(r).map(([k,v])=>({label:k,value:v}))}))}`);
  const res = runAgent(dir, { id: 'redteam-probe', command: ['node', 'evil.js'] }, '{}', prefix);
  rmSync(dir, { recursive: true, force: true });
  const f = Object.fromEntries((res.report?.findings || []).map((x) => [x.label, x.value]));
  const pwned = existsSync(join(root, 'data', 'PWNED'));
  if (pwned) rmSync(join(root, 'data', 'PWNED'));
  const caught = !pwned && f.write === 'blocked' && f.net === 'blocked' && f.env === 'none';
  return [caught, caught ? 'no secrets visible; repo write blocked; network blocked' : `sandbox leak: ${JSON.stringify(f)}${pwned ? ' (repo written!)' : ''}`];
});

async function aiIdeas() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || new Date().getUTCDay() !== 1) return null;
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: process.env.SWARM_REPORTER_MODEL || 'claude-haiku-5-5', max_tokens: 500, messages: [{ role: 'user', content: `You are a red-team reviewer for an open-source system that computes a public money rule from government data, seals each run in a hash-chained ledger, anchors checkpoints in Bitcoin, Sigstore and the Internet Archive, and runs community agents in a no-network sandbox. These attacks are already tested: ${attacks.map((a) => a.id).join(', ')}. Suggest exactly 3 NEW, concrete attacks a maintainer should test next, one line each. Return JSON: {"ideas":["...","...","..."]}` }] }),
    });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const b = await res.json(); const t = (b.content || []).map((c) => c.text || '').join('');
    const j = JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1));
    return { model: process.env.SWARM_REPORTER_MODEL || 'claude-haiku-5-5', ideas: (j.ideas || []).slice(0, 3).map((x) => String(x).slice(0, 240)) };
  } catch (e) { return { error: String(e.message).slice(0, 120) }; }
}

const ideas = await aiIdeas();
const prev = readJSON(join(root, 'data', 'redteam.json'), null);
const result = {
  ran_at: new Date().toISOString(),
  all_caught: attacks.every((a) => a.caught),
  attacks,
  ai_ideas: ideas ?? prev?.ai_ideas ?? null,
};
writeJSON(join(root, 'data', 'redteam.json'), result);
for (const a of attacks) console.log(`${a.caught ? 'CAUGHT' : 'MISSED'}  ${a.id}: ${a.detail}`);
