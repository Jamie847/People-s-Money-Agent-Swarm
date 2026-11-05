// SENSOR AGENTS
// Job: fetch each public series, fingerprint exactly what was received, and parse it.
// Rule: sensors never edit, fill, smooth or invent a number. A missing value stays missing.

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { sha256, writeText } from '../lib/util.js';

export const sourceUrl = (src) => {
  if (src.transport === 'fred') {
    return `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${src.series}&cosd=${src.start}`;
  }
  if (src.transport === 'bis') {
    return `https://stats.bis.org/api/v1/data/${src.series}?startPeriod=${src.start}&format=csv`;
  }
  throw new Error(`Unknown transport ${src.transport}`);
};

export const parseFredCsv = (text) => {
  const lines = text.trim().split(/\r?\n/);
  if (!/^observation_date|^DATE/i.test(lines[0])) throw new Error('Not a FRED CSV (unexpected header)');
  const obs = [];
  for (const line of lines.slice(1)) {
    const [date, raw] = line.split(',');
    if (!date || raw === undefined) continue;
    const v = raw.trim();
    if (v === '' || v === '.') continue; // FRED marks missing values with "."; they stay missing.
    const value = Number(v);
    if (Number.isFinite(value)) obs.push({ date: date.trim(), value });
  }
  return obs;
};

const splitCsvLine = (line) => {
  const out = []; let cur = ''; let q = false;
  for (const ch of line) {
    if (ch === '"') q = !q;
    else if (ch === ',' && !q) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
};

export const parseBisCsv = (text) => {
  const lines = text.trim().split(/\r?\n/);
  const header = splitCsvLine(lines[0]);
  const iT = header.indexOf('TIME_PERIOD');
  const iV = header.indexOf('OBS_VALUE');
  if (iT < 0 || iV < 0) throw new Error('Not a BIS CSV (missing TIME_PERIOD/OBS_VALUE)');
  const obs = [];
  for (const line of lines.slice(1)) {
    const cells = splitCsvLine(line);
    const m = /^(\d{4})-Q([1-4])$/.exec(cells[iT]);
    const value = Number(cells[iV]);
    if (!m || cells[iV] === '' || !Number.isFinite(value)) continue;
    const month = String(3 * (Number(m[2]) - 1) + 1).padStart(2, '0');
    obs.push({ date: `${m[1]}-${month}-01`, value });
  }
  return obs.sort((a, b) => (a.date < b.date ? -1 : 1));
};

// curl first (present on GitHub runners and respects proxy settings); Node fetch as fallback.
// Note: FRED rejects unfamiliar User-Agent strings, so curl's default is kept.
const download = async (url) => {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return execFileSync('curl', ['-sS', '-f', '-L', '-m', '90', url], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) { lastErr = err; }
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) { lastErr = err; }
    await new Promise((r) => setTimeout(r, 2000 * attempt));
  }
  throw new Error(`download failed after 3 attempts: ${String(lastErr?.message || lastErr).split('\n')[0]}`);
};

export async function runSensors(sources, { inputsDir, offline = false }) {
  const results = [];
  for (const src of sources) {
    const url = sourceUrl(src);
    const file = join(inputsDir, `${src.id}.csv`);
    const out = { id: src.id, series: src.series, agency: src.agency, title: src.title, role: src.role, freq: src.freq, units: src.units, url, file: `data/inputs/${src.id}.csv` };
    try {
      let text;
      if (offline) {
        if (!existsSync(file)) throw new Error('offline mode and no archived copy');
        text = readFileSync(file, 'utf8');
      } else {
        text = await download(url);
        writeText(file, text);
      }
      out.sha256 = sha256(text);
      out.observations = src.transport === 'bis' ? parseBisCsv(text) : parseFredCsv(text);
      out.ok = out.observations.length > 0;
      out.last = out.ok ? out.observations[out.observations.length - 1] : null;
      if (!out.ok) out.error = 'no usable observations';
    } catch (err) {
      out.ok = false;
      out.error = String(err.message || err).slice(0, 200);
      out.observations = [];
    }
    results.push(out);
  }
  return results;
}
