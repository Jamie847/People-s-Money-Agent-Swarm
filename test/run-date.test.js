import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runSensors } from '../src/agents/sensors.js';

// Review round 7 (dot): a malformed manually supplied run date could bypass date-based safeguards.
const bad = ['2026-11-5', '2026-02-30', '20261120', 'tomorrow', ' 2026-11-20', '2026-11-20T00:00'];

test('runSensors refuses a malformed run date before fetching or saving anything', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'date-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'CPI.csv'), 'observation_date,CPIAUCSL\n2026-08-01,321.25\n');
  for (const today of bad) {
    let fetched = 0;
    await assert.rejects(runSensors([{ id: 'CPI', series: 'CPIAUCSL', start: '1998-01-01', transport: 'fred' }],
      { inputsDir: dir, fredKey: '', today, downloadFn: async () => { fetched++; return 'x'; } }), /invalid run date/, today);
    assert.equal(fetched, 0, today);
  }
  assert.equal(readFileSync(join(dir, 'CPI.csv'), 'utf8'), 'observation_date,CPIAUCSL\n2026-08-01,321.25\n');
});

test('run.js exits before doing anything when SWARM_TODAY is malformed', () => {
  for (const d of ['2026-11-5', '2026-02-30', 'tomorrow']) {
    const r = spawnSync(process.execPath, ['scripts/run.js', '--offline'], { env: { ...process.env, SWARM_TODAY: d, FRED_API_KEY: '', ANTHROPIC_API_KEY: '' }, encoding: 'utf8', timeout: 20000 });
    assert.equal(r.status, 2, d);
    assert.match(r.stderr, /Invalid run date/, d);
  }
});
