import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSensors } from '../src/agents/sensors.js';
import { fredApiGate, fredParityEvidence, fredEquivalenceEvidence, summarizeFredApi, FRED_PARITY_MAX_AGE_DAYS } from '../src/lib/fred-api-policy.js';
import { sha256 } from '../src/lib/util.js';

const src = { id: 'CPI', series: 'CPIAUCSL', start: '1998-01-01', transport: 'fred' };
const csv = 'observation_date,CPIAUCSL\n2026-08-01,321.250\n2026-09-01,322.500\n';
const apiJson = (v = '322.5') => JSON.stringify({ count: 2, offset: 0, observations: [
  { date: '2026-08-01', value: '321.25' }, { date: '2026-09-01', value: v } ] });
const key = 'fixture-key-not-a-real-credential';
const H = 'a'.repeat(64);
const old = (checked_on) => fredEquivalenceEvidence(src, checked_on, H, 'b'.repeat(64), 2);
const summary = (r) => summarizeFredApi(r, { keyPresent: true, offline: false, useFrom: '2026-11-16' });

async function run(t, { today = '2026-11-20', evidence = old('2026-11-19'), api = apiJson(), csvReply = csv } = {}) {
  const inputsDir = mkdtempSync(join(tmpdir(), 'fred-expiry-'));
  t.after(() => rmSync(inputsDir, { recursive: true, force: true }));
  writeFileSync(join(inputsDir, 'CPI.csv'), csv);
  const calls = [];
  const downloadFn = async (url, opts) => {
    calls.push({ api: url.includes('api.stlouisfed.org'), opts });
    const r = url.includes('api.stlouisfed.org') ? api : csvReply;
    if (r instanceof Error) throw r;
    return r;
  };
  const results = await runSensors([src], { inputsDir, fredKey: key, today, fredApiFrom: '2026-11-16', fredParity: { CPI: evidence }, downloadFn });
  return { r: results[0], s: summary(results), calls, stored: readFileSync(join(inputsDir, 'CPI.csv'), 'utf8') };
}

test(`evidence is trusted for ${FRED_PARITY_MAX_AGE_DAYS} days, then the source goes back to the CSV`, () => {
  const g = (checked_on) => fredApiGate(src, { today: '2026-11-20', useFrom: '2026-11-16', evidence: old(checked_on) });
  assert.equal(g('2026-11-19'), null);
  assert.equal(g('2026-11-17'), null);
  assert.match(g('2026-11-16'), /older than 3 days/);
  assert.match(g('2026-10-01'), /older than 3 days/);
  const ident = fredParityEvidence(src, '2026-11-01', sha256(csv));
  assert.match(fredApiGate(src, { today: '2026-11-20', useFrom: '2026-11-16', evidence: ident }), /older than 3 days/);
});

test('stale evidence: the CSV is authoritative again and a fresh comparison is recorded', async (t) => {
  const { r, s } = await run(t, { evidence: old('2026-11-10') });
  assert.equal(r.via, 'fredgraph-csv');
  assert.match(r.api_cutover_blocked, /older than/);
  assert.equal(s.parity_evidence.CPI.checked_on, '2026-11-20');
});

test('switched and matching: API data used, evidence refreshed today', async (t) => {
  const { r, s, calls, stored } = await run(t);
  assert.equal(r.via, 'fred-api');
  assert.equal(r.api_parity, 'equivalent');
  assert.deepEqual(calls.map((c) => c.api), [true, false]);
  assert.equal(s.parity_evidence.CPI.checked_on, '2026-11-20');
  assert.equal(stored, 'observation_date,CPIAUCSL\n2026-08-01,321.25\n2026-09-01,322.5\n');
});

test('switched but a number differs: today uses the CSV, evidence is dropped, the difference is reported', async (t) => {
  const { r, s, stored } = await run(t, { api: apiJson('322.6') });
  assert.equal(r.via, 'fredgraph-csv (API differed)');
  assert.equal(stored, csv);
  assert.equal(s.parity_evidence.CPI, undefined);
  assert.equal(s.parity_different.length, 1);
  assert.ok(s.parity_different[0].value_difference);
  // Next day: no evidence, so the source stays on the CSV.
  assert.match(fredApiGate(src, { today: '2026-11-21', useFrom: '2026-11-16', evidence: s.parity_evidence.CPI }), /no valid prior-day/);
});

test('switched but the CSV check fails or is unusable: API data kept, old evidence carried unchanged so it ages out', async (t) => {
  for (const csvReply of [new Error('timeout'), '<html>busy</html>', 'observation_date,CPIAUCSL\n']) {
    const { r, s } = await run(t, { csvReply });
    assert.equal(r.via, 'fred-api');
    assert.equal(s.csv_check_errors.length, 1);
    assert.equal(s.parity_evidence.CPI.checked_on, '2026-11-19');
    assert.match(fredApiGate(src, { today: '2026-11-23', useFrom: '2026-11-16', evidence: s.parity_evidence.CPI }), /older than/);
  }
});
