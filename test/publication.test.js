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
