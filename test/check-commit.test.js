import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { checkCommit, filesToCommit, GATE_FROM } from '../scripts/check-commit.js';

// Jamie (Nov 6): run the publication rules before the daily save, enforced from Nov 16, so a prohibited
// payload can't enter Git history; before then it only warns, so the Nov 15 save can't be blocked.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts', 'check-commit.js');

function repo(t) {
  const r = mkdtempSync(join(tmpdir(), 'gate-'));
  t.after(() => rmSync(r, { recursive: true, force: true }));
  cpSync(join(ROOT, '.gitignore'), join(r, '.gitignore'));
  mkdirSync(join(r, 'data', 'inputs'), { recursive: true });
  const files = execFileSync('git', ['ls-files', 'data'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
  for (const f of files) { mkdirSync(dirname(join(r, f)), { recursive: true }); cpSync(join(ROOT, f), join(r, f)); }
  const latest = JSON.parse(readFileSync(join(r, 'data', 'latest.json'), 'utf8'));
  for (const g of Object.values(latest.sentinels || {})) for (const x of g.readings || []) delete x.history; // pre-Nov 6 commits had these
  writeFileSync(join(r, 'data', 'latest.json'), JSON.stringify(latest));
  execFileSync('git', ['init', '-q'], { cwd: r });
  execFileSync('git', ['add', '-A'], { cwd: r });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base'], { cwd: r });
  return r;
}
const run = (r, today) => spawnSync(process.execPath, [SCRIPT, '--root', r], { env: { ...process.env, SWARM_TODAY: today }, encoding: 'utf8' });

test('the current record passes the pre-save check', (t) => {
  const r = repo(t);
  assert.deepEqual(checkCommit(r), []);
  // Ignored FRED files on disk (as on the runner) are not part of what would be saved.
  writeFileSync(join(r, 'data', 'inputs', 'CPI.csv'), 'observation_date,CPIAUCSL\n2026-08-01,321.25\n');
  assert.equal(filesToCommit(r).includes('data/inputs/CPI.csv'), false);
  assert.deepEqual(checkCommit(r), []);
});

test('prohibited content warns before Nov 16 and stops the save from Nov 16', (t) => {
  const plants = {
    'a FRED file that is not ignored': (r) => { writeFileSync(join(r, '.gitignore'), ''); writeFileSync(join(r, 'data', 'inputs', 'CPI.csv'), 'observation_date,CPIAUCSL\n2026-08-01,321.25\n'); },
    'an observation series in the record': (r) => { const p = join(r, 'data', 'latest.json'); const o = JSON.parse(readFileSync(p, 'utf8')); o.sentinels.domestic.readings[0].history = Array.from({ length: 30 }, (_, i) => [`2024-${String((i % 12) + 1).padStart(2, '0')}-01`, i]); writeFileSync(p, JSON.stringify(o)); },
    'a table inside packet bookkeeping': (r) => writeFileSync(join(r, 'data', 'new-packets.json'), JSON.stringify([{ note: '2020-01-01,1\n2020-02-01,2\n2020-03-01,3' }])),
    'a new unexpected file': (r) => writeFileSync(join(r, 'data', 'series.json'), '{}'),
  };
  for (const [name, plant] of Object.entries(plants)) {
    const r = repo(t);
    plant(r);
    assert.ok(checkCommit(r).length > 0, name);
    const before = run(r, '2026-11-15');
    assert.equal(before.status, 0, `${name}: warns only on Nov 15`);
    assert.match(before.stdout, /::warning::Pre-save check/, name);
    const after = run(r, GATE_FROM);
    assert.equal(after.status, 1, `${name}: blocks from ${GATE_FROM}`);
    assert.match(after.stderr, /Pre-save check FAILED: nothing will be saved/, name);
  }
});

test('the pre-save check rejects a malformed run date', (t) => {
  const r = repo(t);
  assert.equal(run(r, '2026-11-5').status, 2);
});

test('the daily workflow runs the check right before the save step, without continue-on-error', () => {
  const wf = readFileSync(join(ROOT, '.github', 'workflows', 'swarm.yml'), 'utf8');
  const i = wf.indexOf('node scripts/check-commit.js'); const j = wf.indexOf('- name: Seal results into the repository');
  assert.ok(i > 0 && j > i, 'check comes before the save');
  assert.equal(/continue-on-error/.test(wf.slice(wf.lastIndexOf('- name:', i), j)), false);
});
