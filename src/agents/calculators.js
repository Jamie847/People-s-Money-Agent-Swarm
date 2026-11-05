// CALCULATOR AGENTS
// Job: apply the published rule (Ch. 7) to prepared inputs. No judgment, no forecasts.
// Two JavaScript calculators use different arithmetic routes; a third (Python, scripts/recompute.py)
// re-reads the raw files and prepares its own inputs. All three must agree before anything is published.
//
// The rule, in plain words:
//   trend  = average of the last ten annual percent changes in real GDP
//   gap    = how far prices sit above (+) or below (-) the flat target, in log points
//            (average of the CPI-U gap and the PCE gap, each measured from its own epoch level,
//             using three-month averages)
//   path growth = clamp(trend - 0.5 x gap, 0%, 4%) per year
//   quarterly step = (1 + path growth)^(1/4) - 1

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

// Calculator A: direct, textbook arithmetic.
export function calculatorA(inp, rule) {
  const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const gapCpi = 100 * Math.log(avg(inp.cur.cpi) / avg(inp.base.cpi));
  const gapPce = 100 * Math.log(avg(inp.cur.pce) / avg(inp.base.pce));
  const gap = (gapCpi + gapPce) / 2;
  const growth = [];
  for (let i = 1; i < inp.gdp_levels.length; i++) growth.push(100 * (inp.gdp_levels[i] / inp.gdp_levels[i - 1] - 1));
  const trend = avg(growth);
  const raw = trend - rule.feedback_strength * gap;
  const allowance = clamp(raw, rule.path_growth_floor_pct, rule.path_growth_ceiling_pct);
  const step = 100 * (Math.pow(1 + allowance / 100, 0.25) - 1);
  return { trend_growth_pct: trend, gap_cpi_lp: gapCpi, gap_pce_lp: gapPce, gap_lp: gap, allowance_raw_pct: raw, allowance_pct: allowance, quarterly_step_pct: step };
}

// Kahan (compensated) summation, used by calculator B.
const ksum = (xs) => {
  let s = 0; let c = 0;
  for (const x of xs) { const y = x - c; const t = s + y; c = (t - s) - y; s = t; }
  return s;
};

// Calculator B: different route — logs of sums, reverse-order compensated sums, log1p/expm1.
export function calculatorB(inp, rule) {
  const lnRatioOfSums = (cur, base) => Math.log(ksum(cur)) - Math.log(ksum(base)); // equal counts, so = ln(mean/mean)
  const gapCpi = 100 * lnRatioOfSums([...inp.cur.cpi].reverse(), [...inp.base.cpi].reverse());
  const gapPce = 100 * lnRatioOfSums([...inp.cur.pce].reverse(), [...inp.base.pce].reverse());
  const gap = 0.5 * gapCpi + 0.5 * gapPce;
  const lv = inp.gdp_levels;
  const growth = [];
  for (let i = lv.length - 1; i >= 1; i--) growth.push(100 * ((lv[i] - lv[i - 1]) / lv[i - 1]));
  const trend = ksum(growth) / growth.length;
  const raw = trend - gap * rule.feedback_strength;
  let allowance = raw;
  if (allowance < rule.path_growth_floor_pct) allowance = rule.path_growth_floor_pct;
  if (allowance > rule.path_growth_ceiling_pct) allowance = rule.path_growth_ceiling_pct;
  const step = 100 * Math.expm1(Math.log1p(allowance / 100) / 4);
  return { trend_growth_pct: trend, gap_cpi_lp: gapCpi, gap_pce_lp: gapPce, gap_lp: gap, allowance_raw_pct: raw, allowance_pct: allowance, quarterly_step_pct: step };
}

export const OUTPUT_KEYS = ['trend_growth_pct', 'gap_cpi_lp', 'gap_pce_lp', 'gap_lp', 'allowance_raw_pct', 'allowance_pct', 'quarterly_step_pct'];

// CONSENSUS: every output must match across all available calculators within the tolerance.
export function consensus(results, tolerance = 1e-9) {
  const names = Object.keys(results).filter((k) => results[k] && !results[k].error);
  const disagreements = [];
  const ref = results[names[0]];
  for (const key of OUTPUT_KEYS) {
    for (const n of names.slice(1)) {
      const d = Math.abs(results[n][key] - ref[key]);
      if (!(d <= tolerance)) disagreements.push({ key, between: `${names[0]} vs ${n}`, difference: d });
    }
  }
  const missing = Object.keys(results).filter((k) => !results[k] || results[k].error);
  return {
    agreed: disagreements.length === 0 && names.length >= 2,
    calculators_agreeing: disagreements.length === 0 ? names : [],
    calculators_unavailable: missing.map((k) => ({ name: k, error: results[k]?.error ?? 'not run' })),
    full_quorum: missing.length === 0 && disagreements.length === 0,
    disagreements,
    tolerance,
  };
}
