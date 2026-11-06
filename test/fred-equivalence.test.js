import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fredValuesEquivalent, fredApiGate, fredEquivalenceEvidence, EQUIVALENCE_METHOD } from '../src/lib/fred-api-policy.js';

const H = (t) => (t + '0'.repeat(64)).slice(0, 64).replace(/[^a-f0-9]/g, 'a');
const csv = (series, rows) => `observation_date,${series}\n${rows.join('\n')}\n`;

test('the same numbers in a different layout are equivalent (real cases from the Nov 6 run)', () => {
  assert.deepEqual(fredValuesEquivalent(csv('CPIAUCSL', ['1998-01-01,162.0', '1998-02-01,162.1']), csv('CPIAUCSL', ['1998-01-01,162.000', '1998-02-01,162.100'])), { equivalent: true, observations: 2 });
  assert.equal(fredValuesEquivalent(csv('SWPT', ['2018-06-27,90.0']), csv('SWPT', ['2018-06-27,90'])).equivalent, true);
  assert.equal(fredValuesEquivalent(csv('MED', ['2007-01-01,2.96441026316892']), csv('MED', ['2007-01-01,2.964410263168920'])).equivalent, true);
  assert.equal(fredValuesEquivalent(csv('X', ['2007-01-03,0.0']), csv('X', ['2007-01-03,0'])).equivalent, true);
  assert.equal(fredValuesEquivalent(csv('X', ['2007-01-12,-0.984']), csv('X', ['2007-01-12,-0.9840'])).equivalent, true);
});

test('rows with no value (holidays, the missing Oct 2025 CPI) are ignored on both sides', () => {
  const api = csv('DGS10', ['2019-01-01,', '2019-01-02,2.66', '2019-01-03,2.56']);
  const c = csv('DGS10', ['2019-01-02,2.66', '2019-01-03,2.56']);
  assert.deepEqual(fredValuesEquivalent(api, c), { equivalent: true, observations: 2 });
  assert.equal(fredValuesEquivalent(csv('CPI', ['2025-09-01,324.245', '2025-10-01,', '2025-11-01,325.063']), csv('CPI', ['2025-09-01,324.245', '2025-10-01,', '2025-11-01,325.063'])).equivalent, true);
});

test('any different number, extra valued date or missing valued date fails closed', () => {
  assert.equal(fredValuesEquivalent(csv('X', ['2020-01-01,1.01']), csv('X', ['2020-01-01,1.010000001'])).equivalent, false);
  assert.equal(fredValuesEquivalent(csv('X', ['2020-01-01,1', '2020-02-01,2']), csv('X', ['2020-01-01,1'])).equivalent, false);
  assert.equal(fredValuesEquivalent(csv('X', ['2020-01-01,1']), csv('X', ['2020-01-01,1', '2020-02-01,2'])).equivalent, false);
  assert.equal(fredValuesEquivalent(csv('X', ['2020-01-01,1']), csv('X', ['2020-01-02,1'])).equivalent, false);
  assert.equal(fredValuesEquivalent(csv('X', ['2020-01-01,-0']), csv('X', ['2020-01-01,0'])).equivalent, true);
  assert.equal(fredValuesEquivalent(csv('X', ['2020-01-01,1e3']), csv('X', ['2020-01-01,1000'])).equivalent, false); // not a plain decimal: refuse
  assert.equal(fredValuesEquivalent('garbage', csv('X', ['2020-01-01,1'])).equivalent, false);
  assert.equal(fredValuesEquivalent(csv('X', ['2020-01-01,']), csv('X', ['2020-01-01,'])).equivalent, false); // nothing to compare
});

test('the gate accepts prior-day equivalence evidence only for the same series and start, after the floor date', () => {
  const src = { series: 'CPIAUCSL', start: '1998-01-01' };
  const ev = fredEquivalenceEvidence(src, '2026-11-15', H('a1'), H('b2'), 346);
  assert.equal(ev.method, EQUIVALENCE_METHOD);
  assert.equal(fredApiGate(src, { today: '2026-11-16', useFrom: '2026-11-16', evidence: ev }), null);
  assert.equal(fredApiGate(src, { today: '2026-11-15', useFrom: '2026-11-16', evidence: ev }), 'November 15 reading protected');
  assert.match(fredApiGate(src, { today: '2026-11-16', useFrom: '2026-11-16', evidence: { ...ev, checked_on: '2026-11-16' } }), /no valid prior-day/);
  assert.match(fredApiGate({ ...src, start: '2000-01-01' }, { today: '2026-11-16', useFrom: '2026-11-16', evidence: ev }), /no valid prior-day/);
  assert.match(fredApiGate(src, { today: '2026-11-16', useFrom: '2026-11-16', evidence: { ...ev, method: 'other' } }), /no valid prior-day/);
  assert.match(fredApiGate(src, { today: '2026-11-16', useFrom: '2026-11-16', evidence: { ...ev, observations: 0 } }), /no valid prior-day/);
  assert.match(fredApiGate(src, { today: '2026-11-16', useFrom: '2026-11-16', evidence: { ...ev, status: 'different' } }), /no valid prior-day/);
});
