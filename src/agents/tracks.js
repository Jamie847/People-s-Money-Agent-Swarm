// TRACKS
// Live track: the real shadow run. Starts at the epoch quarter and adds one reading per quarter on its
// fixed computation date. Once a reading is computed it is FROZEN — later data revisions never change it
// (the book: "later revisions never change money already issued").
// Replay tracks: what the rule would have SIGNALED from a past start date, given prices as they actually
// turned out. Replays use today's revised data and ignore that the rule would itself have changed prices.
// They are a way to see the rule's behavior, not a simulation of outcomes.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseQuarter, quarterLabel, nextQuarter, computationDate, quarterMonths, sha256, stableStringify, round } from '../lib/util.js';
import { prepareQuarter } from './prepare.js';
import { fetchVintage } from './vintages.js';
import { calculatorA, calculatorB, consensus } from './calculators.js';
import { runBrake } from './brake.js';

export function calculatorC(root, epoch, quarter, inputsDir = null, baseFile = null) {
  try {
    const extra = [...(inputsDir ? ['--inputs-dir', inputsDir] : []), ...(baseFile ? ['--base-file', baseFile] : [])];
    const out = execFileSync('python3', [join(root, 'scripts', 'recompute.py'), '--epoch', epoch, '--quarter', quarter, '--json', ...extra], { encoding: 'utf8' });
    const r = JSON.parse(out);
    if (r.error) return { error: r.error };
    return r;
  } catch (err) {
    return { error: `calculator C unavailable: ${String(err.message || err).split('\n')[0].slice(0, 160)}` };
  }
}

const seriesOf = (sensorById) => ({ cpi: sensorById.CPI.observations, pce: sensorById.PCE.observations, gdp: sensorById.GDP.observations });

export async function runLiveTrack({ root, sensorById, rule, today, history, offline = false }) {
  const epochQ = parseQuarter(rule.live_epoch_quarter);
  const frozen = new Map(history.map((h) => [h.quarter, h]));
  const firstRun = history.length ? history[0].computed_at : today;
  const updated = [...history];
  let q = epochQ;
  const day = rule.computation_day_of_second_month_after_quarter;
  while (computationDate(q, day) <= today) {
    const label = quarterLabel(q);
    if (!frozen.has(label)) {
      // Use the data AS PUBLISHED ON the computation date (ALFRED vintage), so later revisions never change
      // the reading. Falls back to the current files, disclosed, if the vintage cannot be read.
      const cd = computationDate(q, day);
      const vint = label === rule.live_epoch_quarter ? null : await fetchVintage(root, cd, { offline });
      const series = vint?.ok ? vint.series : seriesOf(sensorById);
      const epochEntry = updated.find((h) => h.quarter === rule.live_epoch_quarter && h.inputs);
      const frozenBase = epochEntry ? epochEntry.inputs.base : null;
      const prep = prepareQuarter(series, epochQ, q, rule, frozenBase);
      const entry = {
        quarter: label,
        epoch: prep.epoch,
        computation_date: prep.computation_date,
        computed_at: today,
        launch_backfill: prep.computation_date < firstRun,
        complete: prep.complete,
        missing: prep.missing,
        gdp_note: prep.gdp_note,
        input_sha256: vint?.ok ? vint.sha256 : { CPI: sensorById.CPI.sha256, PCE: sensorById.PCE.sha256, GDP: sensorById.GDP.sha256 },
        data_vintage: vint?.ok ? { as_published_on: cd, dir: vint.dir } : { as_published_on: null, note: vint ? `vintage unavailable (${vint.error}); current revised data used` : 'starting quarter: data as published at launch' },
        base_source: frozenBase ? 'frozen starting quarter' : 'read from data',
      };
      if (prep.complete) {
        const baseFile = frozenBase ? join(root, 'data', 'live-history.json') : null;
        const results = { A: calculatorA(prep, rule), B: calculatorB(prep, rule), C: calculatorC(root, prep.epoch, label, vint?.ok ? join(root, vint.dir) : null, baseFile) };
        const cons = consensus(results);
        entry.inputs = { base_months: prep.base_months, current_months: prep.current_months, base: prep.base, cur: prep.cur, gdp_years: prep.gdp_years, gdp_levels: prep.gdp_levels };
        entry.calculators = Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v.error ? { error: v.error } : pickOutputs(v)]));
        entry.consensus = cons;
        entry.available = cons.agreed;
        entry.outputs = cons.agreed ? pickOutputs(results.A) : null;
      } else {
        entry.available = false;
        entry.outputs = null;
      }
      entry.frozen_sha256 = sha256(stableStringify(entry));
      updated.push(entry);
    }
    q = nextQuarter(q);
  }

  const readings = updated.map((h) => ({ quarter: h.quarter, gap_lp: h.available ? h.outputs.gap_lp : null }));
  const brake = runBrake(readings, rule);
  let path = 100;
  const pathIndex = updated.map((h) => {
    if (h.available) path *= 1 + h.outputs.quarterly_step_pct / 100;
    return { quarter: h.quarter, path_index: round(path, 4) };
  });

  // What is next?
  const nextQ = q;
  const nextMonths = quarterMonths(nextQ);
  const cpiDates = new Set(sensorById.CPI.observations.map((o) => o.date));
  const pceDates = new Set(sensorById.PCE.observations.map((o) => o.date));
  const next = {
    quarter: quarterLabel(nextQ),
    computation_date: computationDate(nextQ, day),
    months_needed: nextMonths,
    months_published: { CPI: nextMonths.filter((m) => cpiDates.has(m)), PCE: nextMonths.filter((m) => pceDates.has(m)) },
  };
  return { history: updated, brake, path_index: pathIndex, next };
}

export const pickOutputs = (r) => ({
  trend_growth_pct: r.trend_growth_pct,
  gap_cpi_lp: r.gap_cpi_lp,
  gap_pce_lp: r.gap_pce_lp,
  gap_lp: r.gap_lp,
  allowance_raw_pct: r.allowance_raw_pct,
  allowance_pct: r.allowance_pct,
  quarterly_step_pct: r.quarterly_step_pct,
});

export function runReplay({ sensorById, rule, epochLabel }) {
  const epochQ = parseQuarter(epochLabel);
  const series = seriesOf(sensorById);
  const rows = [];
  let q = epochQ;
  let path = 100;
  let maxDiff = 0;
  for (;;) {
    const prep = prepareQuarter(series, epochQ, q, rule);
    if (!prep.complete) break;
    const a = calculatorA(prep, rule);
    const b = calculatorB(prep, rule);
    maxDiff = Math.max(maxDiff, Math.abs(a.gap_lp - b.gap_lp), Math.abs(a.allowance_pct - b.allowance_pct));
    path *= 1 + a.quarterly_step_pct / 100;
    rows.push({
      quarter: quarterLabel(q),
      trend_growth_pct: round(a.trend_growth_pct, 3),
      gap_lp: round(a.gap_lp, 3),
      allowance_pct: round(a.allowance_pct, 3),
      allowance_raw_pct: round(a.allowance_raw_pct, 3),
      path_index: round(path, 3),
    });
    q = nextQuarter(q);
  }
  const brake = runBrake(rows.map((r) => ({ quarter: r.quarter, gap_lp: r.gap_lp })), rule);
  rows.forEach((r, i) => { r.brake = brake.states[i].phase; });
  const engagedQuarters = rows.filter((r) => r.brake === 'engaged').map((r) => r.quarter);
  const maxGap = rows.reduce((m, r) => Math.max(m, r.gap_lp), -Infinity);
  return {
    epoch: epochLabel,
    label: `Signal replay from ${epochLabel}`,
    caveat: 'Uses today\'s revised data and actual prices. The rule did not run, so prices were not affected by it. This shows what the rule would have signaled, not what would have happened.',
    calculators_A_B_max_difference: maxDiff,
    rows,
    summary: {
      quarters: rows.length,
      max_gap_lp: round(maxGap, 3),
      first_brake_engaged: engagedQuarters[0] ?? null,
      quarters_brake_engaged: engagedQuarters.length,
      quarters_at_floor: rows.filter((r) => r.allowance_pct === 0).length,
    },
  };
}
