// Transport rollout only. This module never changes monetary-rule inputs or arithmetic.
export const FRED_API_NOT_BEFORE = '2026-11-16';
export const FRED_API_COMPARISON_TIMEOUT_MS = 5000;

export const validDate = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
  && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

// A prior live comparison must certify this exact series/start and adapter version.
// Same-day results do not unlock the API. Source changes, missing/malformed proof,
// failed comparisons, and differing bytes all fail closed to the existing CSV route.
export function fredApiGate(src, { today, useFrom, evidence } = {}) {
  if (!validDate(today) || !validDate(useFrom)) return 'invalid or missing cutover date';
  if (today < FRED_API_NOT_BEFORE) return 'November 15 reading protected';
  if (today < useFrom) return 'before configured cutover date';
  if (evidence?.schema !== 1 || evidence.status !== 'identical'
      || evidence.series !== src.series || evidence.start !== src.start
      || !validDate(evidence.checked_on) || evidence.checked_on >= today
      || !/^[a-f0-9]{64}$/.test(evidence.api_sha256 ?? '')
      || evidence.api_sha256 !== evidence.csv_sha256) return 'no valid prior-day parity for this source';
  return null;
}

export function fredParityEvidence(src, today, digest) {
  return { schema: 1, status: 'identical', series: src.series, start: src.start,
    checked_on: today, api_sha256: digest, csv_sha256: digest };
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
    parity_different: fred.filter((s) => s.api_parity === 'different').map((s) => ({ id: s.id, first_difference: s.api_first_difference })),
    api_errors: fred.filter((s) => s.api_error).map((s) => ({ id: s.id, error: s.api_error })),
    cutover_blocked: fred.filter((s) => s.api_cutover_blocked).map((s) => ({ id: s.id, reason: s.api_cutover_blocked })),
    parity_evidence: Object.fromEntries(fred.filter((s) => s.ok && s.api_parity_evidence).map((s) => [s.id, s.api_parity_evidence])),
  };
}
