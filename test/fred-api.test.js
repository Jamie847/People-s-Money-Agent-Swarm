import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fredJsonToCsv, fredApiUrl, scrub, parseFredCsv } from '../src/agents/sensors.js';

test('FRED API JSON becomes exactly the fredgraph.csv layout, missing values included', () => {
  const json = JSON.stringify({ observations: [
    { realtime_start: '2026-11-05', realtime_end: '2026-11-05', date: '2025-09-01', value: '324.245' },
    { realtime_start: '2026-11-05', realtime_end: '2026-11-05', date: '2025-10-01', value: '.' },
    { realtime_start: '2026-11-05', realtime_end: '2026-11-05', date: '2025-11-01', value: '325.063' },
  ] });
  assert.equal(fredJsonToCsv('CPIAUCSL', json), 'observation_date,CPIAUCSL\n2025-09-01,324.245\n2025-10-01,\n2025-11-01,325.063\n');
});

test('the converted text parses to the same observations as the stored file', () => {
  const stored = readFileSync(new URL('../data/inputs/CPI.csv', import.meta.url), 'utf8');
  const rows = stored.trim().split('\n').slice(1).map((l) => { const [date, value] = l.split(','); return { date, value: value === '' ? '.' : value }; });
  const rebuilt = fredJsonToCsv('CPIAUCSL', JSON.stringify({ observations: rows }));
  assert.equal(rebuilt, stored);
  assert.deepEqual(parseFredCsv(rebuilt), parseFredCsv(stored));
});

test('a key never survives into a stored message', () => {
  const key = 'abcdef0123456789abcdef0123456789';
  const url = fredApiUrl({ series: 'CPIAUCSL', start: '1998-01-01' }, key);
  assert.ok(url.includes(key));
  const msg = scrub(`Command failed: curl -sS ${url}\ncurl: (22) 400`, key);
  assert.ok(!msg.includes(key));
  assert.ok(msg.includes('[key]'));
  assert.equal(scrub('nothing to hide', ''), 'nothing to hide');
});

test('a non-API response is rejected, not stored', () => {
  assert.throws(() => fredJsonToCsv('X', '{"error_code":400,"error_message":"Bad Request"}'), /Not a FRED API response/);
});
