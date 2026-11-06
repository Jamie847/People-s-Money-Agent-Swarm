import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSensors, fredJsonToCsv } from '../src/agents/sensors.js';
import { fredApiGate, fredEquivalenceEvidence, summarizeFredApi, fredValuesEquivalent } from '../src/lib/fred-api-policy.js';

// Review round 4 (dot): the API reader accepted scientific notation that the comparison rejects, so a
// disagreeing API value could be kept while the comparison was treated as "unavailable".
const src = { id: 'CPI', series: 'CPIAUCSL', start: '1998-01-01', transport: 'fred' };
const csv = 'observation_date,CPIAUCSL\n2026-08-01,321.250\n2026-09-01,322.500\n';
const apiJson = (v) => JSON.stringify({ count: 2, offset: 0, observations: [
  { date: '2026-08-01', value: '321.25' }, { date: '2026-09-01', value: v } ] });
const key = 'fixture-key-not-a-real-credential';
const ev = (d) => fredEquivalenceEvidence(src, d, 'a'.repeat(64), 'b'.repeat(64), 2);

async function run(t, { today, evidence, api, csvReply = csv }) {
  const inputsDir = mkdtempSync(join(tmpdir(), 'fred-notation-'));
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

test('the API reader rejects scientific notation, the same as the comparison', () => {
  for (const v of ['3.226e2', '3.225E2', '1e3', '2.5e+1', '5E-1', '1e999']) {
    assert.throws(() => fredJsonToCsv('CPIAUCSL', apiJson(v)), /Invalid FRED observation value/, v);
  }
  for (const v of ['322.5', '+322.5', '-0.25', '.5', '0']) assert.doesNotThrow(() => fredJsonToCsv('CPIAUCSL', apiJson(v)), v);
});

test('after the switch, an API value in scientific notation is a failed API response: CSV used, certificate removed', async (t) => {
  for (const v of ['3.226e2', '3.225e2']) { // disagreeing and agreeing values: neither may be used
    const { r, s, ev: e, stored } = await run(t, { today: '2026-11-20', evidence: ev('2026-11-19'), api: apiJson(v) });
    assert.equal(r.via, 'fredgraph-csv (API fallback)', v);
    assert.equal(stored, csv, v);
    assert.equal(r.ok, true, v);
    assert.equal(s.api_errors.length, 1, v);
    assert.equal(s.csv_check_errors.length, 0, v);
    assert.equal(e, undefined, v);
    assert.match(fredApiGate(src, { today: '2026-11-21', useFrom: '2026-11-16', evidence: e }), /no valid prior-day/, v);
  }
});

test('before the switch, scientific notation in the API never qualifies the source', async (t) => {
  const { r, s, ev: e } = await run(t, { today: '2026-11-14', api: apiJson('3.225e2') });
  assert.equal(r.via, 'fredgraph-csv');
  assert.equal(e, undefined);
  assert.equal(s.api_errors.length, 1);
  assert.equal(s.parity_different.length, 0);
});

test('the comparison tells an invalid API text apart from an invalid CSV check (API checked first)', () => {
  const good = 'observation_date,CPIAUCSL\n2026-08-01,321.25\n';
  const sci = 'observation_date,CPIAUCSL\n2026-08-01,3.2125e2\n';
  const badCsv = 'observation_date,PCEPI\n2026-08-01,321.25\n';
  assert.equal(fredValuesEquivalent(sci, good, 'CPIAUCSL').apiInvalid, true);
  assert.equal(fredValuesEquivalent(sci, badCsv, 'CPIAUCSL').apiInvalid, true); // both bad: still an API failure
  const csvOnly = fredValuesEquivalent(good, badCsv, 'CPIAUCSL');
  assert.equal(csvOnly.unavailable, true);
  assert.equal(csvOnly.apiInvalid, undefined);
});
