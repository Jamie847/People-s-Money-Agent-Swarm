import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, cpSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildSite, scanSite, DATA_ALLOWLIST } from '../scripts/build-site.js';

// Review (dot, Nov 6): the published dashboard bundle still contained the 27 FRED files (the build copied all
// of data/) and observation histories in the JSON and inlined HTML. FRED's terms don't allow republishing them.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const strip = (latest) => { for (const g of Object.values(latest.sentinels || {})) for (const r of g.readings || []) delete r.history; return latest; };

function fixtureRoot(t, mutate = () => {}) {
  const root = mkdtempSync(join(tmpdir(), 'pub-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync(join(ROOT, 'dashboard'), join(root, 'dashboard'), { recursive: true });
  mkdirSync(join(root, 'data', 'inputs', 'vintages', '2026-11-15'), { recursive: true });
  for (const f of ['ledger.jsonl', 'witnesses.json', 'community.json', 'redteam.json', 'packets.json', 'live-history.json', 'packets-seen.json']) {
    if (existsSync(join(ROOT, 'data', f))) cpSync(join(ROOT, 'data', f), join(root, 'data', f));
  }
  cpSync(join(ROOT, 'data', 'checkpoints'), join(root, 'data', 'checkpoints'), { recursive: true });
  const latest = strip(JSON.parse(readFileSync(join(ROOT, 'data', 'latest.json'), 'utf8')));
  // Files that exist on the runner's disk during a run but must never be published.
  writeFileSync(join(root, 'data', 'inputs', 'CPI.csv'), 'observation_date,CPIAUCSL\n2026-08-01,321.25\n');
  writeFileSync(join(root, 'data', 'inputs', 'vintages', '2026-11-15', 'PCE.csv'), 'observation_date,PCEPI_20261115\n2026-08-01,127.1\n');
  mutate(root, latest);
  writeFileSync(join(root, 'data', 'latest.json'), JSON.stringify(latest));
  return root;
}
const files = (dir) => readdirSync(dir, { recursive: true }).map(String);

test('the published bundle contains only the allowlist: no raw input files, no vintages, no internal state', (t) => {
  const root = fixtureRoot(t);
  const out = join(root, '_site');
  buildSite({ root, out });
  const list = files(out);
  assert.equal(list.some((f) => f.includes('inputs')), false);
  assert.equal(list.some((f) => f.endsWith('.csv')), false);
  assert.equal(list.includes(join('data', 'packets-seen.json')), false);
  for (const f of list.filter((x) => x.startsWith('data') && x !== 'data')) assert.ok(DATA_ALLOWLIST.includes(f.split(/[\\/]/)[1]), f);
  assert.deepEqual(scanSite(out), []);
});

test('the scan fails on a raw file, a CSV payload, an observation history or a long series anywhere in the bundle', (t) => {
  const cases = {
    'planted CSV file': (out) => writeFileSync(join(out, 'data', 'checkpoints', 'x.csv'), 'observation_date,X\n2026-01-01,1\n'),
    'unlisted file': (out) => writeFileSync(join(out, 'data', 'packets-seen.json'), '[]'),
    'CSV text inside JSON': (out) => writeFileSync(join(out, 'data', 'packets.json'), JSON.stringify([{ note: 'observation_date,CPIAUCSL\n2026-08-01,321.25' }])),
    'history in a JSON file': (out) => writeFileSync(join(out, 'data', 'community.json'), JSON.stringify({ agents: [{ history: [['2026-01-01', 1], ['2026-02-01', 2]] }] })),
    'long series in a JSON file': (out) => writeFileSync(join(out, 'data', 'redteam.json'), JSON.stringify({ x: Array.from({ length: 13 }, (_, i) => i) })),
    'series in the ledger': (out) => writeFileSync(join(out, 'data', 'ledger.jsonl'), JSON.stringify({ v: Array.from({ length: 20 }, (_, i) => ({ date: `2026-01-${String(i + 1).padStart(2, '0')}`, value: i })) }) + '\n'),
  };
  for (const [name, inject] of Object.entries(cases)) {
    const root = fixtureRoot(t);
    const out = join(root, '_site');
    buildSite({ root, out });
    inject(out);
    assert.ok(scanSite(out).length > 0, name);
  }
});

// Review (dot, Nov 6 late): the first scan missed several shapes. Each must now fail.
test('the scan catches observations in any shape, in any allowed file (dot\'s examples and more)', (t) => {
  const thirteen = Array.from({ length: 13 }, (_, i) => i);
  const month = (i) => `2025-${String((i % 12) + 1).padStart(2, '0')}-01`;
  const setJson = (out, f, mutate) => { const p = join(out, 'data', f); const o = JSON.parse(readFileSync(p, 'utf8')); mutate(o); writeFileSync(p, JSON.stringify(o)); };
  const cases = {
    '13 observations as numeric strings': (out) => setJson(out, 'redteam.json', (o) => { o.x = thirteen.map((i) => String(1.5 + i)); }),
    'date-keyed observation map': (out) => setJson(out, 'community.json', (o) => { o.m = Object.fromEntries(thirteen.map((i) => [month(i) + (i >= 12 ? 'x' : ''), i])); o.m['2026-01-01'] = 1; }),
    'quarter-keyed map': (out) => setJson(out, 'packets.json', (o) => { o.push({ q: Object.fromEntries(thirteen.map((i) => [`${2000 + i}-Q1`, i])) }); }),
    'CSV inside a JSON string (no FRED header)': (out) => setJson(out, 'packets.json', (o) => { o.push({ note: 'date,value\n2020-01-01,1.1\n2020-02-01,1.2\n2020-03-01,1.3' }); }),
    'semicolon table inside a JSON string': (out) => setJson(out, 'redteam.json', (o) => { o.t = '2020-Q1; 1.1\n2020-Q2; 1.2\n2020-Q3; 1.3'; }),
    'records with a period and a numeric string': (out) => setJson(out, 'community.json', (o) => { o.r = thirteen.map((i) => ({ period: month(i), v: String(i) })); }),
    'numeric history in a text file under checkpoints': (out) => writeFileSync(join(out, 'data', 'checkpoints', 'notes.txt'), thirteen.map((i) => `${month(i)},${i}`).join('\n')),
    'text disguised as a timestamp proof': (out) => writeFileSync(join(out, 'data', 'checkpoints', '000001-2026-11-04.json.ots'), '2020-01-01,1\n2020-02-01,2\n'),
    'extra field in a checkpoint': (out) => { const f = readdirSync(join(out, 'data', 'checkpoints')).find((n) => n.endsWith('.json')); const p = join(out, 'data', 'checkpoints', f); const o = JSON.parse(readFileSync(p, 'utf8')); o.cpi = [1, 2]; writeFileSync(p, JSON.stringify(o)); },
    'extra field in an allowed derived series': (out) => setJson(out, 'latest.json', (o) => { o.head_to_head.price_series[0].cpi_level = 258.8; }),
    'allowed derived series over its limit': (out) => setJson(out, 'latest.json', (o) => { o.head_to_head.costs = Array.from({ length: 41 }, (_, i) => ({ year: 1990 + i, inflation_on_cash_b: i })); }),
    'unexpected ledger field': (out) => { const p = join(out, 'data', 'ledger.jsonl'); writeFileSync(p, readFileSync(p, 'utf8') + JSON.stringify({ seq: 999, cpi: 1 }) + '\n'); },
    'inlined record differs from latest.json': (out) => { const p = join(out, 'index.html'); writeFileSync(p, readFileSync(p, 'utf8').replace('window.SWARM_DATA = {', 'window.SWARM_DATA = {"extra":{"note":"x"},')); },
  };
  for (const [name, inject] of Object.entries(cases)) {
    const root = fixtureRoot(t);
    const out = join(root, '_site');
    buildSite({ root, out });
    assert.deepEqual(scanSite(out), [], `clean before: ${name}`);
    inject(out);
    assert.ok(scanSite(out).length > 0, name);
  }
});

test('the scan reads the record inlined in index.html, not just the JSON files', (t) => {
  const root = fixtureRoot(t, (r, latest) => { latest.sentinels.domestic.readings[0].history = [['2026-01-01', 1.5], ['2026-02-01', 1.6]]; });
  const out = join(root, '_site');
  buildSite({ root, out });
  rmSync(join(out, 'data', 'latest.json'));
  const problems = scanSite(out);
  assert.ok(problems.some((p) => p.startsWith('index.html (inlined record)')), problems.join('; '));
});

test('the build command exits non-zero (so nothing is uploaded) when prohibited data is present', (t) => {
  const root = fixtureRoot(t, (r, latest) => { latest.sentinels.domestic.readings[0].history = Array.from({ length: 30 }, (_, i) => [`2024-${String((i % 12) + 1).padStart(2, '0')}-01`, i]); });
  cpSync(join(ROOT, 'scripts'), join(root, 'scripts'), { recursive: true });
  const r = spawnSync(process.execPath, [join(root, 'scripts', 'build-site.js'), '_site'], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Publication check FAILED/);
});

test('sentinel readings no longer carry a history series', () => {
  const src = readFileSync(join(ROOT, 'src', 'agents', 'sentinels.js'), 'utf8');
  assert.equal(/\bhistory\s*:/.test(src), false);
});
