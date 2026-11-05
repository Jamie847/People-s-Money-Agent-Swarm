#!/usr/bin/env node
// ORCHESTRATOR — runs the whole swarm once, in tier order, and publishes the results.
//   node scripts/run.js            fetch live data, compute, publish
//   node scripts/run.js --offline  reuse data/inputs/ (no network)
// Environment: SWARM_TODAY=YYYY-MM-DD (override the date), ANTHROPIC_API_KEY (AI reporter, optional).

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { readJSON, writeJSON, sha256, stableStringify, parseQuarter, round } from '../src/lib/util.js';
import { runSensors } from '../src/agents/sensors.js';
import { checkSources, checkIndexDisagreement, worst } from '../src/agents/integrity.js';
import { runLiveTrack, runReplay } from '../src/agents/tracks.js';
import { runSentinels } from '../src/agents/sentinels.js';
import { runBackstop } from '../src/agents/backstop.js';
import { shadowInstruction } from '../src/agents/executor.js';
import { buildPackets } from '../src/agents/governance.js';
import { appendLedger } from '../src/agents/ledger.js';
import { runAudit } from '../src/agents/auditor.js';
import { runReporter } from '../src/agents/reporter.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const P = (...p) => join(root, ...p);
const offline = process.argv.includes('--offline');
const today = process.env.SWARM_TODAY || new Date().toISOString().slice(0, 10);
const startedAt = new Date().toISOString();

const rule = readJSON(P('config', 'rule.json'));
const { sources } = readJSON(P('config', 'sources.json'));
const sentinelCfg = readJSON(P('config', 'sentinels.json'));
const proposal = readJSON(P('config', 'backstop-proposal.json'));

// ---- Tier 1: sensors and integrity ----
const sensors = await runSensors(sources, { inputsDir: P('data', 'inputs'), offline });
const byId = Object.fromEntries(sensors.map((s) => [s.id, s]));
const sourceChecks = checkSources(sensors, today);
const ruleInputsOk = ['CPI', 'PCE', 'GDP'].every((id) => byId[id]?.ok);
const indexCheck = ruleInputsOk ? checkIndexDisagreement(byId.CPI.observations, byId.PCE.observations, rule.index_disagreement_pp) : null;

// ---- Tier 2: calculators (live track + replays) ----
const history = readJSON(P('data', 'live-history.json'), []);
let live = null;
let replays = [];
if (ruleInputsOk) {
  live = runLiveTrack({ root, sensorById: byId, rule, today, history });
  replays = rule.replay_epochs.map((e) => runReplay({ sensorById: byId, rule, epochLabel: e }));
}
const liveLatest = live?.history.length ? live.history[live.history.length - 1] : null;

// ---- Tier 3: sentinels ----
const ctx = { epochQ: parseQuarter(rule.live_epoch_quarter), byId };
const globalDollar = runSentinels(byId, sentinelCfg.global_dollar, ctx);
const domestic = runSentinels(byId, sentinelCfg.domestic, ctx);
const plumbing = runSentinels(byId, sentinelCfg.plumbing, ctx);
// Community agents ran earlier in the sandbox (scripts/community.js); their reports are advisory.
const community = readJSON(P('data', 'community.json'), { agents: [] });
const communityText = (() => { try { return readFileSync(P('data', 'community.json'), 'utf8'); } catch { return ''; } })();
const backstop = runBackstop(byId, proposal, globalDollar.overall);

// ---- Tier 5 & 6: human gates and executor ----
const brake = live?.brake ?? { current: { phase: 'off', note: 'No live readings.' }, states: [] };
const instruction = shadowInstruction({ liveLatest, consensusResult: liveLatest?.consensus, brake });
const packets = buildPackets({ consensusResult: liveLatest?.consensus, liveLatest, integrity: sourceChecks, indexCheck, brake, globalDollar, domestic, plumbing, rule, backstop });
const seen = new Set(readJSON(P('data', 'packets-seen.json'), []));
const newPackets = packets.filter((p) => !seen.has(p.id) && p.severity !== 'info');

// ---- Write the frozen live history, then seal the run in the ledger ----
if (live) writeJSON(P('data', 'live-history.json'), live.history);
const liveHistoryText = (() => { try { return readFileSync(P('data', 'live-history.json'), 'utf8'); } catch { return '[]\n'; } })();
const ruleText = readFileSync(P('config', 'rule.json'), 'utf8');
const ledgerEntry = appendLedger(P('data', 'ledger.jsonl'), {
  run_date: today,
  started_at: startedAt,
  mode: offline ? 'offline' : 'live',
  inputs_sha256: Object.fromEntries(sensors.map((s) => [s.id, s.sha256 ?? null])),
  rule_sha256: sha256(ruleText),
  live_history_sha256: sha256(liveHistoryText),
  latest_quarter: liveLatest?.quarter ?? null,
  latest_outputs_sha256: liveLatest?.outputs ? sha256(stableStringify(liveLatest.outputs)) : null,
  brake_phase: brake.current.phase,
  global_dollar: globalDollar.overall,
  domestic: domestic.overall,
  plumbing: plumbing.overall,
  community_sha256: communityText ? sha256(communityText) : null,
  packets: packets.map((p) => p.id),
});

// ---- Tier 4: audit ----
const audit = runAudit(root);

// ---- Assemble what the dashboard reads ----
const status = (ok) => (ok ? 'ok' : 'fail');
const sensorStatus = (ids) => worst(ids.map((id) => (byId[id]?.ok ? (sourceChecks.find((c) => c.id === id)?.status ?? 'ok') : 'fail')));
const cons = liveLatest?.consensus;
const calcStatus = (k) => (!liveLatest?.calculators ? 'info' : liveLatest.calculators[k]?.error ? 'warn' : cons?.agreed ? 'ok' : 'fail');
const lvl = (s) => ({ calm: 'ok', watch: 'warn', stress: 'fail', context: 'info' }[s] ?? 'info');

const agents = [
  { tier: 1, group: 'Sensors', name: 'Price sensor — CPI-U', job: 'Fetch the BLS consumer price index; fingerprint it; never alter it.', status: sensorStatus(['CPI']) },
  { tier: 1, group: 'Sensors', name: 'Price sensor — PCE', job: 'Fetch the BEA PCE price index; fingerprint it; never alter it.', status: sensorStatus(['PCE']) },
  { tier: 1, group: 'Sensors', name: 'Growth sensor — real GDP', job: 'Fetch BEA annual real GDP for the ten-year trend.', status: sensorStatus(['GDP']) },
  { tier: 1, group: 'Sensors', name: 'Global-dollar sensors', job: 'Fed H.4.1 swap lines, foreign repo and custody; H.10 dollar index; BIS offshore dollar credit.', status: sensorStatus(['SWAPS', 'FIMA_REPO', 'FOREIGN_CUSTODY', 'DOLLAR_INDEX', 'OFFSHORE_CREDIT']) },
  { tier: 1, group: 'Sensors', name: 'Domestic sensors', job: '10-year yield, bank credit, St. Louis and Chicago stress indexes.', status: sensorStatus(['TEN_YEAR', 'BANK_CREDIT', 'STRESS_STL', 'STRESS_CHI']) },
  { tier: 1, group: 'Sensors', name: 'Plumbing and expectations sensors', job: 'SOFR, reserve rate, reserves, Treasury cash, reverse repo, inflation expectations, median CPI, unemployment.', status: sensorStatus(['SOFR', 'IORB', 'RESERVES', 'TGA', 'ON_RRP', 'EXPECT_5Y5Y', 'EXPECT_MICH', 'MEDIAN_CPI', 'UNEMPLOYMENT']) },
  { tier: 1, group: 'Integrity', name: 'Freshness checker', job: 'Flag missing or stale inputs; disclose, never fill.', status: worst(sourceChecks.map((c) => c.status)) },
  { tier: 1, group: 'Integrity', name: 'Index-agreement checker', job: 'Flag when CPI-U and PCE 12-month changes differ by more than 1.5 points.', status: indexCheck?.status ?? 'fail' },
  { tier: 2, group: 'Calculators', name: 'Calculator A (JavaScript)', job: 'Apply the rule with direct arithmetic.', status: calcStatus('A') },
  { tier: 2, group: 'Calculators', name: 'Calculator B (JavaScript)', job: 'Apply the rule by a different arithmetic route.', status: calcStatus('B') },
  { tier: 2, group: 'Calculators', name: 'Calculator C (Python)', job: 'Re-read the raw files and apply the rule in high-precision decimals.', status: calcStatus('C') },
  { tier: 2, group: 'Calculators', name: 'Consensus keeper', job: 'Publish only if every calculator agrees.', status: !liveLatest ? 'info' : cons?.agreed ? 'ok' : 'fail' },
  { tier: 3, group: 'Sentinels', name: 'Brake monitor', job: 'Engage the brake after two successive readings above 3 log points.', status: { off: 'ok', released: 'ok', armed: 'warn', engaged: 'fail' }[brake.current.phase] ?? 'info' },
  { tier: 3, group: 'Sentinels', name: 'Global-dollar sentinel', job: 'Watch for an offshore dollar squeeze.', status: lvl(globalDollar.overall) },
  { tier: 3, group: 'Sentinels', name: 'Home stress sentinel', job: 'Watch financial stress, credit and Treasury yields.', status: lvl(domestic.overall) },
  { tier: 3, group: 'Sentinels', name: 'Plumbing and expectations sentinel', job: 'Watch funding strain (SOFR vs reserve rate) and long-run inflation expectations.', status: lvl(plumbing.overall) },
  { tier: 3, group: 'Sentinels', name: 'Community agents (sandboxed)', job: 'Agents written by outside contributors; advisory only; no secrets, no network.', status: !community.agents.length ? 'info' : community.agents.some((a) => a.error) ? 'warn' : 'ok' },
  { tier: 3, group: 'Sentinels', name: 'Transition backstop modeler', job: 'PROPOSAL: show what a capped, tapering dollar backstop would allow.', status: 'info' },
  { tier: 4, group: 'Auditors', name: 'Auditor', job: 'Re-check the ledger, fingerprints and every frozen reading.', status: status(audit.ok) },
  { tier: 4, group: 'Auditors', name: 'Ledger keeper', job: 'Seal each run to the one before it (hash chain).', status: status(audit.checks.find((c) => c.name === 'ledger-chain')?.status === 'ok') },
  { tier: 4, group: 'Auditors', name: 'Bitcoin witness', job: 'Anchor each ledger checkpoint in Bitcoin via OpenTimestamps (free).', status: 'ok' },
  { tier: 4, group: 'Auditors', name: 'Public attestation witness', job: 'Sign each checkpoint into Sigstore\'s public transparency log.', status: 'ok' },
  { tier: 4, group: 'Auditors', name: 'Archive witness', job: 'Ask the Internet Archive to keep an outside copy of each checkpoint.', status: 'ok' },
  { tier: 4, group: 'Auditors', name: 'Red team', job: 'Attack the swarm and publish what breaks.', status: 'planned' },
  { tier: 5, group: 'Human gates', name: 'Decision-packet clerk', job: 'Turn anything that needs a person into a packet; open a GitHub issue.', status: packets.some((p) => p.severity === 'urgent') ? 'fail' : packets.some((p) => p.severity === 'review') ? 'warn' : 'ok' },
  { tier: 6, group: 'Executors', name: 'Executor (shadow)', job: 'Write the instruction the rule authorizes; refuse anything else; execute nothing.', status: instruction.authorized ? 'ok' : 'warn' },
  { tier: 7, group: 'Reporters', name: 'Reporter (AI)', job: 'Explain the run in plain words; every number checked.', status: 'info' },
  { tier: 7, group: 'Reporters', name: 'Publisher', job: 'Publish the dashboard data and the full record.', status: 'ok' },
];

const latest = {
  schema: 1,
  title: "The People's Money — Agent Swarm Shadow Run",
  disclaimer: "Unofficial shadow run of a candidate design described in The People's Money (Jamie Murray, 2026). It is not the design's formal 18-month rehearsal, executes nothing, and publishes no national issuance figure. Inputs are public data as currently published (revised figures), not first-release vintages. Whether the rule would keep prices stable has not been tested. Not financial advice.",
  run: { date: today, started_at: startedAt, finished_at: new Date().toISOString(), mode: offline ? 'offline' : 'live', ledger_seq: ledgerEntry.seq, ledger_hash: ledgerEntry.hash },
  rule: { version: rule.design_paper_version, parameters: { feedback_strength: rule.feedback_strength, floor_pct: rule.path_growth_floor_pct, ceiling_pct: rule.path_growth_ceiling_pct, trend_years: rule.trend_growth_years, brake_trigger_lp: rule.brake_trigger_log_points, brake_release_lp: rule.brake_release_log_points }, interpretations_pending_review: rule.interpretations_pending_review },
  live: {
    epoch: rule.live_epoch_quarter,
    latest: liveLatest,
    readings: live?.history.map((h) => ({ quarter: h.quarter, computation_date: h.computation_date, available: h.available, launch_backfill: h.launch_backfill, gap_lp: h.available ? round(h.outputs.gap_lp, 3) : null, allowance_pct: h.available ? round(h.outputs.allowance_pct, 3) : null, trend_growth_pct: h.available ? round(h.outputs.trend_growth_pct, 3) : null })) ?? [],
    path_index: live?.path_index ?? [],
    brake: brake.current,
    brake_history: brake.states,
    next: live?.next ?? null,
  },
  replays,
  integrity: { sources: sourceChecks, index_agreement: indexCheck },
  sentinels: { global_dollar: globalDollar, domestic, plumbing },
  community,
  backstop_proposal: backstop,
  instruction,
  packets,
  audit,
  agents,
  sources: sensors.map((s) => ({ id: s.id, series: s.series, agency: s.agency, title: s.title, url: s.url, file: s.file, sha256: s.sha256 ?? null, last: s.last ?? null, ok: s.ok, error: s.error ?? null })),
};

// ---- Tier 7: reporter ----
latest.report = await runReporter(latest);
latest.agents.find((a) => a.name === 'Reporter (AI)').status = latest.report.source === 'ai' ? 'ok' : 'warn';

writeJSON(P('data', 'latest.json'), latest);
writeJSON(P('data', 'packets.json'), packets);
writeJSON(P('data', 'new-packets.json'), newPackets);
writeJSON(P('data', 'packets-seen.json'), [...new Set([...seen, ...newPackets.map((p) => p.id)])]);

console.log(`Run ${today} (${latest.run.mode}) sealed as ledger entry #${ledgerEntry.seq}`);
console.log(`Live: ${liveLatest ? `${liveLatest.quarter} gap ${round(liveLatest.outputs?.gap_lp, 3)} lp, allowance ${round(liveLatest.outputs?.allowance_pct, 3)}%` : 'none'}; brake ${brake.current.phase}; next ${live?.next?.quarter} on ${live?.next?.computation_date}`);
console.log(`Global dollar: ${globalDollar.overall}; domestic: ${domestic.overall}; plumbing: ${plumbing.overall}; community agents: ${community.agents.length}; packets: ${packets.length} (${newPackets.length} new); audit: ${audit.ok ? 'PASS' : 'FAIL'}; reporter: ${latest.report.source}`);
if (!audit.ok) process.exitCode = 1;
