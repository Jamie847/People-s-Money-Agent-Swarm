import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSensors, download } from '../src/agents/sensors.js';
import { sha256 } from '../src/lib/util.js';

const SRC = [{ id: 'CPI', series: 'CPIAUCSL', transport: 'fred', start: '1998-01-01' }];
const GOOD = 'observation_date,CPIAUCSL\n2025-09-01,324.245\n';

test('a rejected download is not fingerprinted as if it were archived', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rej-'));
  writeFileSync(join(dir, 'CPI.csv'), GOOD);
  const bad = '<html>Service temporarily unavailable</html>';
  const [r] = await runSensors(SRC, { inputsDir: dir, fredKey: '', downloadFn: async () => bad });
  assert.equal(r.ok, false);
  assert.equal(r.sha256, undefined);                 // nothing for the ledger to record
  assert.equal(r.rejected_sha256, sha256(bad));      // what was refused stays visible
  assert.equal(readFileSync(join(dir, 'CPI.csv'), 'utf8'), GOOD); // archive untouched
});

test('a valid download is archived and fingerprinted together', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ok-'));
  const [r] = await runSensors(SRC, { inputsDir: dir, fredKey: '', downloadFn: async () => GOOD });
  assert.equal(r.ok, true);
  assert.equal(r.sha256, sha256(readFileSync(join(dir, 'CPI.csv'), 'utf8')));
});

test('normal downloads keep a per-attempt cap and retry instead of spending the whole budget once', async () => {
  const seen = [];
  const exec = (_cmd, args, opts) => { seen.push({ m: Number(args[args.indexOf('-m') + 1]), timeout: opts.timeout }); if (seen.length < 2) throw new Error('slow'); return GOOD; };
  const fetchImpl = async () => { throw new Error('no fetch'); };
  const text = await download('https://example.invalid', { exec, fetchImpl, timeoutMs: 600000, perAttemptMs: 50 });
  assert.equal(text, GOOD);
  assert.ok(seen.length >= 2, 'retried');
  assert.ok(seen.every((c) => c.m <= 0.05 + 1e-9 && c.timeout <= 50), 'each attempt capped');
});

import { sourceRecord } from '../src/agents/sensors.js';

test('the saved source record keeps a refused download visible but out of the input fingerprint', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rec-'));
  writeFileSync(join(dir, 'CPI.csv'), GOOD);
  const bad = '<html>Service temporarily unavailable</html>';
  const sensors = await runSensors(SRC, { inputsDir: dir, fredKey: '', downloadFn: async () => bad });
  const saved = JSON.parse(JSON.stringify(sensors.map(sourceRecord)));  // exactly what run.js writes to latest.json
  assert.equal(saved[0].sha256, null);
  assert.equal(saved[0].rejected_sha256, sha256(bad));
  assert.equal(saved[0].ok, false);
  assert.match(saved[0].error, /Not a FRED CSV/);
  const inputs = Object.fromEntries(sensors.map((s) => [s.id, s.sha256 ?? null])); // exactly what run.js seals
  assert.deepEqual(inputs, { CPI: null });
});

test('the saved record of a good download has no rejected field, so normal output is unchanged', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rec2-'));
  const sensors = await runSensors(SRC, { inputsDir: dir, fredKey: '', downloadFn: async () => GOOD });
  const saved = JSON.parse(JSON.stringify(sensors.map(sourceRecord)));
  assert.equal('rejected_sha256' in saved[0], false);
  assert.deepEqual(Object.keys(saved[0]), ['id', 'series', 'agency', 'title', 'url', 'file', 'sha256', 'last', 'ok', 'error'].filter((k) => k in saved[0]));
});

test('timing: three attempts, each curl and fetch cut off at the per-attempt limit, with backoff between', async () => {
  const curls = []; const fetches = [];
  const exec = (_c, args, opts) => { curls.push({ m: Number(args[args.indexOf('-m') + 1]), timeout: opts.timeout, at: Date.now() }); throw new Error('curl failed'); };
  const fetchImpl = (_u, { signal }) => new Promise((_, reject) => {
    const started = Date.now();
    signal.addEventListener('abort', () => { fetches.push(Date.now() - started); reject(new Error('aborted')); });
  });
  const t0 = Date.now();
  await assert.rejects(download('https://example.invalid', { exec, fetchImpl, attempts: 3, perAttemptMs: 40, timeoutMs: 5000, backoffMs: 10 }), /after 3 attempts/);
  const elapsed = Date.now() - t0;
  assert.equal(curls.length, 3);
  assert.ok(curls.every((c) => c.m <= 0.04 + 1e-9 && c.timeout <= 40));
  assert.equal(fetches.length, 3);
  assert.ok(fetches.every((ms) => ms >= 35 && ms < 200), `fetch cut off near 40 ms: ${fetches}`);
  assert.ok(curls[1].at - curls[0].at >= 45, 'backoff after attempt 1');   // 40 ms fetch + 10 ms pause
  assert.ok(curls[2].at - curls[1].at >= 55, 'longer backoff after attempt 2'); // 40 ms fetch + 20 ms pause
  assert.ok(elapsed < 1500, `bounded: ${elapsed} ms`);
});

test('timing: the overall cap stops retries even when attempts remain', async () => {
  let calls = 0;
  const exec = () => { calls++; throw new Error('curl failed'); };
  const fetchImpl = (_u, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
  const t0 = Date.now();
  await assert.rejects(download('https://example.invalid', { exec, fetchImpl, attempts: 3, perAttemptMs: 100, timeoutMs: 150, backoffMs: 10 }), /timeout after 150ms|after [12] attempts/);
  assert.ok(Date.now() - t0 < 600);
  assert.ok(calls < 3);
});
