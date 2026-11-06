// Transport rollout only. This module never changes monetary-rule inputs or arithmetic.
export const FRED_API_NOT_BEFORE = '2026-11-16';
export const FRED_API_COMPARISON_TIMEOUT_MS = 5000;

export const validDate = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
  && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

// A prior live comparison must certify this exact series/start and adapter version.
// Same-day results do not unlock the API. Source changes, missing/malformed proof,
// failed comparisons, and differing bytes all fail closed to the existing CSV route.
const HEX64 = /^[a-f0-9]{64}$/;

export function fredApiGate(src, { today, useFrom, evidence } = {}) {
  if (!validDate(today) || !validDate(useFrom)) return 'invalid or missing cutover date';
  if (today < FRED_API_NOT_BEFORE) return 'November 15 reading protected';
  if (today < useFrom) return 'before configured cutover date';
  const common = evidence && evidence.series === src.series && evidence.start === src.start
    && validDate(evidence.checked_on) && evidence.checked_on < today
    && HEX64.test(evidence.api_sha256 ?? '') && HEX64.test(evidence.csv_sha256 ?? '');
  const identical = evidence?.schema === 1 && evidence.status === 'identical' && evidence.api_sha256 === evidence.csv_sha256;
  const equivalent = evidence?.schema === 2 && evidence.status === 'equivalent' && evidence.method === EQUIVALENCE_METHOD
    && Number.isInteger(evidence.observations) && evidence.observations > 0;
  if (!common || !(identical || equivalent)) return 'no valid prior-day parity for this source';
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

const valuedRows = (text) => {
  const lines = text.trim().split(/\r?\n/);
  if (!/^observation_date,/i.test(lines[0] ?? '')) return null;
  const rows = [];
  for (const line of lines.slice(1)) {
    const parts = line.split(',');
    if (parts.length !== 2) return null;
    const [date, raw] = parts.map((x) => x.trim());
    if (!validDate(date)) return null;
    if (raw === '' || raw === '.') continue;
    const c = canonicalDecimal(raw);
    if (c === null) return null;
    rows.push([date, c]);
  }
  return rows;
};

export function fredValuesEquivalent(apiText, csvText) {
  const a = valuedRows(apiText); const c = valuedRows(csvText);
  if (!a || !c) return { equivalent: false, reason: 'unparseable layout' };
  const n = Math.max(a.length, c.length);
  for (let i = 0; i < n; i++) {
    if (!a[i] || !c[i] || a[i][0] !== c[i][0] || a[i][1] !== c[i][1]) {
      return { equivalent: false, reason: 'value or date differs', at: { api: a[i] ? a[i].join(',') : null, csv: c[i] ? c[i].join(',') : null, index: i } };
    }
  }
  if (!a.length) return { equivalent: false, reason: 'no valued observations' };
  return { equivalent: true, observations: a.length };
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
    parity_different: fred.filter((s) => s.api_parity === 'different').map((s) => ({ id: s.id, first_difference: s.api_first_difference })),
    api_errors: fred.filter((s) => s.api_error).map((s) => ({ id: s.id, error: s.api_error })),
    cutover_blocked: fred.filter((s) => s.api_cutover_blocked).map((s) => ({ id: s.id, reason: s.api_cutover_blocked })),
    parity_evidence: Object.fromEntries(fred.filter((s) => s.ok && s.api_parity_evidence).map((s) => [s.id, s.api_parity_evidence])),
  };
}
