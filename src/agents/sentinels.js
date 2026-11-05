// SENTINEL AGENTS
// Job: watch around the clock and say calm / watch / stress. Sentinels never act.
// Thresholds live in config/sentinels.json and are provisional (not from the book).

import { round, quarterMonths, mean } from '../lib/util.js';

const pctChangeBack = (obs, back) => {
  if (obs.length <= back) return null;
  const a = obs[obs.length - 1 - back].value; const b = obs[obs.length - 1].value;
  return 100 * (b / a - 1);
};

export function metricValue(metric, obs, ctx = {}) {
  if (!obs.length) return null;
  const last = obs[obs.length - 1].value;
  switch (metric) {
    case 'level': return last;
    case 'level_billions': return last / 1000;
    case 'pct_change_13w': return pctChangeBack(obs, 13);
    case 'pct_change_21d': return pctChangeBack(obs, 21);
    case 'pct_change_4q': return pctChangeBack(obs, 4);
    case 'pct_change_52w': return pctChangeBack(obs, 52);
    case 'change_vs_epoch_pp': {
      const months = quarterMonths(ctx.epochQ).map((m) => m.slice(0, 7));
      const inEpoch = obs.filter((o) => months.includes(o.date.slice(0, 7))).map((o) => o.value);
      return inEpoch.length ? last - mean(inEpoch) : null;
    }
    default: throw new Error(`Unknown metric ${metric}`);
  }
}

export function classify(value, cfg) {
  if (cfg.watch === null || cfg.stress === null || value === null) return 'context';
  if (cfg.direction === 'down') return value <= cfg.stress ? 'stress' : value <= cfg.watch ? 'watch' : 'calm';
  return value >= cfg.stress ? 'stress' : value >= cfg.watch ? 'watch' : 'calm';
}

const METRIC_LABEL = {
  level: 'latest level',
  level_billions: 'outstanding, $ billions',
  pct_change_13w: '13-week change, %',
  pct_change_21d: 'about one-month change, %',
  pct_change_4q: '4-quarter change, %',
  pct_change_52w: '52-week change, %',
  change_vs_epoch_pp: 'change since shadow-run start, points',
};

// Keep chart history small: every k-th point plus the last one.
const thin = (obs, maxPoints = 260) => {
  if (obs.length <= maxPoints) return obs.map((o) => [o.date, o.value]);
  const k = Math.ceil(obs.length / maxPoints);
  const out = obs.filter((_, i) => i % k === 0).map((o) => [o.date, o.value]);
  const last = obs[obs.length - 1];
  if (out[out.length - 1][0] !== last.date) out.push([last.date, last.value]);
  return out;
};

export function runSentinels(sensorById, cfgGroup, ctx) {
  const readings = [];
  for (const [id, cfg] of Object.entries(cfgGroup)) {
    const s = sensorById[id];
    if (!s || !s.ok) { readings.push({ id, status: 'unavailable', detail: s?.error ?? 'no data' }); continue; }
    const value = metricValue(cfg.metric, s.observations, ctx);
    const status = classify(value, cfg);
    readings.push({
      id,
      title: s.title,
      agency: s.agency,
      as_of: s.last.date,
      latest: s.last.value,
      units: s.units,
      metric: cfg.metric,
      metric_label: METRIC_LABEL[cfg.metric],
      value: round(value, 3),
      watch: cfg.watch,
      stress: cfg.stress,
      direction: cfg.direction ?? 'up',
      status,
      note: cfg.note,
      history: thin(s.observations),
    });
  }
  const rank = { stress: 3, watch: 2, calm: 1, context: 0, unavailable: 0 };
  const overall = readings.reduce((w, r) => (rank[r.status] > rank[w] ? r.status : w), 'calm');
  return { overall, readings };
}
