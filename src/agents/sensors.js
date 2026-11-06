// SENSOR AGENTS
// Job: fetch each public series, fingerprint exactly what was received, and parse it.
// Rule: sensors never edit, fill, smooth or invent a number. A missing value stays missing.

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { sha256, writeText } from '../lib/util.js';
import { FRED_API_COMPARISON_TIMEOUT_MS, FRED_CSV_CHECK_TIMEOUT_MS, validDate, fredApiGate, fredParityEvidence, fredValuesEquivalent, fredEquivalenceEvidence, carryPriorQualification, validateFredCsv } from '../lib/fred-api-policy.js';

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
  `${FRED_API}?series_id=${encodeURIComponent(src.series)}&observation_start=${encodeURIComponent(src.start)}&file_type=json${key ? `&api_key=${encodeURIComponent(key)}` : ''}`;

export const fredJsonToCsv = (series, json) => {
  const body = JSON.parse(json);
  if (!body || !Array.isArray(body.observations)) throw new Error('Not a FRED API response');
  if (!body.observations.length) throw new Error('FRED API returned no observations');
  // A partial page must not silently replace the full archived time series.
  if ((body.offset !== undefined && body.offset !== 0)
      || (body.count !== undefined && (!Number.isInteger(body.count) || body.count !== body.observations.length))) {
    throw new Error('Incomplete FRED API observations');
  }
  const lines = [`observation_date,${series}`];
  let previous = ''; let usable = 0;
  for (const o of body.observations) {
    if (!o || !validDate(o.date) || o.date <= previous) throw new Error('Invalid or unordered FRED observation date');
    const value = o.value;
    // Plain decimals only (no scientific notation): the same form the comparison accepts, so the API
    // can never be authoritative with a value the parity check could not compare.
    if (value !== '.' && (typeof value !== 'string' || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value) || !Number.isFinite(Number(value)))) {
      throw new Error('Invalid FRED observation value');
    }
    if (value !== '.') usable++;
    lines.push(`${o.date},${value === '.' ? '' : value}`);
    previous = o.date;
  }
  if (!usable) throw new Error('FRED API returned no usable observations');
  return `${lines.join('\n')}\n`;
};

// Never let a key reach a stored error message or log line (including URL encoding).
export const scrub = (msg, key) => {
  let text = String(msg);
  if (key) for (const secret of [key, encodeURIComponent(key)]) text = text.split(secret).join('[key]');
  return text.replace(/([?&]api_key=)[^&\s'"<>]*/gi, '$1[key]');
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
// One wall-clock budget includes curl, fetch headers AND body, retries, and backoff.
// Comparison-only calls get a shorter budget so optional API work cannot stall a reading.
// Download limits (also used by vintages.js for the dated November 15 inputs):
//  - each attempt: curl up to perAttemptMs (90 s, as before), then Node fetch up to perAttemptMs
//    (before the safeguards, fetch had no time limit at all);
//  - up to `attempts` attempts (3, as before) with backoff of backoffMs × attempt between them (2 s, 4 s, as before);
//  - one overall cap, timeoutMs, over everything (276 s for normal downloads; 5 s for comparison-only API calls;
//    30 s for the CSV check that continues after a source has switched to the API).
// So a normal download behaves as before when curl answers, and can no longer hang without limit when it doesn't.
export const download = async (url, { attempts = 3, timeoutMs = 3 * 90000 + 6000, perAttemptMs = 90000,
  backoffMs = 2000, exec = execFileSync, fetchImpl = globalThis.fetch } = {}) => {
  if (!Number.isInteger(attempts) || attempts < 1 || !Number.isFinite(timeoutMs) || timeoutMs <= 0
      || !Number.isFinite(perAttemptMs) || perAttemptMs <= 0 || !Number.isFinite(backoffMs) || backoffMs < 0) {
    throw new Error('Invalid download budget');
  }
  const deadline = Date.now() + timeoutMs;
  const remaining = () => Math.max(0, deadline - Date.now());
  let lastErr; let tried = 0;
  for (let attempt = 1; attempt <= attempts && remaining() > 0; attempt++) {
    tried++;
    try {
      const budget = Math.max(1, Math.min(remaining(), perAttemptMs));
      return exec('curl', ['-sS', '-f', '-L', '-m', String(budget / 1000), url], {
        encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
        timeout: budget, killSignal: 'SIGKILL',
      });
    } catch (err) { lastErr = err; }
    if (!remaining()) break;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(remaining(), perAttemptMs));
    try {
      const res = await fetchImpl(url, { signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) { lastErr = err; }
    finally {
      clearTimeout(timer);
      controller.abort(); // Also close unconsumed error response bodies before a retry.
    }
    if (attempt < attempts && remaining() > 0) {
      await new Promise((r) => setTimeout(r, Math.min(backoffMs * attempt, remaining())));
    }
  }
  const reason = remaining() <= 0 ? `timeout after ${timeoutMs}ms` : String(lastErr?.message || lastErr).split('\n')[0];
  throw new Error(`download failed after ${tried} attempts: ${reason}`);
};

// Compare the two routes and record the result on `out`.
// Returns 'identical' | 'equivalent' | 'different'; 'api-invalid' when the API text itself fails the strict
// check (treated as a failed API response: never used, evidence dropped); or 'unavailable' when only the
// CSV is not a valid file for this series (a failed check: no evidence, not a real disagreement).
function compareRoutes(src, today, apiText, csvText, out, previous) {
  const eq = fredValuesEquivalent(apiText, csvText, src.series);
  if (eq.apiInvalid) { out.api_error = eq.reason; delete out.api_parity_evidence; return 'api-invalid'; }
  if (eq.unavailable) { out.csv_check_error = eq.reason; return 'unavailable'; }
  out.api_parity = apiText === csvText ? 'identical' : eq.equivalent ? 'equivalent' : 'different';
  if (out.api_parity === 'identical') {
    out.api_parity_evidence = carryPriorQualification(fredParityEvidence(src, today, sha256(csvText)), previous, src, today);
  } else if (out.api_parity === 'equivalent') {
    out.api_parity_evidence = carryPriorQualification(
      fredEquivalenceEvidence(src, today, sha256(apiText), sha256(csvText), eq.observations), previous, src, today);
  } else {
    delete out.api_parity_evidence;
    out.api_value_difference = eq.at ?? eq.reason;
    const a = apiText.split('\n'); const c = csvText.split('\n');
    let i = 0;
    while (i < Math.max(a.length, c.length) && a[i] === c[i]) i++;
    out.api_first_difference = { line: i + 1, api: (a[i] ?? '').slice(0, 60), csv: (c[i] ?? '').slice(0, 60), api_lines: a.length, csv_lines: c.length };
  }
  return out.api_parity;
}

async function fetchFred(src, url, key, useApi, out, { downloadFn, today, evidence }) {
  let apiText = null;
  try {
    apiText = fredJsonToCsv(src.series, await downloadFn(fredApiUrl(src, key), {
      attempts: useApi ? 3 : 1, timeoutMs: useApi ? 90000 : FRED_API_COMPARISON_TIMEOUT_MS,
    }));
  } catch (err) {
    out.api_error = scrub(err.message || err, key).slice(0, 200);
  }
  if (useApi && apiText !== null) {
    // Switched: the API is authoritative, but the CSV is still checked on every run.
    let csvText = null;
    try {
      csvText = await downloadFn(url, { attempts: 1, timeoutMs: FRED_CSV_CHECK_TIMEOUT_MS });
    } catch (err) {
      out.csv_check_error = scrub(err.message || err, key).slice(0, 200);
    }
    const result = csvText === null ? 'unavailable' : compareRoutes(src, today, apiText, csvText, out, evidence);
    if (result === 'api-invalid') {
      // Same as a failed API response: the normal CSV fallback, and the certificate is removed.
      out.via = 'fredgraph-csv (API fallback)';
      return validateFredCsv(csvText, src.series).ok ? csvText : await downloadFn(url);
    }
    if (result === 'unavailable') {
      // Check failed or file invalid: keep the API data; the old evidence is carried unchanged and expires.
      out.via = 'fred-api'; out.api_parity_evidence = evidence;
      return apiText;
    }
    if (result === 'different') {
      out.via = 'fredgraph-csv (API differed)'; // fail closed to the long-standing route
      return csvText;
    }
    out.via = 'fred-api';
    return apiText;
  }
  const csvText = await downloadFn(url);
  out.via = useApi ? 'fredgraph-csv (API fallback)' : 'fredgraph-csv';
  if (apiText !== null) compareRoutes(src, today, apiText, csvText, out, evidence);
  return csvText;
}

// The per-source record saved in data/latest.json. A refused download's fingerprint is kept here as a
// diagnostic (rejected_sha256); it never becomes the input fingerprint the ledger seals.
export const sourceRecord = (s) => ({
  id: s.id, series: s.series, agency: s.agency, title: s.title, url: s.url, file: s.file,
  sha256: s.sha256 ?? null, last: s.last ?? null, ok: s.ok, error: s.error ?? null,
  ...(s.rejected_sha256 ? { rejected_sha256: s.rejected_sha256 } : {}),
});

export async function runSensors(sources, { inputsDir, offline = false, fredKey = process.env.FRED_API_KEY || '', fredApiFrom = '9999-12-31', fredParity = {}, downloadFn = download, today = new Date().toISOString().slice(0, 10) } = {}) {
  const results = [];
  for (const src of sources) {
    const url = sourceUrl(src);
    const file = join(inputsDir, `${src.id}.csv`);
    const out = { id: src.id, series: src.series, agency: src.agency, title: src.title, role: src.role, freq: src.freq, historical: !!src.historical, units: src.units, url, file: `data/inputs/${src.id}.csv` };
    let digest = null;
    try {
      let text;
      if (offline) {
        if (!existsSync(file)) throw new Error('offline mode and no archived copy');
        text = readFileSync(file, 'utf8');
      } else if (src.transport === 'fred' && fredKey) {
        out.api_attempted = true;
        const evidence = fredParity?.[src.id];
        out.api_cutover_blocked = fredApiGate(src, { today, useFrom: fredApiFrom, evidence });
        text = await fetchFred(src, url, fredKey, !out.api_cutover_blocked, out, { downloadFn, today, evidence });
      } else {
        text = await downloadFn(url);
      }
      digest = sha256(text);
      // Once a source has switched to the API, whatever is about to be archived (API data, or the CSV used
      // as a fallback or after a mismatch) must pass the strict check for this exact series. Failing text is
      // rejected and the archive is left as it was. The pre-switch CSV route and ALFRED vintages are not
      // affected (protected November 15 path).
      if (out.api_attempted && out.api_cutover_blocked === null) {
        const v = validateFredCsv(text, src.series);
        if (!v.ok) throw new Error(`switched source: file failed the strict check (${v.reason}${v.line ? `, line ${v.line}` : ''})`);
      }
      out.observations = src.transport === 'bis' ? parseBisCsv(text) : parseFredCsv(text);
      out.ok = out.observations.length > 0;
      out.last = out.ok ? out.observations[out.observations.length - 1] : null;
      if (!out.ok) out.error = 'no usable observations';
      // Never replace an archive with an invalid response, and only fingerprint what is archived:
      // the ledger records out.sha256 and the auditor compares it with the file on disk.
      if (offline) out.sha256 = digest;
      else if (out.ok) { writeText(file, text); out.sha256 = digest; }
      else out.rejected_sha256 = digest;
    } catch (err) {
      out.ok = false;
      out.error = scrub(err.message || err, fredKey).slice(0, 200);
      out.observations = [];
      if (digest) { if (offline) out.sha256 = digest; else out.rejected_sha256 = digest; }
    }
    results.push(out);
  }
  return results;
}
