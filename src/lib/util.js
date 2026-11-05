import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

export const sha256 = (text) => createHash('sha256').update(text).digest('hex');

export const readJSON = (path, fallback) => {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, 'utf8'));
};

export const writeJSON = (path, obj) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(obj, null, 2) + '\n');
};

export const writeText = (path, text) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

// Stable JSON (sorted keys) so a fingerprint does not depend on key order.
export const stableStringify = (value) => {
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
  }
  return JSON.stringify(value);
};

// ---------- dates and quarters ----------

export const parseQuarter = (label) => {
  const m = /^(\d{4})-Q([1-4])$/.exec(label);
  if (!m) throw new Error(`Bad quarter label: ${label}`);
  return { y: Number(m[1]), q: Number(m[2]) };
};

export const quarterLabel = ({ y, q }) => `${y}-Q${q}`;

export const nextQuarter = ({ y, q }) => (q === 4 ? { y: y + 1, q: 1 } : { y, q: q + 1 });

export const prevQuarter = ({ y, q }) => (q === 1 ? { y: y - 1, q: 4 } : { y, q: q - 1 });

const pad = (n) => String(n).padStart(2, '0');

export const quarterMonths = ({ y, q }) => [0, 1, 2].map((i) => `${y}-${pad(3 * (q - 1) + 1 + i)}-01`);

export const quarterOfDate = (iso) => {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  return { y, q: Math.floor((m - 1) / 3) + 1 };
};

// Fixed computation date: the given day of the second month after the quarter ends.
export const computationDate = ({ y, q }, day = 15) => {
  let m = 3 * q + 2;
  let yy = y;
  if (m > 12) { m -= 12; yy += 1; }
  return `${yy}-${pad(m)}-${pad(day)}`;
};

export const quartersFrom = (start, endInclusive) => {
  const out = [];
  let cur = { ...start };
  const key = (x) => x.y * 4 + x.q;
  while (key(cur) <= key(endInclusive)) { out.push(cur); cur = nextQuarter(cur); }
  return out;
};

export const addDays = (iso, days) => {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

export const daysBetween = (a, b) => Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);

export const round = (x, digits = 3) => (x === null || x === undefined || Number.isNaN(x) ? null : Number(x.toFixed(digits)));

// ---------- series helpers ----------

export const toMap = (obs) => new Map(obs.map((o) => [o.date, o.value]));

export const lastObs = (obs) => (obs.length ? obs[obs.length - 1] : null);

// Value on or before a date (for daily/weekly series).
export const valueOnOrBefore = (obs, iso) => {
  let found = null;
  for (const o of obs) { if (o.date <= iso) found = o; else break; }
  return found;
};

export const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
