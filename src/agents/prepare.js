// INPUT PREPARATION (shared by calculators A and B; calculator C prepares its own inputs in Python)
// Picks exactly the numbers the rule is allowed to see on a given computation date.

import { quarterMonths, computationDate, toMap, quarterLabel } from '../lib/util.js';

export function lastGdpYearAvailable(compDateIso, availableFrom = '05-01') {
  const y = Number(compDateIso.slice(0, 4));
  return compDateIso.slice(5) >= availableFrom ? y - 1 : y - 2;
}

export function prepareQuarter({ cpi, pce, gdp }, epochQ, q, rule) {
  const cpiM = toMap(cpi);
  const pceM = toMap(pce);
  const gdpM = new Map(gdp.map((o) => [Number(o.date.slice(0, 4)), o.value]));
  const compDate = computationDate(q, rule.computation_day_of_second_month_after_quarter);
  const missing = [];

  const pick = (map, months, name) => months.map((m) => {
    const v = map.get(m);
    if (v === undefined) missing.push(`${name} ${m}`);
    return v ?? null;
  });

  const baseMonths = quarterMonths(epochQ);
  const curMonths = quarterMonths(q);
  const base = { cpi: pick(cpiM, baseMonths, 'CPI'), pce: pick(pceM, baseMonths, 'PCE') };
  const cur = { cpi: pick(cpiM, curMonths, 'CPI'), pce: pick(pceM, curMonths, 'PCE') };

  let lastYear = lastGdpYearAvailable(compDate, rule.annual_gdp_available_from_month_day);
  // If the agency has not yet published that year, use the latest year actually present (disclosed).
  let gdpNote = null;
  if (!gdpM.has(lastYear)) {
    const present = [...gdpM.keys()].filter((y) => y <= lastYear);
    const fallback = present.length ? Math.max(...present) : null;
    gdpNote = `real GDP for ${lastYear} not yet in the data; latest available year ${fallback} used`;
    lastYear = fallback;
  }
  const years = [];
  const gdpLevels = [];
  const n = rule.trend_growth_years;
  if (lastYear !== null) {
    for (let y = lastYear - n; y <= lastYear; y++) {
      years.push(y);
      const v = gdpM.get(y);
      if (v === undefined) missing.push(`GDP ${y}`);
      gdpLevels.push(v ?? null);
    }
  } else {
    missing.push('GDP (no years available)');
  }

  return {
    quarter: quarterLabel(q),
    epoch: quarterLabel(epochQ),
    computation_date: compDate,
    base_months: baseMonths,
    current_months: curMonths,
    base,
    cur,
    gdp_years: years,
    gdp_levels: gdpLevels,
    gdp_note: gdpNote,
    complete: missing.length === 0,
    missing,
  };
}
