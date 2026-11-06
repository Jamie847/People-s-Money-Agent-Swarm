// Transport rollout only. This module never changes monetary-rule inputs or arithmetic.
export const FRED_API_NOT_BEFORE = '2026-11-16';
// Parity evidence is only trusted for a few days. Daily runs refresh it (before and after the switch);
// the margin covers a skipped or failed scheduled run. Older evidence sends the source back to the CSV.
export const FRED_PARITY_MAX_AGE_DAYS = 3;
// After the switch the CSV is still fetched once per run as a check, with a modest budget.
export const FRED_CSV_CHECK_TIMEOUT_MS = 30000;
const ageDays = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
export const FRED_API_COMPARISON_TIMEOUT_MS = 5000;

export const validDate = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
  && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

// A prior live comparison must certify this exact series/start and comparison method.
// Same-day results do not unlock the API. Source changes, missing/malformed proof,
// failed or mismatched comparisons all fail closed to the existing CSV route.
const HEX64 = /^[a-f0-9]{64}$/;

// The date of the matching comparison that qualifies `src` today, or null. A certificate renewed earlier
// today keeps the earlier day's match in prior_checked_on, so a same-day rerun stays eligible.
export function evidenceQualifyingDate(src, evidence, today) {
  if (!evidence || typeof evidence !== 'object' || !validDate(today)) return null;
  const common = evidence.series === src.series && evidence.start === src.start
    && validDate(evidence.checked_on) && evidence.checked_on <= today
    && HEX64.test(evidence.api_sha256 ?? '') && HEX64.test(evidence.csv_sha256 ?? '');
  const identical = evidence.schema === 1 && evidence.status === 'identical' && evidence.api_sha256 === evidence.csv_sha256;
  const equivalent = evidence.schema === 2 && evidence.status === 'equivalent' && evidence.method === EQUIVALENCE_METHOD
    && Number.isInteger(evidence.observations) && evidence.observations > 0;
  const prior = evidence.prior_checked_on;
  const priorOk = prior === undefined || (validDate(prior) && prior < evidence.checked_on);
  if (!common || !(identical || equivalent) || !priorOk) return null;
  if (evidence.checked_on < today) return evidence.checked_on;
  return prior !== undefined && prior < today ? prior : null;
}

// When a check is renewed, keep the earlier qualifying day so later runs on the same day stay eligible.
export function carryPriorQualification(next, previous, src, today) {
  const q = evidenceQualifyingDate(src, previous, today);
  return q && q < today ? { ...next, prior_checked_on: q } : next;
}

export function fredApiGate(src, { today, useFrom, evidence } = {}) {
  if (!validDate(today) || !validDate(useFrom)) return 'invalid or missing cutover date';
  if (today < FRED_API_NOT_BEFORE) return 'November 15 reading protected';
  if (today < useFrom) return 'before configured cutover date';
  const q = evidenceQualifyingDate(src, evidence, today);
  if (!q) return 'no valid prior-day parity for this source';
  if (ageDays(q, today) > FRED_PARITY_MAX_AGE_DAYS) return `parity evidence older than ${FRED_PARITY_MAX_AGE_DAYS} days`;
  return null;
}

export function fredParityEvidence(src, today, digest) {
  return { schema: 1, status: 'identical', series: src.series, start: src.start,
    checked_on: today, api_sha256: digest, csv_sha256: digest };
}

// The API and fredgraph.csv publish the same numbers in different layouts: the API trims trailing zeros
// ("162.0" vs "162.000") and lists some dates with no value (holidays) that the CSV leaves out.
// "Equivalent" means every dated value is exactly the same decimal number, and the same dates carry values.
// Rows without a value carry nothing and are ignored on both sides. Any other difference fails closed.
export const EQUIVALENCE_METHOD = 'decimal-values-v1';

const canonicalDecimal = (v) => {
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(v)) return null; // plain decimals only; anything else is not comparable
  let [int, frac = ''] = v.replace(/^\+/, '').split('.');
  const neg = int.startsWith('-'); if (neg) int = int.slice(1);
  int = int.replace(/^0+(?=\d)/, '') || '0';
  frac = frac.replace(/0+$/, '');
  const body = frac ? `${int}.${frac}` : int;
  return neg && body !== '0' ? `-${body}` : body;
};

// Strict check of one series in fredgraph layout, used only for the API/CSV comparison. The general
// parser (parseFredCsv, also used for ALFRED vintages) is deliberately left as it was.
// Requires: header exactly "observation_date,<series>", two columns per row, real calendar dates in
// strictly increasing order, and values that are finite plain decimals or the official missing markers.
export function validateFredCsv(text, series) {
  if (typeof text !== 'string' || typeof series !== 'string' || !series) return { ok: false, reason: 'no text or series' };
  const lines = text.trim().split(/\r?\n/);
  if (lines[0] !== `observation_date,${series}`) return { ok: false, reason: 'header is not observation_date,' + series, line: 1 };
  const rows = []; let prev = '';
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',');
    if (parts.length !== 2) return { ok: false, reason: 'row does not have two columns', line: i + 1 };
    const [date, raw] = parts;
    if (!validDate(date)) return { ok: false, reason: 'invalid date', line: i + 1 };
    if (date <= prev) return { ok: false, reason: 'dates not strictly increasing', line: i + 1 };
    prev = date;
    if (raw === '' || raw === '.') continue;
    const c = canonicalDecimal(raw);
    if (c === null) return { ok: false, reason: 'unsupported value', line: i + 1 };
    if (!Number.isFinite(Number(raw))) return { ok: false, reason: 'value out of range', line: i + 1 };
    rows.push([date, c]);
  }
  if (!rows.length) return { ok: false, reason: 'no valued observations' };
  return { ok: true, rows };
}

// The API side is checked first. `apiInvalid: true` means the API text is not a valid file for this series:
// the caller treats it as a failed API response (never used). `unavailable: true` means only the CSV is
// invalid: there is no comparison at all (a failed check, never evidence of a real disagreement).
export function fredValuesEquivalent(apiText, csvText, series) {
  const a = validateFredCsv(apiText, series);
  if (!a.ok) return { equivalent: false, apiInvalid: true, reason: `API text invalid: ${a.reason}${a.line ? ` (line ${a.line})` : ''}` };
  const c = validateFredCsv(csvText, series);
  if (!c.ok) return { equivalent: false, unavailable: true, reason: `CSV check file invalid: ${c.reason}${c.line ? ` (line ${c.line})` : ''}` };
  const n = Math.max(a.rows.length, c.rows.length);
  for (let i = 0; i < n; i++) {
    const x = a.rows[i]; const y = c.rows[i];
    if (!x || !y || x[0] !== y[0] || x[1] !== y[1]) {
      return { equivalent: false, reason: 'value or date differs', at: { api: x ? x.join(',') : null, csv: y ? y.join(',') : null, index: i } };
    }
  }
  return { equivalent: true, observations: a.rows.length };
}

export function fredEquivalenceEvidence(src, today, apiDigest, csvDigest, observations) {
  return { schema: 2, status: 'equivalent', method: EQUIVALENCE_METHOD, series: src.series, start: src.start,
    checked_on: today, observations, api_sha256: apiDigest, csv_sha256: csvDigest };
}

// Report failed sensors too: filtering only on `via` would hide total fetch failures.
// No-key and offline runs do not create or carry forward live parity certificates.
export function summarizeFredApi(sensors, { keyPresent, offline, useFrom }) {
  const fred = sensors.filter((s) => s.api_attempted);
  return {
    key_present: keyPresent,
    mode: offline ? 'offline' : keyPresent ? 'live' : 'keyless',
    use_from: useFrom || null,
    not_before: FRED_API_NOT_BEFORE,
    via_api: fred.filter((s) => s.via === 'fred-api').length,
    via_csv: fred.filter((s) => s.via?.startsWith('fredgraph-csv')).length,
    parity_identical: fred.filter((s) => s.api_parity === 'identical').length,
    parity_equivalent: fred.filter((s) => s.api_parity === 'equivalent').length,
    parity_different: fred.filter((s) => s.api_parity === 'different').map((s) => ({ id: s.id, value_difference: s.api_value_difference ?? null, first_difference: s.api_first_difference ?? null })),
    csv_check_errors: fred.filter((s) => s.csv_check_error).map((s) => ({ id: s.id, error: s.csv_check_error })),
    api_errors: fred.filter((s) => s.api_error).map((s) => ({ id: s.id, error: s.api_error })),
    cutover_blocked: fred.filter((s) => s.api_cutover_blocked).map((s) => ({ id: s.id, reason: s.api_cutover_blocked })),
    parity_evidence: Object.fromEntries(fred.filter((s) => s.ok && s.api_parity_evidence).map((s) => [s.id, s.api_parity_evidence])),
  };
}
