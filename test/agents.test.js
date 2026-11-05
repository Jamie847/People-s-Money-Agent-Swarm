import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendLedger, readLedger, verifyLedger } from '../src/agents/ledger.js';
import { classify, metricValue } from '../src/agents/sentinels.js';
import { parseFredCsv, parseBisCsv } from '../src/agents/sensors.js';
import { allowedNumbers, verifyNumbers, runReporter } from '../src/agents/reporter.js';
import { shadowInstruction } from '../src/agents/executor.js';
import { writeFileSync } from 'node:fs';

test('sensors keep missing values missing', () => {
  const obs = parseFredCsv('observation_date,X\n2026-01-01,1.5\n2026-02-01,.\n2026-03-01,2\n');
  assert.deepEqual(obs.map((o) => o.date), ['2026-01-01', '2026-03-01']);
});

test('BIS parser maps quarters to dates', () => {
  const obs = parseBisCsv('FREQ,TITLE,TIME_PERIOD,OBS_VALUE\nQ,"a, b",2026-Q2,15\nQ,x,2026-Q1,14\n');
  assert.deepEqual(obs, [{ date: '2026-01-01', value: 14 }, { date: '2026-04-01', value: 15 }]);
});

test('ledger: chain verifies, and any edit to an old entry is detected', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-'));
  const p = join(dir, 'ledger.jsonl');
  appendLedger(p, { run_date: '2026-11-01', x: 1 });
  appendLedger(p, { run_date: '2026-11-08', x: 2 });
  appendLedger(p, { run_date: '2026-11-15', x: 3 });
  assert.equal(verifyLedger(readLedger(p)).ok, true);
  const entries = readLedger(p);
  entries[1].x = 999;
  writeFileSync(p, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const v = verifyLedger(readLedger(p));
  assert.equal(v.ok, false);
  assert.equal(v.at, 1);
});

test('sentinel thresholds: up and down directions', () => {
  assert.equal(classify(60, { watch: 10, stress: 50 }), 'stress');
  assert.equal(classify(12, { watch: 10, stress: 50 }), 'watch');
  assert.equal(classify(-7, { watch: -3, stress: -6, direction: 'down' }), 'stress');
  assert.equal(classify(-1, { watch: -3, stress: -6, direction: 'down' }), 'calm');
  assert.equal(classify(5, { watch: null, stress: null }), 'context');
});

test('sentinel metrics', () => {
  const obs = Array.from({ length: 14 }, (_, i) => ({ date: `2026-01-${String(i + 1).padStart(2, '0')}`, value: i === 13 ? 90 : 100 }));
  assert.ok(Math.abs(metricValue('pct_change_13w', obs) + 10) < 1e-9);
  assert.equal(metricValue('level_billions', [{ date: 'x', value: 2500 }]), 2.5);
});

test('reporter: numbers not in the facts are caught', () => {
  const allowed = allowedNumbers({ gap: 0.53, allowance: 2.2, q: '2026-Q3' });
  assert.equal(verifyNumbers('Prices are 0.53 points above target; path growth 2.2% in 2026.', allowed).ok, true);
  const bad = verifyNumbers('The rule would issue $47 billion.', allowed);
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.unverified, ['47']);
});

const fakeLatest = {
  run: { date: '2026-11-15' },
  live: { epoch: '2026-Q2', latest: { quarter: '2026-Q3', computation_date: '2026-11-15', outputs: { trend_growth_pct: 2.4658, gap_lp: 0.71, allowance_pct: 2.11, quarterly_step_pct: 0.5236 }, consensus: { agreed: true } }, brake: { phase: 'off', note: 'Brake not needed.' }, next: { quarter: '2026-Q4', computation_date: '2027-02-15' } },
  sentinels: { global_dollar: { overall: 'calm', readings: [] }, domestic: { overall: 'calm', readings: [] } },
  packets: [],
  replays: [],
};

test('reporter: falls back to the template with no API key', async () => {
  const r = await runReporter(fakeLatest, { apiKey: '' });
  assert.equal(r.source, 'template');
  assert.match(r.paragraphs[0], /2026-Q3/);
});

test('reporter: accepts AI text whose numbers all check out', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ content: [{ type: 'text', text: JSON.stringify({ headline: 'Rule allows 2.11% path growth for 2026-Q3', paragraphs: ['Prices sat 0.71 log points above target.', 'Unofficial shadow run; nothing executed.'] }) }] }) });
  const r = await runReporter(fakeLatest, { apiKey: 'k', fetchImpl });
  assert.equal(r.source, 'ai');
});

test('reporter: rejects AI text that invents a number', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ content: [{ type: 'text', text: JSON.stringify({ headline: 'Rule would print $310 billion', paragraphs: ['x'] }) }] }) });
  const r = await runReporter(fakeLatest, { apiKey: 'k', fetchImpl });
  assert.equal(r.source, 'template');
  assert.match(r.reason, /310/);
});

test('executor refuses without agreement', () => {
  const r = shadowInstruction({ liveLatest: { quarter: '2026-Q3', complete: true, missing: [] }, consensusResult: { agreed: false }, brake: { current: { phase: 'off' } } });
  assert.equal(r.authorized, false);
  assert.equal(r.executed, false);
});

import { validateManifest, validateReport } from '../scripts/community.js';

test('community: manifest rules (id matches folder, allowed interpreter, no paths outside the folder)', () => {
  const ok = { id: 'my-agent', name: 'x', author: 'y', description: 'z', role: 'sentinel', command: ['python3', 'agent.py'] };
  assert.deepEqual(validateManifest(ok, 'my-agent'), []);
  assert.ok(validateManifest({ ...ok, command: ['bash', 'x.sh'] }, 'my-agent').length);
  assert.ok(validateManifest({ ...ok, command: ['node', '../../scripts/run.js'] }, 'my-agent').length);
  assert.ok(validateManifest({ ...ok, role: 'executor' }, 'my-agent').length);
  assert.ok(validateManifest(ok, 'other-folder').length);
});

test('community: report rules', () => {
  assert.deepEqual(validateReport({ status: 'watch', headline: 'Funding is tight', findings: [{ label: 'spread', value: '0.2' }] }), []);
  assert.ok(validateReport({ status: 'execute', headline: 'x' }).length);
  assert.ok(validateReport({ status: 'ok', headline: 'x'.repeat(200) }).length);
  assert.ok(validateReport({ status: 'ok', headline: 'x', findings: Array(13).fill({ label: 'a' }) }).length);
});
