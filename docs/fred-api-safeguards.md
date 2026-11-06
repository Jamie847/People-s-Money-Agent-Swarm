# FRED transport safeguards

These safeguards change transport selection, validation and diagnostics only. The monetary rule, calculators, vintage-selection logic and frozen-reading logic are unchanged.

## Switching routes

The API cannot become authoritative before **November 16, 2026**, even if `fred_api.use_from` is accidentally moved earlier. A later configured date still applies.

Each FRED source must also have a byte-identical API/CSV comparison recorded on an earlier calendar day. Its certificate in `data/latest.json` → `fred_api.parity_evidence` identifies the adapter schema, series, start date, comparison date and matching SHA-256 digests. An old count of successful comparisons is not sufficient. Missing, malformed, same-day, future-dated or wrong-source evidence leaves that source in CSV comparison mode. Sources can qualify independently.

Comparison mode always selects CSV, including the day on which the first successful comparison is obtained. The API copy is optional and has a five-second download budget. An unsuccessful comparison cannot change the selected CSV data. A mismatch is recorded with the first differing line, and no certificate is issued.

Once a source qualifies, successful API fetches carry its certificate forward. This is **historical compatibility evidence, not continuous parity verification or a fresh-data guarantee**. No age limit is imposed; a source change, adapter schema change, failed API fetch, offline run or run without a key requires a new comparison. It is not an externally signed attestation. Maintainers control the repository and its evidence.

## Invalid data and fallback

API responses must contain observations with valid increasing dates and finite numeric values or the official `.` missing-value marker. Empty arrays, entirely missing data, malformed rows, duplicate dates and incomplete pages are rejected. Missing values are never filled or turned into zero.

An invalid or failed API response uses the existing CSV fallback. It removes the source's certificate, so a later run must compare successfully again before switching. If CSV also fails, the sensor reports failure and leaves the archived file untouched. It does not silently use stale archived data as a successful live result.

The summary includes API errors even if both routes fail before a `via` value can be assigned. Offline mode is reported separately and cannot manufacture live parity evidence. Keys, including URL-encoded keys, are scrubbed from diagnostics.

## Download limits

Normal downloads have one 90-second wall-clock budget covering curl, Node fetch headers and body, retries and backoff. Comparison downloads have one five-second budget. Error response streams are aborted before retrying. An authoritative API attempt followed by a separate CSV fallback can therefore take approximately 180 seconds per source, not 90 seconds for both routes together. These are per-source limits, not a whole-workflow deadline.

Curl retains its existing 64 MiB output limit. Native fetch is time-bounded but does not add a response-size cap in this patch. Neither timeout proves availability or handles every upstream outage.

## Verification and rollout

Run `npm run check` and `python3 scripts/recompute.py`. Fixture tests cover the protected date, prior-day gating, missing/malformed proof, successful switching, invalid data and fallback, credential scrubbing, request/body timeouts, and both no-key and offline behavior. All archived FRED fixtures are reconstructed through the adapter and must match the original bytes. A Nov 15 frozen-reading test verifies that later input changes cannot rewrite the reading.

The tests use fixtures and temporary directories, not live services or real credentials. They do not establish live FRED availability, current upstream parity or API-terms compliance. Keep the existing Nov 15 schedule and rule configuration unchanged. Review and merge approval, a fresh check against current main, and the normal deployment checks are still required before this preparation becomes live. Do not manufacture or pre-populate a parity certificate to accelerate cutover.
