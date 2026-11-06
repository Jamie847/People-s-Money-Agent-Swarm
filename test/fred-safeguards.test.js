import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, cpSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { download, runSensors, fredJsonToCsv, fredApiUrl, scrub, parseFredCsv } from '../src/agents/sensors.js';
import { fredApiGate, fredParityEvidence, summarizeFredApi } from '../src/lib/fred-api-policy.js';
import { runLiveTrack } from '../src/agents/tracks.js';
import { sha256 } from '../src/lib/util.js';

const src = { id: 'CPI', series: 'CPIAUCSL', start: '1998-01-01', transport: 'fred' };
const csv = 'observation_date,CPIAUCSL\n2026-08-01,321.25\n2026-09-01,322.5\n';
const api = JSON.stringify({ count: 2, offset: 0, observations: [
  { date: '2026-08-01', value: '321.25' }, { date: '2026-09-01', value: '322.5' },
] });
const key = 'fixture-key-not-a-real-credential';
const evidence = fredParityEvidence(src, '2026-11-15', sha256(csv));
const summary = (sensors, options = {}) => summarizeFredApi(sensors, { keyPresent: true, offline: false, useFrom: '2026-11-16', ...options });

function work(t) {
  const dir = mkdtempSync(join(tmpdir(), 'fred-safeguards-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function sensor(t, options = {}, replies = {}) {
  const inputsDir = work(t);
  writeFileSync(join(inputsDir, 'CPI.csv'), csv);
  const calls = [];
  const downloadFn = async (url, opts) => {
    calls.push({ url, opts });
    const response = url.includes('api.stlouisfed.org') ? (replies.api ?? api) : (replies.csv ?? csv);
    if (response instanceof Error) throw response;
    return response;
  };
  const results = await runSensors([src], {
    inputsDir, fredKey: key, today: '2026-11-16', fredApiFrom: '2026-11-16', downloadFn, ...options,
  });
  return { result: results[0], results, calls, stored: readFileSync(join(inputsDir, 'CPI.csv'), 'utf8') };
}

test('Nov 15 uses CSV even with prior parity and a mistakenly earlier configuration', async (t) => {
  const r = await sensor(t, { today: '2026-11-15', fredApiFrom: '2026-11-01', fredParity: { CPI: { ...evidence, checked_on: '2026-11-14' } } });
  assert.equal(r.result.via, 'fredgraph-csv');
  assert.match(r.result.api_cutover_blocked, /November 15/);
  assert.equal(r.stored, csv);
  assert.equal(r.calls[0].opts.timeoutMs, 5000);
});

test('the date alone never switches; a successful comparison only unlocks a later day', async (t) => {
  const first = await sensor(t);
  assert.equal(first.result.via, 'fredgraph-csv');
  assert.equal(first.result.api_parity, 'identical');
  const proof = summary(first.results).parity_evidence;
  const sameDay = await sensor(t, { fredParity: proof });
  assert.equal(sameDay.result.via, 'fredgraph-csv');
  const nextDay = await sensor(t, { fredParity: proof, today: '2026-11-17' });
  assert.equal(nextDay.result.via, 'fred-api');
  // After the switch the CSV is still checked on every run, and the evidence is refreshed.
  assert.equal(nextDay.calls.length, 2);
  assert.deepEqual(nextDay.calls[1].opts, { attempts: 1, timeoutMs: 30000 });
  assert.equal(summary(nextDay.results).parity_evidence.CPI.checked_on, '2026-11-17');
});

test('a later configured date remains a gate after the hard floor', async (t) => {
  const r = await sensor(t, { fredApiFrom: '2026-12-01', fredParity: { CPI: evidence } });
  assert.equal(r.result.via, 'fredgraph-csv');
  assert.match(r.result.api_cutover_blocked, /configured/);
});

test('missing, malformed, future, mismatched and wrong-source certificates fail closed', () => {
  const bad = [undefined, {}, null, { ...evidence, schema: 0 }, { ...evidence, status: 'different' },
    { ...evidence, series: 'PCEPI' }, { ...evidence, start: '2000-01-01' },
    { ...evidence, checked_on: '2026-11-16' }, { ...evidence, checked_on: '2026-11-17' },
    { ...evidence, checked_on: '2026-02-30' }, { ...evidence, csv_sha256: 'f'.repeat(64) },
    { ...evidence, api_sha256: 'fake', csv_sha256: 'fake' }];
  for (const proof of bad) assert.ok(fredApiGate(src, { today: '2026-11-16', useFrom: '2026-11-16', evidence: proof }));
  assert.equal(fredApiGate(src, { today: '2026-11-16', useFrom: '2026-11-16', evidence }), null);
  for (const useFrom of [undefined, '', 'oops', '2026-02-30']) assert.ok(fredApiGate(src, { today: '2026-11-16', useFrom, evidence }));
  assert.ok(fredApiGate(src, { today: 'oops', useFrom: '2026-11-16', evidence }));
});

test('mismatch, including an extra trailing CSV row, produces no approval', async (t) => {
  const r = await sensor(t, {}, { csv: `${csv}2026-10-01,323.0\n` });
  assert.equal(r.result.api_parity, 'different');
  assert.equal(r.result.api_first_difference.line, 4);
  assert.deepEqual(summary(r.results).parity_evidence, {});
  assert.equal(r.result.last.value, 323);
});

const badResponses = [
  ['empty', { observations: [] }],
  ['all missing', { observations: [{ date: '2026-08-01', value: '.' }] }],
  ['missing date', { observations: [{ value: '1' }] }],
  ['invalid date', { observations: [{ date: '2026-02-30', value: '1' }] }],
  ['missing value', { observations: [{ date: '2026-08-01' }] }],
  ['blank value', { observations: [{ date: '2026-08-01', value: '' }] }],
  ['non-finite', { observations: [{ date: '2026-08-01', value: 'Infinity' }] }],
  ['overflow', { observations: [{ date: '2026-08-01', value: '1e999' }] }],
  ['non-string', { observations: [{ date: '2026-08-01', value: null }] }],
  ['comma injection', { observations: [{ date: '2026-08-01', value: '1,2' }] }],
  ['duplicate', { observations: [{ date: '2026-08-01', value: '1' }, { date: '2026-08-01', value: '2' }] }],
  ['out of order', { observations: [{ date: '2026-09-01', value: '1' }, { date: '2026-08-01', value: '2' }] }],
  ['partial page', { count: 2, observations: [{ date: '2026-08-01', value: '1' }] }],
  ['nonzero offset', { offset: 1, observations: [{ date: '2026-08-01', value: '1' }] }],
  ['error response', { error_code: 400, error_message: 'Bad request' }],
  ['null', null],
];
for (const [name, body] of badResponses) {
  test(`invalid API response (${name}) falls back before it can overwrite the archive`, async (t) => {
    const r = await sensor(t, { fredParity: { CPI: evidence } }, { api: JSON.stringify(body) });
    assert.equal(r.result.via, 'fredgraph-csv (API fallback)');
    assert.equal(r.result.ok, true);
    assert.ok(r.result.api_error);
    assert.equal(r.stored, csv);
    assert.deepEqual(summary(r.results).parity_evidence, {});
  });
}

test('broken JSON falls back, and valid missing values remain missing', async (t) => {
  const r = await sensor(t, { fredParity: { CPI: evidence } }, { api: '{broken' });
  assert.equal(r.result.via, 'fredgraph-csv (API fallback)');
  const converted = fredJsonToCsv('X', JSON.stringify({ observations: [{ date: '2026-08-01', value: '.' }, { date: '2026-09-01', value: '-1.5' }] }));
  assert.equal(converted, 'observation_date,X\n2026-08-01,\n2026-09-01,-1.5\n');
  assert.deepEqual(parseFredCsv(converted), [{ date: '2026-09-01', value: -1.5 }]);
});

test('timeout and total failure stay visible, scrub secrets, and retain the old archive', async (t) => {
  const r = await sensor(t, { fredParity: { CPI: evidence } }, {
    api: new Error(`timeout ${fredApiUrl(src, key)}`), csv: new Error('CSV unavailable'),
  });
  assert.equal(r.result.ok, false);
  assert.equal(r.result.via, undefined);
  assert.equal(r.stored, csv);
  assert.equal(summary(r.results).api_errors.length, 1);
  assert.deepEqual(summary(r.results).parity_evidence, {});
  assert.ok(!JSON.stringify(r.result).includes(key));
});

test('invalid keyless responses cannot overwrite an existing archive', async (t) => {
  for (const bad of ['<html>failure</html>', 'observation_date,CPIAUCSL\n']) {
    const r = await sensor(t, { fredKey: '' }, { csv: bad });
    assert.equal(r.result.ok, false);
    assert.equal(r.stored, csv);
  }
});

test('no key uses only CSV and cannot manufacture parity', async (t) => {
  const r = await sensor(t, { fredKey: '', fredParity: { CPI: evidence } });
  assert.equal(r.calls.length, 1);
  assert.ok(!r.calls[0].url.includes('api.stlouisfed.org'));
  assert.deepEqual(summary(r.results, { keyPresent: false }).parity_evidence, {});
});

test('offline does not fetch, modify archives or create evidence, even with a key', async (t) => {
  const r = await sensor(t, { offline: true, fredParity: { CPI: evidence } });
  assert.equal(r.calls.length, 0);
  assert.equal(r.stored, csv);
  assert.equal(summary(r.results, { offline: true }).mode, 'offline');
  assert.deepEqual(summary(r.results).parity_evidence, {});
});

test('URL encoding cannot leak a key into recorded diagnostics', () => {
  const special = 'fixture +/&=?';
  const url = fredApiUrl(src, special);
  assert.equal(new URL(url).searchParams.get('api_key'), special);
  const cleaned = scrub(`error ${special} ${url}`, special);
  assert.ok(!cleaned.includes(special));
  assert.ok(!cleaned.includes(encodeURIComponent(special)));
  assert.ok(!scrub('https://example.invalid?api_key=unknown&x=1', '').includes('unknown'));
});

test('download applies a child-process deadline and keeps the curl result', async () => {
  let seen;
  const text = await download('https://example.invalid', { timeoutMs: 100,
    exec: (cmd, args, options) => { seen = { cmd, args, options }; return 'fixture'; },
    fetchImpl: () => { throw new Error('should not fetch'); },
  });
  assert.equal(text, 'fixture');
  assert.equal(seen.cmd, 'curl');
  assert.ok(seen.options.timeout > 0 && seen.options.timeout <= 100);
  assert.equal(seen.options.killSignal, 'SIGKILL');
  assert.ok(Number(seen.args[seen.args.indexOf('-m') + 1]) <= 0.1);
});

test('fetch fallback is bounded while waiting for response headers', async () => {
  let signal;
  await assert.rejects(download('https://example.invalid', { attempts: 1, timeoutMs: 30,
    exec: () => { throw new Error('curl failed'); },
    fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
      signal = options.signal;
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }),
  }), /download failed/);
  assert.equal(signal.aborted, true);
});

test('fetch fallback stays bounded while consuming the response body', async () => {
  let signal;
  await assert.rejects(download('https://example.invalid', { attempts: 1, timeoutMs: 30,
    exec: () => { throw new Error('curl failed'); },
    fetchImpl: async (_url, options) => {
      signal = options.signal;
      return { ok: true, text: () => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted body')), { once: true });
      }) };
    },
  }), /download failed/);
  assert.equal(signal.aborted, true);
});

test('download retries HTTP failures, and successful fetch fallback returns text', async () => {
  let tries = 0;
  assert.equal(await download('https://example.invalid', { attempts: 2, timeoutMs: 5000,
    exec: () => { throw new Error('curl failed'); },
    fetchImpl: async () => ++tries === 1 ? { ok: false, status: 429 } : { ok: true, text: async () => 'fixture' },
  }), 'fixture');
  assert.equal(tries, 2);
});

test('download rejects invalid budgets and does not sleep after its final attempt', async () => {
  for (const options of [{ attempts: 0 }, { timeoutMs: 0 }, { timeoutMs: Infinity }]) {
    await assert.rejects(download('https://example.invalid', options), /Invalid download budget/);
  }
  let errorSignal;
  await assert.rejects(download('https://example.invalid', { attempts: 1, timeoutMs: 100,
    exec: () => { throw new Error('curl failed'); }, fetchImpl: async (_url, { signal }) => {
      errorSignal = signal;
      return { ok: false, status: 500 };
    },
  }), /HTTP 500/);
  assert.equal(errorSignal.aborted, true, 'Unconsumed HTTP error bodies must be closed');
});

test('all archived FRED fixtures retain identical bytes across comparison and approved API mode', async (t) => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const { sources } = JSON.parse(readFileSync(join(root, 'config/sources.json'), 'utf8'));
  const inputsDir = work(t);
  const stored = Object.fromEntries(sources.map((s) => [s.id, readFileSync(join(root, 'data/inputs', `${s.id}.csv`), 'utf8')]));
  const downloadFn = async (url) => {
    const u = new URL(url);
    const series = u.searchParams.get('series_id') || u.searchParams.get('id');
    const source = sources.find((s) => s.series === series || (s.transport === 'bis' && url.includes(s.series)));
    assert.ok(source, 'Only known fixture sources may be requested');
    const text = stored[source.id];
    if (!u.searchParams.has('series_id')) return text;
    const observations = text.trim().split('\n').slice(1).map((line) => {
      const [date, value] = line.split(','); return { date, value: value || '.' };
    });
    return JSON.stringify({ count: observations.length, offset: 0, observations });
  };
  const first = await runSensors(sources, { inputsDir, fredKey: key, today: '2026-11-15', fredApiFrom: '2026-11-16', downloadFn });
  const proof = summary(first).parity_evidence;
  assert.equal(Object.keys(proof).length, sources.filter((s) => s.transport === 'fred').length);
  const second = await runSensors(sources, { inputsDir, fredKey: key, today: '2026-11-16', fredApiFrom: '2026-11-16', fredParity: proof, downloadFn });
  for (const result of second) {
    assert.equal(result.ok, true, result.id);
    assert.equal(result.sha256, sha256(stored[result.id]), result.id);
    assert.equal(readFileSync(join(inputsDir, `${result.id}.csv`), 'utf8'), stored[result.id]);
    if (result.id !== 'OFFSHORE_CREDIT') assert.equal(result.via, 'fred-api');
  }
});

test('a Nov 15 reading remains frozen after later inputs change; monetary configuration is untouched', async (t) => {
  const original = fileURLToPath(new URL('..', import.meta.url));
  const root = work(t);
  for (const dir of ['config', 'src', 'scripts']) cpSync(join(original, dir), join(root, dir), { recursive: true });
  mkdirSync(join(root, 'data'), { recursive: true });
  cpSync(join(original, 'data/inputs'), join(root, 'data/inputs'), { recursive: true });
  cpSync(join(original, 'data/live-history.json'), join(root, 'data/live-history.json'));
  const ruleText = readFileSync(join(root, 'config/rule.json'), 'utf8');
  const rule = JSON.parse(ruleText);
  const history = JSON.parse(readFileSync(join(root, 'data/live-history.json'), 'utf8'));
  const { sources } = JSON.parse(readFileSync(join(root, 'config/sources.json'), 'utf8'));
  const results = await runSensors(sources, { inputsDir: join(root, 'data/inputs'), offline: true, fredKey: '' });
  const sensorById = Object.fromEntries(results.map((r) => [r.id, r]));
  const first = await runLiveTrack({ root, sensorById, rule, today: '2026-11-15', history, offline: true });
  const frozen = JSON.stringify(first.history);
  assert.ok(first.history.some((h) => h.computation_date === '2026-11-15'));
  for (const id of ['CPI', 'PCE', 'GDP']) sensorById[id].observations = sensorById[id].observations.map((o) => ({ ...o, value: o.value * 2 }));
  const second = await runLiveTrack({ root, sensorById, rule, today: '2026-11-16', history: first.history, offline: true });
  assert.equal(JSON.stringify(second.history), frozen);
  assert.equal(readFileSync(join(root, 'config/rule.json'), 'utf8'), ruleText);
});
