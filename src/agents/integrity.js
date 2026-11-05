// INTEGRITY AGENTS
// Job: decide whether the numbers are fit to use — present, fresh, and consistent with each other.
// They never repair data. They disclose problems and raise packets for humans.

import { daysBetween, round, toMap } from '../lib/util.js';

const STALE_AFTER_DAYS = { daily: 10, weekly: 21, monthly: 75, quarterly: 200, annual: 500 };

export function checkSources(sensorResults, today) {
  return sensorResults.map((s) => {
    if (!s.ok) return { id: s.id, check: 'fetched', status: 'fail', detail: `Could not read ${s.series}: ${s.error}` };
    if (s.historical) return { id: s.id, check: 'fresh', status: 'ok', detail: `Historical series (discontinued); ${s.observations.length} observations; sha256 ${s.sha256.slice(0, 12)}…` };
    const age = daysBetween(s.last.date, today);
    const limit = STALE_AFTER_DAYS[s.freq] ?? 60;
    // Observation dates mark the START of the period, so allow one period of lag on top.
    if (age > limit + ({ monthly: 31, quarterly: 92, annual: 366 }[s.freq] ?? 0)) {
      return { id: s.id, check: 'fresh', status: 'warn', last: s.last.date, detail: `Latest ${s.series} observation is ${s.last.date} (${age} days old)` };
    }
    return { id: s.id, check: 'fresh', status: 'ok', detail: `Latest ${s.last.date}; ${s.observations.length} observations; sha256 ${s.sha256.slice(0, 12)}…` };
  });
}

// The book: if the 12-month changes of the two price indexes differ by more than 1.5 points,
// the average still governs, the gap is published, and an inspector general reviews both series.
export function checkIndexDisagreement(cpiObs, pceObs, thresholdPp) {
  const cpi = toMap(cpiObs); const pce = toMap(pceObs);
  const common = cpiObs.map((o) => o.date).filter((d) => pce.has(d));
  if (!common.length) return { check: 'index-agreement', status: 'fail', detail: 'No common months for CPI-U and PCE' };
  const last = common[common.length - 1];
  const y = Number(last.slice(0, 4)) - 1;
  const yearAgo = `${y}${last.slice(4)}`;
  if (!cpi.has(yearAgo) || !pce.has(yearAgo)) return { check: 'index-agreement', status: 'warn', detail: 'Not enough history for a 12-month comparison' };
  const c = 100 * (cpi.get(last) / cpi.get(yearAgo) - 1);
  const p = 100 * (pce.get(last) / pce.get(yearAgo) - 1);
  const diff = Math.abs(c - p);
  return {
    check: 'index-agreement',
    status: diff > thresholdPp ? 'warn' : 'ok',
    month: last,
    cpi_12m_pct: round(c, 2),
    pce_12m_pct: round(p, 2),
    difference_pp: round(diff, 2),
    detail: `12-month change to ${last}: CPI-U ${c.toFixed(2)}%, PCE ${p.toFixed(2)}% (difference ${diff.toFixed(2)} points; review threshold ${thresholdPp})`,
  };
}

export const worst = (statuses) => {
  const rank = { fail: 3, warn: 2, ok: 1, info: 0 };
  return statuses.reduce((w, s) => (rank[s] > rank[w] ? s : w), 'info');
};
