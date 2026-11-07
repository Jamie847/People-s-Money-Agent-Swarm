# The People's Watch

*The People's Money*, run in public.

An **unofficial, public shadow run** of the issuance rule in *The People's Money* (Jamie Murray, 2026).

Every day, a network of small automated agents reads public data, applies the rule with three separately written calculators (ordinary code anyone can read; AI only writes the plain-English report, and every number in it is checked), watches for trouble at home and abroad, and publishes every number to a dashboard, with a tamper-evident record anyone can check.

> **The law sets the rule, people make the few real decisions, and the agents do everything else.**
> The rule's arithmetic is plain code, not AI. The agents fetch, check, watch and report around it. Nothing they do can change how much money the rule allows.

## What it is, and what it is not

- **It is** a working demonstration of how the design's replacement for the Federal Reserve could be run in the open: rule-based, recomputable, audited, with humans at the gates.
- **It is not** the design's formal 18-month rehearsal. It executes nothing and publishes **no national dollar issuance figure**: the book withholds one until a reconciled model release supports it (Ch. 10).
- **It does not test** whether the rule would keep prices stable. That needs the economic stress tests described in Chapter 9.
- Each live reading after the starting quarter uses the rule's inputs **as published on its computation date** (ALFRED vintages, fingerprinted in the record), so later revisions never change it. The starting quarter (2026-Q2) was read from data as published at launch; see interpretation 8 in `config/rule.json`. All data come through the St. Louis Fed's FRED/ALFRED, which republish BLS, BEA and Federal Reserve figures. The replay and the sentinels use current revised data.

## The agents, tier by tier

| Tier | Agents | Job | Never |
|---|---|---|---|
| 1 Sensors and integrity | Price sensors (BLS CPI-U, BEA PCE), growth sensor (BEA real GDP), global-dollar sensors (Fed H.4.1/H.10, BIS), domestic sensors; freshness and index-agreement checkers | Fetch, fingerprint (SHA-256) and check every input | Edit, fill or invent a number. The money authority may not produce the numbers it uses (Ch. 8) |
| 2 Calculators | Calculator A (JS), Calculator B (JS, different arithmetic), Calculator C (Python, re-reads raw files), Calculator D slot (outside author), consensus keeper | Apply the rule; publish only if every calculator that runs agrees (at least two; a missing one is flagged) | Use judgment or forecasts |
| 3 Sentinels | Brake monitor, global-dollar sentinel, home stress sentinel, plumbing and expectations sentinel, community agents (sandboxed), transition backstop modeler (proposal) | Watch around the clock; calm / watch / stress | Act |
| 4 Auditors and witnesses | Auditor, ledger keeper, Bitcoin witness, public attestation witness, archive witness, red team (attacks a copy of the record every run) | Re-check the hash-chained ledger, fingerprints and every frozen reading; hand checkpoints to outside witnesses | Trust their own output |
| 5 Human gates | Decision-packet clerk | Turn anything needing a person into a packet; open a GitHub issue | Decide |
| 6 Executors | Executor (shadow) | Write the instruction the rule authorizes; refuse anything else | Execute anything (shadow mode) |
| 7 Reporters | Reporter (AI), publisher | Explain in plain words; publish the dashboard | Say a number the engine did not produce. Every number is checked, and unverified text is rejected |

## Independent witnesses

After every run, a fingerprint of the ledger (a checkpoint in `data/checkpoints/`) goes to three witnesses this project does not control:

1. **Bitcoin**, via [OpenTimestamps](https://opentimestamps.org) (free). Proof files: `data/checkpoints/*.ots`. They complete a few hours after submission, once a Bitcoin block confirms them.
2. **Sigstore's public transparency log**, via GitHub artifact attestations, signed with the workflow's identity. Verify with `gh attestation verify <checkpoint> --repo Jamie847/peoples-money-watch`. (The repository was renamed on November 5, 2026. Checkpoints written before then record its old address; GitHub forwards the old links, and the sealed files are left exactly as they were written.)
3. **The Internet Archive**, which keeps an outside copy of each checkpoint file.

`node scripts/witness.js verify data/checkpoints/<file>` checks a checkpoint against the ledger. A witness proves when the record existed and that it has not changed since, not that the numbers are true.

## Community agents

Anyone can plug an agent into the Watch. See [`community/README.md`](community/README.md). Agents read a copy of the public record and return a short advisory report. They run sealed: empty environment, no network, read-only, 20-second limit. A maintainer's merge is the human gate.

## The rule (Chapter 7, Design Paper 0.7.2)

- **Target:** a flat price level, measured from the epoch quarter (the live run starts from 2026-Q2).
- **Price gap:** average of the CPI-U and PCE gaps, each in log points from its own epoch level, using three-month averages.
- **Trend growth:** average of the last ten annual percent changes in real GDP available on the computation date.
- **Path growth:** `clamp(trend − 0.5 × gap, 0%, 4%)` a year; quarterly step `(1 + a)^(1/4) − 1`.
- **Brake:** must engage after two successive available readings above 3 log points; releases at or below 1. A missing reading is disclosed and does not reset the count.
- **Fixed computation dates:** Feb 15, May 15, Aug 15, Nov 15. Each live reading is **frozen** once computed. Later revisions never change it.

Details the book leaves open are listed in `config/rule.json` → `interpretations_pending_review`, and on the dashboard.

## Check it yourself

```bash
python3 scripts/recompute.py --fetch  # independent recompute of the latest live quarter (no installs; downloads the FRED files for you)
node scripts/audit.js                 # verify the ledger chain, fingerprints and frozen readings
npm test                              # unit tests, including the book's three worked examples
```

### Why the FRED files aren't in this repository

FRED replied to our request (November 2026) that its terms don't allow keeping data downloaded through FRED in a public archive. So every run still downloads the files, fingerprints them, checks them and seals the fingerprints in the ledger, but the files themselves are no longer committed (older copies remain in the history for now while we ask FRED how its terms apply to them). The automatic switch to the FRED API is on hold for the same reason.

To check a run yourself, `recompute.py --fetch` downloads the same series from FRED for your own use. A dated ALFRED snapshot (used for each live reading) is fixed, so its fingerprint should match the record exactly; the latest files match until FRED adds or revises data. The plan is to move to the agencies' own sources (BLS, BEA, Treasury, Federal Reserve) where their terms allow a full public archive. The BIS file is still kept.

The dashboard site publishes only an explicit allowlist of record files (`scripts/build-site.js`), never the raw inputs, and the sentinel cards no longer carry history charts. Every build scans its own output, including the record built into the page, and fails, so nothing is uploaded, if it finds a file that isn't on the list, raw CSV or table-like text, or a data series in any common shape (numbers, numeric strings, date/value pairs, dated records or date-keyed maps) longer than 12 points, other than a short list of named derived series: the three historical replays and the side-by-side's price, money and cost series. Those are calculated from FRED data and stay published, with fixed fields and length limits, pending FRED's answer on derived results. Checkpoint files must have their expected fields, and timestamp proofs must really be OpenTimestamps files. The scan runs after the day's record is saved, so it stops a dashboard upload but not a save. Each frozen reading still lists the few input numbers it used (3 monthly price-index values per quarter and up to 11 annual GDP levels) so it can be rechecked; we have asked FRED how its terms treat these and other derived results.

## Run it

```bash
node scripts/run.js            # fetch live data, run every tier, seal the run, write data/latest.json
node scripts/run.js --offline  # reuse files from your own earlier run in data/inputs/ (no network; FRED files are not in the repo)
node scripts/build-site.js     # build the dashboard into _site/
```

Node 20+ and Python 3. No dependencies.

## One-time setup (repository owner)

1. **Settings → Pages → Build and deployment → Source: GitHub Actions.** The dashboard then publishes on every run.
2. **Settings → Secrets and variables → Actions → New repository secret:** `ANTHROPIC_API_KEY` (for the AI reporter). Without it, the reporter uses a plain template.
   Also add `FRED_API_KEY` (a free key from fredaccount.stlouisfed.org). With it, FRED series are fetched through the API in comparison mode first. The CSV remains authoritative until both `config/sources.json` → `fred_api.use_from` (never before Nov 16, 2026) and a matching comparison for that exact series/start on an earlier day, no more than 3 days old (the same dated values; layout differences such as `162.0` vs `162.000` are allowed). A comparison file that isn't a valid file for that series counts as a failed check, never as a match or a disagreement. After the switch the CSV is still checked on every run: a match renews the evidence (a same-day rerun stays eligible); any different number puts that source back on the CSV; if the check can't run, the evidence ages out after 3 days. Evidence and blocked switches are recorded in `data/latest.json` → `fred_api`. Invalid or empty API responses fall back to CSV and remove that source’s prior certificate. Comparison calls have a five-second total budget; after the switch the API call has a 90-second budget and the CSV check 30 seconds; normal downloads allow up to three attempts of 90 seconds each (curl, then fetch), capped at 276 seconds in total. See [transport safeguards](docs/fred-api-safeguards.md). Copyrighted series are credited to their owners on the dashboard.
3. **Actions → The People's Watch daily run → Run workflow** to start the first scheduled run. After that it runs daily.
4. On peoplesmoneyproject.org, link to or embed the Pages URL, e.g. `<iframe src="https://jamie847.github.io/peoples-money-watch/" style="width:100%;height:2400px;border:0"></iframe>`.

## Files

- `config/`: rule parameters, data sources, sentinel watch levels, transition backstop **proposal**
- `src/agents/`: one file per agent family
- `scripts/`: orchestrator, auditor, independent Python recompute, site builder, issue opener
- `data/inputs/`: raw files as downloaded during a run (FRED files are not committed; their fingerprints are in the ledger) · `data/ledger.jsonl`: hash-chained record of every run · `data/live-history.json`: frozen live readings · `data/latest.json`: what the dashboard reads
- `dashboard/`: the public page

## License

MIT. See `LICENSE`. This is an argument and a demonstration, not financial, legal or investment advice.
