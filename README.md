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
- Each live reading after the starting quarter uses the rule's inputs **as published on its computation date** (ALFRED vintages, archived in `data/inputs/vintages/`), so later revisions never change it. The starting quarter (2026-Q2) was read from data as published at launch; see interpretation 8 in `config/rule.json`. All data come through the St. Louis Fed's FRED/ALFRED, which republish BLS, BEA and Federal Reserve figures. The replay and the sentinels use current revised data.

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
2. **Sigstore's public transparency log**, via GitHub artifact attestations, signed with the workflow's identity. Verify with `gh attestation verify <checkpoint> --repo Jamie847/People-s-Money-Agent-Swarm`.
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
python3 scripts/recompute.py          # independent recompute of the latest live quarter (no installs)
node scripts/audit.js                 # verify the ledger chain, fingerprints and frozen readings
npm test                              # unit tests, including the book's three worked examples
```

## Run it

```bash
node scripts/run.js            # fetch live data, run every tier, seal the run, write data/latest.json
node scripts/run.js --offline  # reuse data/inputs/ (no network)
node scripts/build-site.js     # build the dashboard into _site/
```

Node 20+ and Python 3. No dependencies.

## One-time setup (repository owner)

1. **Settings → Pages → Build and deployment → Source: GitHub Actions.** The dashboard then publishes on every run.
2. **Settings → Secrets and variables → Actions → New repository secret:** `ANTHROPIC_API_KEY` (for the AI reporter). Without it, the reporter uses a plain template.
3. **Actions → Swarm run → Run workflow** to start the first scheduled run. After that it runs daily.
4. On peoplesmoneyproject.org, link to or embed the Pages URL, e.g. `<iframe src="https://jamie847.github.io/People-s-Money-Agent-Swarm/" style="width:100%;height:2400px;border:0"></iframe>`.

## Files

- `config/`: rule parameters, data sources, sentinel watch levels, transition backstop **proposal**
- `src/agents/`: one file per agent family
- `scripts/`: orchestrator, auditor, independent Python recompute, site builder, issue opener
- `data/inputs/`: raw files exactly as downloaded · `data/ledger.jsonl`: hash-chained record of every run · `data/live-history.json`: frozen live readings · `data/latest.json`: what the dashboard reads
- `dashboard/`: the public page

## License

MIT. See `LICENSE`. This is an argument and a demonstration, not financial, legal or investment advice.
