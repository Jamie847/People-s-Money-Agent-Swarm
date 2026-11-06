import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSensors } from '../src/agents/sensors.js';
import { fredEquivalenceEvidence, summarizeFredApi } from '../src/lib/fred-api-policy.js';
import { sha256 } from '../src/lib/util.js';

// Review round 5 (dot): after the switch, an invalid API response plus a CSV labelled for the wrong series
// was accepted and archived, because the CSV fallback went through the permissive general parser.
const src = { id: 'CPI', series: 'CPIAUCSL', start: '1998-01-01', transport: 'fred' };
const archived = 'observation_date,CPIAUCSL\n2026-07-01,320.000\n2026-08-01,321.250\n';
const csv = 'observation_date,CPIAUCSL\n2026-08-01,321.250\n2026-09-01,322.500\n';
const apiOk = JSON.stringify({ count: 2, offset: 0, observations: [{ date: '2026-08-01', value: '321.25' }, { date: '2026-09-01', value: '322.5' }] });
const apiBad = JSON.stringify({ count: 1, offset: 0, observations: [{ date: '2026-08-01', value: '3.2125e2' }] });
const key = 'fixture-key-not-a-real-credential';
const ev = fredEquivalenceEvidence(src, '2026-11-19', 'a'.repeat(64), 'b'.repeat(64), 2);

async function run(t, { today = '2026-11-20', evidence = ev, api, csvReply }) {
  const inputsDir = mkdtempSync(join(tmpdir(), 'fred-fallback-'));
  t.after(() => rmSync(inputsDir, { recursive: true, force: true }));
  writeFileSync(join(inputsDir, 'CPI.csv'), archived);
  const downloadFn = async (url) => {
    const r = url.includes('api.stlouisfed.org') ? api : csvReply;
    if (r instanceof Error) throw r;
    return r;
  };
  const results = await runSensors([src], { inputsDir, fredKey: key, today, fredApiFrom: '2026-11-16', fredParity: evidence ? { CPI: evidence } : {}, downloadFn });
  const s = summarizeFredApi(results, { keyPresent: true, offline: false, useFrom: '2026-11-16' });
  return { r: results[0], s, stored: readFileSync(join(inputsDir, 'CPI.csv'), 'utf8') };
}

const bad = {
  'wrong series': 'observation_date,PCEPI\n2026-08-01,321.250\n2026-09-01,322.500\n',
  'extra column': 'observation_date,CPIAUCSL\n2026-08-01,321.250,x\n2026-09-01,322.500\n',
  'out of order': 'observation_date,CPIAUCSL\n2026-09-01,322.500\n2026-08-01,321.250\n',
  'invalid date': 'observation_date,CPIAUCSL\n2026-02-30,321.250\n',
};

test('after the switch, two bad inputs (API failed or invalid, CSV fallback malformed) are rejected, not archived', async (t) => {
  for (const api of [new Error('HTTP 500'), apiBad]) {
    for (const [name, csvReply] of Object.entries(bad)) {
      const label = `${api instanceof Error ? 'API error' : 'API invalid'} + ${name}`;
      const { r, s, stored } = await run(t, { api, csvReply });
      assert.equal(r.ok, false, label);
      assert.equal(stored, archived, label);              // archive untouched
      assert.equal(r.sha256, undefined, label);           // nothing new enters the ledger
      assert.equal(r.rejected_sha256, sha256(csvReply), label);
      assert.match(r.error, /file failed the strict check/, label);
      assert.equal(s.parity_evidence.CPI, undefined, label);
    }
  }
});

test('after the switch, a valid CSV fallback is still archived when the API fails', async (t) => {
  for (const api of [new Error('HTTP 500'), apiBad]) {
    const { r, stored } = await run(t, { api, csvReply: csv });
    assert.equal(r.ok, true);
    assert.equal(r.via, 'fredgraph-csv (API fallback)');
    assert.equal(stored, csv);
  }
});

test('after the switch, a mismatching but valid CSV is archived; normal API data is unaffected', async (t) => {
  const mismatch = 'observation_date,CPIAUCSL\n2026-08-01,321.250\n2026-09-01,322.600\n';
  const a = await run(t, { api: apiOk, csvReply: mismatch });
  assert.equal(a.r.via, 'fredgraph-csv (API differed)');
  assert.equal(a.stored, mismatch);
  const b = await run(t, { api: apiOk, csvReply: csv });
  assert.equal(b.r.via, 'fred-api');
  assert.equal(b.r.ok, true);
});

test('before the switch the protected CSV route is unchanged (it keeps the general parser until after Nov 15)', async (t) => {
  const { r, stored } = await run(t, { today: '2026-11-14', evidence: null, api: new Error('HTTP 500'), csvReply: bad['wrong series'] });
  assert.equal(r.via, 'fredgraph-csv');
  assert.equal(r.ok, true);
  assert.equal(stored, bad['wrong series']);
});

// Review round 6 (dot): after both inputs are rejected the certificate is gone, so the next run takes the CSV
// route of a non-eligible source. From Nov 16 that route is strictly checked too, so the bad file still can't
// replace the archive, on the same day or later, with or without a key.
test('sequential: bad API + bad backup rejected, then reruns with the saved (empty) evidence still refuse the bad file', async (t) => {
  const badCsv = bad['wrong series'];
  const inputsDir = mkdtempSync(join(tmpdir(), 'fred-seq-'));
  t.after(() => rmSync(inputsDir, { recursive: true, force: true }));
  writeFileSync(join(inputsDir, 'CPI.csv'), archived);
  const downloadFn = async (url) => { if (url.includes('api.stlouisfed.org')) throw new Error('HTTP 500'); return badCsv; };
  const step = async (today, evidence, fredKey = key) => {
    const results = await runSensors([src], { inputsDir, fredKey, today, fredApiFrom: '2026-11-16', fredParity: evidence ? { CPI: evidence } : {}, downloadFn });
    const s = summarizeFredApi(results, { keyPresent: !!fredKey, offline: false, useFrom: '2026-11-16' });
    return { r: results[0], saved: s.parity_evidence.CPI };
  };
  const first = await step('2026-11-20', ev);
  assert.equal(first.r.ok, false);
  assert.equal(first.saved, undefined);                         // certificate removed
  for (const [today, fredKey] of [['2026-11-20', key], ['2026-11-21', key], ['2026-11-22', '']]) {
    const next = await step(today, first.saved, fredKey);
    assert.ok(fredKey ? next.r.api_cutover_blocked : true, today); // no longer API-eligible
    assert.equal(next.r.ok, false, today);
    assert.match(next.r.error, /failed the strict check/, today);
    assert.equal(next.r.rejected_sha256, sha256(badCsv), today);
    assert.equal(next.r.sha256, undefined, today);
  }
  assert.equal(readFileSync(join(inputsDir, 'CPI.csv'), 'utf8'), archived);
});

test('numbers too large for the parser are rejected by both readers', async (t) => {
  const huge = '1' + '0'.repeat(400);
  const { validateFredCsv } = await import('../src/lib/fred-api-policy.js');
  const { fredJsonToCsv } = await import('../src/agents/sensors.js');
  assert.equal(validateFredCsv(`observation_date,CPIAUCSL\n2026-08-01,${huge}\n`, 'CPIAUCSL').reason, 'value out of range');
  assert.equal(validateFredCsv(`observation_date,CPIAUCSL\n2026-08-01,-${huge}.5\n`, 'CPIAUCSL').ok, false);
  assert.throws(() => fredJsonToCsv('CPIAUCSL', JSON.stringify({ count: 1, offset: 0, observations: [{ date: '2026-08-01', value: huge }] })), /Invalid FRED observation value/);
  const { r, stored } = await run(t, { api: new Error('HTTP 500'), csvReply: `observation_date,CPIAUCSL\n2026-08-01,321.25\n2026-09-01,${huge}\n` });
  assert.equal(r.ok, false);
  assert.match(r.error, /value out of range/);
  assert.equal(stored, archived);
});
