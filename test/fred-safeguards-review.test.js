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
