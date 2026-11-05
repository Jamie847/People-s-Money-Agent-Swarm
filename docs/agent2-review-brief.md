# Review brief for Agent 2: The People's Watch shadow run

Jamie asks you to review The People's Watch the way you reviewed the Design Paper: attack it, accept nothing on trust, and say plainly
what you accept, what you reject, and why. Four jobs, in order of importance.

**Repo:** https://github.com/Jamie847/People-s-Money-Agent-Swarm · **Dashboard:** https://jamie847.github.io/People-s-Money-Agent-Swarm/
**Rule source:** *The People's Money* Ch. 7 and Design Paper 0.7.2 (as clarified Nov 1, 2026).

## 1. Rule on the seven interpretations

The book leaves these open; the Watch had to choose. For each: **accept**, **change** (give the exact rule), or **send to
Jamie** as a policy decision. They are listed in `config/rule.json` → `interpretations_pending_review`.

1. CPI-U and PCE have different base years, so each is a log gap from its own epoch level, and the two gaps are averaged.
2. Seasonally adjusted CPI-U (CPIAUCSL).
3. Annual path rate → quarterly step by compounding: (1 + a)^(1/4) − 1.
4. Fixed computation dates: Feb 15, May 15, Aug 15, Nov 15. Annual GDP for year Y counts from May 1 of Y+1.
5. Trend growth = arithmetic mean of the last ten annual percent changes in real GDP.
6. "As first released" = "as published on the computation date" (ALFRED vintage). The 2026-Q2 starting quarter used launch data.
7. Brake release "within 1% of target" = gap ≤ 1 log point.

Also check: later quarters measure from the **frozen** starting-quarter prices, not from a re-read copy. Is that right?

## 2. Review the sentinel watch levels

`config/sentinels.json`. All are provisional and none comes from the book. Say which to keep, change or drop, and which
indicator is missing. In particular: swap lines watch $10B / stress $50B; foreign custody 13-week change −3% / −6%;
dollar index ~1-month +3% / +5%; SOFR over IORB +0.10 / +0.25 points; 5y5y expectations 3.0% / 3.5%.

## 3. Write Calculator D, independently

Write a recompute of the rule **from the book and Design Paper, without reading this repo's calculator code**, as a
community agent (`community/<id>/`, see `community/README.md`) that returns a `recompute` object. The Watch compares it
every run and raises a public flag on any difference larger than 0.001. Disagreement is a finding, not a failure: report
which implementation is wrong.

## 4. Attack the transition dollar backstop proposal

`config/backstop-proposal.json` (Jamie's "methadone" idea; **not** in Design Paper 0.7.2). Is a cap at 20% of foreign official
custody holdings defensible against the 2008 ($583B) and 2020 ($449B) swap peaks? Should the taper follow the calendar,
the sentinels, or both? Who is eligible? Does the design need any rule for dollar deposits created by banks outside
the United States? Recommend: adopt into the Design Paper, revise, or drop.

## Already in place (so you can attack it)

Three calculators must agree (JS ×2, Python), frozen quarterly readings, hash-chained ledger, auditor, a daily red team,
independent witnesses (OpenTimestamps → Bitcoin, Sigstore transparency log, Internet Archive), and a community-agent
sandbox (empty environment, no network namespace, `nobody` user, 20 s, 64 KB). Red-team ideas are welcome; add them
as attacks in `scripts/redteam.js`.

**Return:** a .md file with your rulings and findings, as with earlier reviews. Wording rules: never "validated" or
"audited"; this is AI-assisted checking of a shadow run, not an outside professional audit.
