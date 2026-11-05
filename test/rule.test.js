import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculatorA, calculatorB, consensus } from '../src/agents/calculators.js';
import { runBrake } from '../src/agents/brake.js';
import { computationDate, quarterMonths } from '../src/lib/util.js';
import { lastGdpYearAvailable } from '../src/agents/prepare.js';

const rule = { feedback_strength: 0.5, path_growth_floor_pct: 0, path_growth_ceiling_pct: 4, brake_trigger_log_points: 3, brake_release_log_points: 1, brake_successive_readings: 2 };

// GDP levels growing exactly 2% a year for ten years -> trend 2.0
const gdp2 = Array.from({ length: 11 }, (_, i) => 100 * Math.pow(1.02, i));
// Price indexes exactly x log points above base
const at = (lp) => ({ base: { cpi: [100, 100, 100], pce: [50, 50, 50] }, cur: { cpi: Array(3).fill(100 * Math.exp(lp / 100)), pce: Array(3).fill(50 * Math.exp(lp / 100)) }, gdp_levels: gdp2 });

test('book worked example 1: trend 2%, prices 1% above -> 1.5%', () => {
  for (const calc of [calculatorA, calculatorB]) {
    const r = calc(at(1), rule);
    assert.ok(Math.abs(r.trend_growth_pct - 2) < 1e-9);
    assert.ok(Math.abs(r.allowance_pct - 1.5) < 1e-9);
  }
});

test('book worked example 2: trend 2%, prices 1% below -> 2.5%', () => {
  for (const calc of [calculatorA, calculatorB]) assert.ok(Math.abs(calc(at(-1), rule).allowance_pct - 2.5) < 1e-9);
});

test('book worked example 3: trend 2%, prices 5% above -> -0.5% clamped to the 0% floor', () => {
  for (const calc of [calculatorA, calculatorB]) {
    const r = calc(at(5), rule);
    assert.ok(Math.abs(r.allowance_raw_pct + 0.5) < 1e-9);
    assert.equal(r.allowance_pct, 0);
    assert.equal(r.quarterly_step_pct, 0);
  }
});

test('ceiling: deep price fall cannot push path growth above 4%', () => {
  assert.equal(calculatorA(at(-10), rule).allowance_pct, 4);
});

test('quarterly step compounds to the annual rate', () => {
  const r = calculatorA(at(0), rule);
  assert.ok(Math.abs(Math.pow(1 + r.quarterly_step_pct / 100, 4) - 1.02) < 1e-12);
});

test('consensus flags a disagreeing calculator', () => {
  const a = calculatorA(at(1), rule);
  const bad = { ...a, allowance_pct: a.allowance_pct + 0.001 };
  assert.equal(consensus({ A: a, B: calculatorB(at(1), rule) }).agreed, true);
  assert.equal(consensus({ A: a, B: bad }).agreed, false);
});

test('consensus without the Python calculator is agreed but not full quorum', () => {
  const c = consensus({ A: calculatorA(at(1), rule), B: calculatorB(at(1), rule), C: { error: 'python missing' } });
  assert.equal(c.agreed, true);
  assert.equal(c.full_quorum, false);
});

test('brake: one reading above 3 arms; two successive engage', () => {
  const b = runBrake([{ quarter: 'a', gap_lp: 3.2 }, { quarter: 'b', gap_lp: 3.1 }], rule);
  assert.deepEqual(b.states.map((s) => s.phase), ['armed', 'engaged']);
});

test('brake: a missing reading is disclosed, not treated as low, and does not reset the count', () => {
  const b = runBrake([{ quarter: 'a', gap_lp: 3.5 }, { quarter: 'b', gap_lp: null }, { quarter: 'c', gap_lp: 3.5 }], rule);
  assert.deepEqual(b.states.map((s) => s.phase), ['armed', 'armed', 'engaged']);
});

test('brake: holds between 1 and 3, releases at or below 1', () => {
  const b = runBrake([3.5, 3.5, 2.0, 0.9].map((g, i) => ({ quarter: String(i), gap_lp: g })), rule);
  assert.deepEqual(b.states.map((s) => s.phase), ['armed', 'engaged', 'engaged', 'released']);
});

test('brake: a reading at or below 3 between two high readings resets the count', () => {
  const b = runBrake([3.5, 2.9, 3.5].map((g, i) => ({ quarter: String(i), gap_lp: g })), rule);
  assert.deepEqual(b.states.map((s) => s.phase), ['armed', 'off', 'armed']);
});

test('computation dates: 15th of the second month after quarter end', () => {
  assert.equal(computationDate({ y: 2026, q: 3 }), '2026-11-15');
  assert.equal(computationDate({ y: 2026, q: 4 }), '2027-02-15');
  assert.deepEqual(quarterMonths({ y: 2026, q: 2 }), ['2026-04-01', '2026-05-01', '2026-06-01']);
});

test('annual GDP for year Y is only used from May of Y+1', () => {
  assert.equal(lastGdpYearAvailable('2026-02-15'), 2024);
  assert.equal(lastGdpYearAvailable('2026-05-15'), 2025);
});
