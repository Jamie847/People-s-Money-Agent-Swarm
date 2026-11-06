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

// FRED API (needs a free key, kept as the FRED_API_KEY secret). Its JSON is rewritten into exactly the
// layout fredgraph.csv returns, so stored files, fingerprints and parsing are unchanged whichever route was used.
const FRED_API = 'https://api.stlouisfed.org/fred/series/observations';
export const fredApiUrl = (src, key) =>
  `${FRED_API}?series_id=${encodeURIComponent(src.series)}&observation_start=${src.start}&file_type=json${key ? `&api_key=${key}` : ''}`;

export const fredJsonToCsv = (series, json) => {
  const body = JSON.parse(json);
  if (!Array.isArray(body.observations)) throw new Error('Not a FRED API response');
  const lines = [`observation_date,${series}`];
  for (const o of body.observations) lines.push(`${o.date},${o.value === '.' ? '' : o.value}`);
  return `${lines.join('\n')}\n`;
};

// Never let a key reach a stored error message or log line.
export const scrub = (msg, key) => (key ? String(msg).split(key).join('[key]') : String(msg));

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
export const download = async (url, { attempts = 3 } = {}) => {
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
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
  throw new Error(`download failed after ${attempts} attempts: ${String(lastErr?.message || lastErr).split('\n')[0]}`);
};

// With a key: before `fredApiFrom` both routes are fetched, the keyless file is still the one used,
// and any difference is recorded (a parity check). From that date on the API is used, falling back to
// the keyless file only if the API fails, and the fallback is recorded.
async function fetchFred(src, url, key, useApi, out) {
  let apiText = null;
  try {
    apiText = fredJsonToCsv(src.series, await download(fredApiUrl(src, key), { attempts: useApi ? 3 : 1 }));
  } catch (err) {
    out.api_error = scrub(err.message || err, key).slice(0, 200);
  }
  if (useApi && apiText !== null) { out.via = 'fred-api'; return apiText; }
  const csvText = await download(url);
  out.via = useApi ? 'fredgraph-csv (API fallback)' : 'fredgraph-csv';
  if (apiText !== null) {
    out.api_parity = apiText === csvText ? 'identical' : 'different';
    if (out.api_parity === 'different') {
      const a = apiText.split('\n'); const c = csvText.split('\n');
      const i = a.findIndex((line, k) => line !== c[k]);
      out.api_first_difference = { line: i + 1, api: (a[i] ?? '').slice(0, 60), csv: (c[i] ?? '').slice(0, 60), api_lines: a.length, csv_lines: c.length };
    }
  }
  return csvText;
}

export async function runSensors(sources, { inputsDir, offline = false, fredKey = process.env.FRED_API_KEY || '', fredApiFrom = '9999-12-31', today = new Date().toISOString().slice(0, 10) } = {}) {
  const results = [];
  for (const src of sources) {
    const url = sourceUrl(src);
    const file = join(inputsDir, `${src.id}.csv`);
    const out = { id: src.id, series: src.series, agency: src.agency, title: src.title, role: src.role, freq: src.freq, historical: !!src.historical, units: src.units, url, file: `data/inputs/${src.id}.csv` };
    try {
      let text;
      if (offline) {
        if (!existsSync(file)) throw new Error('offline mode and no archived copy');
        text = readFileSync(file, 'utf8');
      } else if (src.transport === 'fred' && fredKey) {
        text = await fetchFred(src, url, fredKey, today >= fredApiFrom, out);
        writeText(file, text);
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
      out.error = scrub(err.message || err, fredKey).slice(0, 200);
      out.observations = [];
    }
    results.push(out);
  }
  return results;
}
