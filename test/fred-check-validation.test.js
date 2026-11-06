import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSensors, parseFredCsv } from '../src/agents/sensors.js';
import { fredApiGate, fredEquivalenceEvidence, summarizeFredApi, validateFredCsv, evidenceQualifyingDate } from '../src/lib/fred-api-policy.js';

const src = { id: 'CPI', series: 'CPIAUCSL', start: '1998-01-01', transport: 'fred' };
const csv = 'observation_date,CPIAUCSL\n2026-08-01,321.250\n2026-09-01,322.500\n';
const apiCsv = 'observation_date,CPIAUCSL\n2026-08-01,321.25\n2026-09-01,322.5\n';
const apiJson = (v = '322.5') => JSON.stringify({ count: 2, offset: 0, observations: [
  { date: '2026-08-01', value: '321.25' }, { date: '2026-09-01', value: v } ] });
const key = 'fixture-key-not-a-real-credential';
const ev = (checked_on, extra = {}) => ({ ...fredEquivalenceEvidence(src, checked_on, 'a'.repeat(64), 'b'.repeat(64), 2), ...extra });
const D = '2026-11-20';
const gate = (evidence, today = D) => fredApiGate(src, { today, useFrom: '2026-11-16', evidence });

async function run(t, { today = D, evidence, api = apiJson(), csvReply = csv } = {}) {
  const inputsDir = mkdtempSync(join(tmpdir(), 'fred-check-'));
  t.after(() => rmSync(inputsDir, { recursive: true, force: true }));
  writeFileSync(join(inputsDir, 'CPI.csv'), csv);
  const downloadFn = async (url) => {
    const r = url.includes('api.stlouisfed.org') ? api : csvReply;
    if (r instanceof Error) throw r;
    return r;
  };
  const results = await runSensors([src], { inputsDir, fredKey: key, today, fredApiFrom: '2026-11-16', fredParity: evidence ? { CPI: evidence } : {}, downloadFn });
  const s = summarizeFredApi(results, { keyPresent: true, offline: false, useFrom: '2026-11-16' });
  return { r: results[0], s, ev: s.parity_evidence.CPI, stored: readFileSync(join(inputsDir, 'CPI.csv'), 'utf8') };
}

const malformed = {
  'wrong series header': 'observation_date,PCEPI\n2026-08-01,321.250\n2026-09-01,322.500\n',
  'extra column': 'observation_date,CPIAUCSL\n2026-08-01,321.250,x\n2026-09-01,322.500\n',
  'invalid date': 'observation_date,CPIAUCSL\n2026-08-01,321.250\n2026-02-30,322.500\n',
  'impossible month': 'observation_date,CPIAUCSL\n2026-13-01,321.250\n',
  'out of order': 'observation_date,CPIAUCSL\n2026-09-01,322.500\n2026-08-01,321.250\n',
  'duplicate date': 'observation_date,CPIAUCSL\n2026-08-01,321.250\n2026-08-01,321.250\n',
  'unsupported value': 'observation_date,CPIAUCSL\n2026-08-01,NaN\n2026-09-01,322.500\n',
  'html error page': '<html><body>Service unavailable</body></html>',
  'header only': 'observation_date,CPIAUCSL\n',
};

test('the strict comparison check accepts real fredgraph layout and rejects malformed files', () => {
  assert.equal(validateFredCsv(csv, 'CPIAUCSL').ok, true);
  assert.equal(validateFredCsv(apiCsv, 'CPIAUCSL').ok, true);
  assert.equal(validateFredCsv('observation_date,DGS10\n2019-01-01,\n2019-01-02,2.66\n2019-01-03,.\n', 'DGS10').ok, true);
  for (const [name, text] of Object.entries(malformed)) assert.equal(validateFredCsv(text, 'CPIAUCSL').ok, false, name);
});

test('ALFRED vintage layouts still parse through the general parser (unchanged)', () => {
  const vintage = 'observation_date,CPIAUCSL_20261115\n2026-08-01,321.250\n2026-09-01,.\n';
  assert.deepEqual(parseFredCsv(vintage), [{ date: '2026-08-01', value: 321.25 }]);
  assert.deepEqual(parseFredCsv('DATE,CPIAUCSL_20261115\n2026-08-01,321.25\n'), [{ date: '2026-08-01', value: 321.25 }]);
});

test('after the switch, a malformed CSV check is an unavailable check: API data kept, old certificate ages', async (t) => {
  for (const [name, csvReply] of Object.entries(malformed)) {
    const { r, s, ev: e, stored } = await run(t, { evidence: ev('2026-11-19'), csvReply });
    assert.equal(r.via, 'fred-api', name);
    assert.equal(stored, apiCsv, name);
    assert.equal(s.parity_different.length, 0, name);
    assert.equal(s.csv_check_errors.length, 1, name);
    assert.equal(e.checked_on, '2026-11-19', name);
  }
});

test('before the switch, a malformed CSV never qualifies the source and is not called a disagreement', async (t) => {
  for (const [name, csvReply] of Object.entries(malformed)) {
    const { r, s, ev: e } = await run(t, { today: '2026-11-14', csvReply });
    assert.equal(e, undefined, name);
    assert.equal(r.api_parity, undefined, name);
    assert.equal(s.parity_different.length, 0, name);
  }
});

test('same-day reruns: a renewed check keeps the earlier day, so a second run stays eligible', async (t) => {
  const first = await run(t, { evidence: ev('2026-11-19') });
  assert.equal(first.r.via, 'fred-api');
  assert.equal(first.ev.checked_on, D);
  assert.equal(first.ev.prior_checked_on, '2026-11-19');
  assert.equal(gate(first.ev), null);

  const matching = await run(t, { evidence: first.ev });
  assert.equal(matching.r.via, 'fred-api');
  assert.equal(matching.ev.prior_checked_on, '2026-11-19'); // a third run would still qualify
  assert.equal(gate(matching.ev), null);

  const unavailable = await run(t, { evidence: first.ev, csvReply: new Error('timeout') });
  assert.equal(unavailable.r.via, 'fred-api');
  assert.equal(unavailable.r.ok, true);
  assert.deepEqual(unavailable.ev, first.ev);

  const mismatching = await run(t, { evidence: first.ev, api: apiJson('322.6') });
  assert.equal(mismatching.r.via, 'fredgraph-csv (API differed)');
  assert.equal(mismatching.ev, undefined);
  assert.match(gate(mismatching.ev), /no valid prior-day/);
  // Next day, yesterday's renewed check qualifies on its own date.
  assert.equal(evidenceQualifyingDate(src, first.ev, '2026-11-21'), D);
});

test('same-day qualification still expires, and a first-ever same-day comparison never qualifies', async (t) => {
  assert.match(gate(ev(D, { prior_checked_on: '2026-11-16' })), /older than 3 days/);
  assert.equal(gate(ev(D, { prior_checked_on: '2026-11-17' })), null);
  assert.match(gate(ev(D)), /no valid prior-day/);
  for (const bad of [D, '2026-11-21', '2026-02-30', 'yesterday', 20261119]) {
    assert.match(gate(ev(D, { prior_checked_on: bad })), /no valid prior-day/, String(bad));
  }
  const firstEver = await run(t, { today: '2026-11-14' });
  assert.equal(firstEver.ev.prior_checked_on, undefined);
  assert.match(gate(firstEver.ev, '2026-11-14'), /protected/);
  assert.match(fredApiGate(src, { today: '2026-11-16', useFrom: '2026-11-16', evidence: { ...firstEver.ev, checked_on: '2026-11-16' } }), /no valid prior-day/);
  // Stale evidence on day D, renewed on D: the carried prior is still too old for a rerun.
  const stale = await run(t, { evidence: ev('2026-11-15') });
  assert.equal(stale.r.via, 'fredgraph-csv');
  assert.equal(stale.ev.prior_checked_on, '2026-11-15');
  assert.match(gate(stale.ev), /older than 3 days/);
});
