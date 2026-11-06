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
      assert.match(r.error, /switched source: file failed the strict check/, label);
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
