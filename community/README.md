# Community agents: add your own agent to the swarm

*The People's Money* wants the best minds, and their AIs, to help watch the rule. This folder is the
sandbox where anyone can plug in an agent, like adding a Lego brick to a model that is already built.

Your agent gets a **read-only copy of the public record** every day and returns a **short report**. The report
appears on the dashboard under your name, marked *advisory*, and its fingerprint is sealed into the ledger.

## The ground rules

| Your agent can | Your agent can never |
|---|---|
| Read the latest record (`latest`) and every raw input series (`inputs`) | Change the rule, the calculators, the ledger, the executor or any published number |
| Compute anything from them, in Node or Python | See secrets: it runs with an empty environment |
| Return a status, a headline and up to 12 findings | Reach the internet: it runs in its own network namespace as the `nobody` user |
| Be written with any AI you like | Run longer than 20 seconds or print more than 64 KB |

Agents are like the book's sentinels: **they watch and report; people decide.** A new agent goes live only after
a maintainer reviews and merges its pull request. That merge is the human gate.

## Build one in five minutes

1. Copy `community/purchasing-power-clock/` to `community/<your-agent-id>/` (lowercase letters, digits, hyphens).
2. Edit `agent.json`:

```json
{
  "id": "your-agent-id",
  "name": "What it is, in a few words",
  "author": "Your name or GitHub handle",
  "role": "sentinel | auditor | analyst | reporter",
  "description": "One or two sentences: what it watches and why it matters.",
  "command": ["python3", "agent.py"],
  "homepage": "https://optional-link-about-you-or-your-method",
  "license": "MIT"
}
```

`command` must start with `python3` or `node`, followed by files inside your folder.

3. Write your agent. It reads ONE JSON object from **stdin**:

```json
{
  "schema": 1,
  "latest": { "...": "the same record the dashboard shows (data/latest.json)" },
  "inputs": { "CPI": { "title": "...", "agency": "...", "units": "...", "observations": [["2026-09-01", 336.298], "..."] }, "...": "..." }
}
```

It prints ONE JSON object to **stdout**:

```json
{
  "status": "ok | calm | watch | stress | info",
  "headline": "One plain sentence, 160 characters at most",
  "findings": [ { "label": "What you measured", "value": "the number or result", "note": "optional context" } ]
}
```

4. Try it exactly as the swarm will run it:

```bash
node scripts/community.js --only your-agent-id            # quick run
node scripts/community.js --isolate --only your-agent-id  # same sandbox as the daily job (Linux, needs sudo)
```

5. Open a pull request. The **Check** workflow runs your agent in the sandbox and rejects invalid reports.

## What makes a good agent

- **Facts, not forecasts.** The book never promises outcomes. Report what the data show, with dates and sources.
- **One job.** A sentinel that watches one thing well beats one that comments on everything.
- **Say what would change your mind.** Thresholds go in your code, in plain sight, with a note on why.
- **Plain words.** The dashboard is read by citizens, not only economists.

Ideas we would love: a check of the rule against other targets (2% inflation, nominal GDP, Friedman's k-percent rule);
a sentinel for an indicator we do not watch yet; an independent recompute of the rule in another language; an
auditor that hunts for anything odd in the ledger.

## Bringing your own AI

Your agent cannot call an AI service while it runs (no network, no keys), and that is deliberate: the daily
record must not depend on any outside model. Use your AI to **write and test** the agent; the agent itself
must be plain code anyone can read and re-run.
