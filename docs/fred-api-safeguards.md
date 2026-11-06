# FRED transport safeguards

These safeguards change transport selection, validation and diagnostics only. The monetary rule, calculators, vintage-selection logic and frozen-reading logic are unchanged.

## Switching routes

The API cannot become authoritative before **November 16, 2026**, even if `fred_api.use_from` is accidentally moved earlier. A later configured date still applies.

Each FRED source must also have a matching API/CSV comparison recorded on an earlier calendar day, no more than 3 days before the run (`FRED_PARITY_MAX_AGE_DAYS`). Daily runs normally make it the previous day; the margin only covers a skipped or failed scheduled run. A match is either byte-identical text (certificate schema 1, status `identical`) or the same observations with the same values written differently (schema 2, status `equivalent`, method `decimal-values-v1`). The equivalence check compares every dated row that carries a value: the dates must match one for one and each value must be the same plain decimal once leading or trailing zeros and a leading `+` are removed (`162.0` = `162.000`). Rows with no value (`''` or `.`, such as market holidays or the missing October 2025 CPI) are ignored on both sides, exactly as every calculator already ignores them. Anything else — a different number, an extra or missing valued date, scientific notation, a bad header, or nothing to compare — is recorded as `different` with the first disagreement in `api_value_difference`, and the source stays on CSV. The certificate in `data/latest.json` → `fred_api.parity_evidence` identifies the schema, series, start date, comparison date, the number of observations compared (schema 2) and both SHA-256 digests. An old count of successful comparisons is not sufficient. Missing, malformed, same-day, future-dated, wrong-source or expired evidence leaves that source in CSV comparison mode. Sources can qualify independently.

Comparison mode always selects CSV, including the day on which the first successful comparison is obtained. The API copy is optional and has a five-second download budget. An unsuccessful comparison cannot change the selected CSV data. A mismatch is recorded with the first differing line, and no certificate is issued.

After a source switches, its archived file is the API text converted to CSV layout, so the file's bytes and fingerprint change on the switch day even though the values do not; the ledger records the new fingerprint as usual. Before merging this rule, every input was rewritten in the API's layout (trimmed decimals, extra blank rows) and the full offline run plus `scripts/recompute.py` were repeated: every rule number, history row, community result and red-team result was identical; only the fingerprints differed.

## After the switch: parity is checked on every run

A switched source still downloads the CSV on every run, as a check (one attempt, 30-second cap), and compares it with the API data using the same rule:

- **Match** (identical or equivalent): the API data is used and the certificate is renewed with today's date.
- **Different** (any number, valued date or layout that does not match): that day's data comes from the CSV (`via` = `fredgraph-csv (API differed)`), the certificate is dropped, and the difference is listed in `fred_api.parity_different`. The source then stays on the CSV until a later comparison matches again and a following day passes the gate.
- **Check unavailable** (CSV download failed, or it returned no usable observations): the API data is used, the error is listed in `fred_api.csv_check_errors`, and the old certificate is carried forward unchanged. It is not renewed, so after 3 days without a successful check it expires and the source returns to the CSV.

So a source is never on the API on the strength of a comparison more than 3 days old. This is still self-issued evidence, not an externally signed attestation; maintainers control the repository and its evidence. Continuing to download the CSV keeps the same daily request pattern the Watch used before the switch; if FRED's reply to the permission request calls for fewer keyless downloads, the check can move to a rotating sample with a matching expiry.

## Invalid data and fallback

API responses must contain observations with valid increasing dates and finite numeric values or the official `.` missing-value marker. Empty arrays, entirely missing data, malformed rows, duplicate dates and incomplete pages are rejected. Missing values are never filled or turned into zero.

An invalid or failed API response uses the existing CSV fallback. It removes the source's certificate, so a later run must compare successfully again before switching. If CSV also fails, the sensor reports failure and leaves the archived file untouched. It does not silently use stale archived data as a successful live result.

The summary includes API errors even if both routes fail before a `via` value can be assigned. Offline mode is reported separately and cannot manufacture live parity evidence. Keys, including URL-encoded keys, are scrubbed from diagnostics.

## Download limits

Download limits (review revision, November 6). Normal downloads keep the earlier per-attempt patience: each of up to three attempts gives curl up to 90 seconds and then Node fetch up to 90 seconds, with 2- and 4-second pauses between attempts, all under one overall cap of 276 seconds. Before the safeguards, curl had the same 90-second limit but fetch had none, so a hanging connection could stall a run indefinitely; that can no longer happen. Comparison-only API calls have one five-second cap; the post-switch CSV check has one 30-second cap. Error response streams are aborted before retrying.

Worst cases, per source, when the server hangs rather than refusing: about 276 seconds for a normal download; about 281 seconds in comparison mode (5 + 276); about 552 seconds after the switch if the API hangs and the CSV fallback then hangs too (if the API answers and only the CSV check hangs, about 30 seconds more than the API call). Across 27 FRED series a total outage could therefore add up to about 2 hours before the switch and about 4 hours after it, inside GitHub's 6-hour job limit but long. A later improvement would stop trying the API for the rest of a run after repeated failures. These are per-source limits, not a whole-workflow deadline.

Curl retains its existing 64 MiB output limit. Native fetch is time-bounded but does not add a response-size cap in this patch. Neither timeout proves availability or handles every upstream outage.

## Verification and rollout

Run `npm run check` and `python3 scripts/recompute.py`. Fixture tests cover the protected date, prior-day gating, evidence expiry, post-switch checks (match, difference, check unavailable), missing/malformed proof, successful switching, invalid data and fallback, credential scrubbing, request/body timeouts, and both no-key and offline behavior. All archived FRED fixtures are reconstructed through the adapter and must match the original bytes. A Nov 15 frozen-reading test verifies that later input changes cannot rewrite the reading.

The tests use fixtures and temporary directories, not live services or real credentials. They do not establish live FRED availability, current upstream parity or API-terms compliance. Keep the existing Nov 15 schedule and rule configuration unchanged. Review and merge approval, a fresh check against current main, and the normal deployment checks are still required before this preparation becomes live. Do not manufacture or pre-populate a parity certificate to accelerate cutover.
