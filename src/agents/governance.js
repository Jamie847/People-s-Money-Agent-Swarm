// HUMAN GATE AGENT
// Job: turn anything that needs a person into a "decision packet" — what happened, what the rule says,
// who decides, and the evidence. Agents prepare; people decide. The scheduled job opens a GitHub issue
// for each new packet so humans see it.

import { sha256 } from '../lib/util.js';

const packet = (type, key, fields) => ({ id: `${type}-${sha256(`${type}|${key}`).slice(0, 10)}`, type, ...fields });

export function buildPackets({ consensusResult, liveLatest, integrity, indexCheck, brake, globalDollar, domestic, plumbing, rule, backstop, recomputes, redteam }) {
  const out = [];

  if (liveLatest && consensusResult && !consensusResult.agreed) {
    out.push(packet('CALCULATORS_DISAGREE', liveLatest.quarter, {
      severity: 'urgent',
      title: `Calculators disagree for ${liveLatest.quarter}`,
      what_happened: 'The independent calculators did not produce the same numbers, so nothing was published as the rule\'s result.',
      what_the_rule_says: 'A figure that does not match the published inputs can be caught by anyone who recomputes it (Ch. 7). Nothing moves on a disputed number.',
      who_decides: 'Money authority director; inspector general verifies inputs',
      evidence: consensusResult.disagreements,
    }));
  }

  if (liveLatest && consensusResult?.agreed && consensusResult.calculators_unavailable?.length) {
    out.push(packet('CALCULATOR_UNAVAILABLE', `${liveLatest.quarter}|${consensusResult.calculators_unavailable.map((c) => c.name).join(',')}`, {
      severity: 'review',
      title: `Reduced check for ${liveLatest.quarter}: ${consensusResult.calculators_unavailable.length} calculator(s) could not run`,
      what_happened: `The reading was published because the remaining calculators agreed, but not every calculator ran: ${consensusResult.calculators_unavailable.map((c) => `${c.name} (${c.error})`).join('; ')}.`,
      what_the_rule_says: 'Anyone can recompute each quarter\'s figure from the published inputs (Ch. 7). A missing check is disclosed, not hidden.',
      who_decides: 'The project: restore the missing calculator and re-check the reading on the record',
      evidence: consensusResult.calculators_unavailable,
    }));
  }

  if (indexCheck?.status === 'warn') {
    out.push(packet('INDEX_DISAGREEMENT', indexCheck.month, {
      severity: 'review',
      title: `Price indexes disagree by ${indexCheck.difference_pp} percentage points (${indexCheck.month})`,
      what_happened: indexCheck.detail,
      what_the_rule_says: 'The average still governs, the gap is published, and an inspector general reviews both series (Ch. 7).',
      who_decides: 'Inspector general',
      evidence: indexCheck,
    }));
  }

  for (const c of integrity.filter((x) => x.status !== 'ok')) {
    // Key on the series and its last date (not the day count), so one stale series opens one issue, not one a day.
    out.push(packet('DATA_PROBLEM', `${c.id}|${c.check}|${c.status}|${c.last ?? c.detail}`, {
      severity: c.status === 'fail' ? 'urgent' : 'review',
      title: `Data problem: ${c.id}`,
      what_happened: c.detail,
      what_the_rule_says: 'Stale inputs are disclosed; monthly payments of an allowance already fixed continue; no first issuance occurs without a verified target (Ch. 7).',
      who_decides: 'Inspector general (inputs); money authority (disclosure)',
      evidence: c,
    }));
  }

  if (brake?.current && ['armed', 'engaged'].includes(brake.current.phase)) {
    out.push(packet('BRAKE', `${brake.current.quarter}|${brake.current.phase}`, {
      severity: brake.current.phase === 'engaged' ? 'urgent' : 'review',
      title: brake.current.phase === 'engaged' ? `Brake engaged (${brake.current.quarter})` : `Brake armed (${brake.current.quarter})`,
      what_happened: brake.current.note,
      what_the_rule_says: 'The brake must engage — not may — after two successive available readings above 3 log points. The Treasury offers Stabilization Bills by public auction (Ch. 7).',
      who_decides: 'No discretion over WHETHER; Treasury (Fiscal Service) signs off the auction execution',
      evidence: brake.current,
    }));
  }

  for (const group of [globalDollar, domestic, plumbing].filter(Boolean)) {
    for (const r of group.readings.filter((x) => x.status === 'stress' || x.status === 'watch')) {
      out.push(packet('SENTINEL', `${r.id}|${r.status}|${r.as_of.slice(0, 7)}`, {
        severity: r.status === 'stress' ? 'urgent' : 'review',
        title: `Sentinel ${r.status}: ${r.title}`,
        what_happened: `${r.metric_label}: ${r.value} (watch ${r.watch}, stress ${r.stress}) as of ${r.as_of}.`,
        what_the_rule_says: 'Sentinels only report. Emergency powers need joint certification by the money authority head and the Treasury Secretary (Ch. 8).',
        who_decides: 'In the design: the money authority head and the Treasury Secretary jointly (emergency clause). In this test run: logged for public review; nothing is executed.',
        evidence: { id: r.id, value: r.value, as_of: r.as_of, note: r.note },
      }));
    }
  }

  for (const r of (recomputes || []).filter((x) => x.agrees === false)) {
    out.push(packet('INDEPENDENT_RECOMPUTE_DISAGREES', `${r.agent}|${r.quarter}`, {
      severity: 'urgent',
      title: `Independent recompute by ${r.author} disagrees for ${r.quarter}`,
      what_happened: `${r.name} reported gap ${r.gap_lp} and path growth ${r.allowance_pct}%; The People's Watch published gap ${r.swarm_gap_lp} and ${r.swarm_allowance_pct}%.`,
      what_the_rule_says: 'A figure that does not match the published inputs can be caught by anyone who recomputes it (Ch. 7).',
      who_decides: 'The project and the agent author: find which implementation is wrong, on the record',
      evidence: r,
    }));
  }
  if (redteam && redteam.attacks && redteam.attacks.some((a) => !a.caught)) {
    const missed = redteam.attacks.filter((a) => !a.caught);
    out.push(packet('RED_TEAM_FINDING', missed.map((a) => a.id).join(','), {
      severity: 'urgent',
      title: `Red team: ${missed.length} attack(s) NOT caught`,
      what_happened: missed.map((a) => `${a.id}: ${a.detail}`).join(' | '),
      what_the_rule_says: 'Controls for prevention, detection and recovery have to be attacked in a published red-team exercise (Ch. 9).',
      who_decides: 'The project: fix the control and keep the first result on the record',
      evidence: missed,
    }));
  }

  // Standing review items: things only humans can settle.
  out.push(packet('REVIEW_INTERPRETATIONS', rule.design_paper_version, {
    severity: 'info',
    title: `${rule.interpretations_pending_review.length} rule interpretations awaiting a Design Paper ruling`,
    what_happened: 'The shadow run had to choose how to implement details the book leaves open.',
    what_the_rule_says: 'The working specification is the Design Paper, which lists definitions and operating rules still to be completed (Ch. 7).',
    who_decides: 'The author, after independent review',
    evidence: rule.interpretations_pending_review,
  }));
  if (backstop) {
    out.push(packet('REVIEW_BACKSTOP_PROPOSAL', 'v1', {
      severity: 'info',
      title: 'Transition dollar backstop: proposal awaiting review',
      what_happened: 'A capped, tapering, published dollar backstop for the switch-over has been proposed but is not part of the design.',
      what_the_rule_says: 'Foreign central-bank swap lines move to the Exchange Stabilization Fund: every line published, capped and time-limited (Ch. 8).',
      who_decides: 'The author, after independent review (including offshore-dollar specialists)',
      evidence: backstop.open_questions,
    }));
  }
  return out;
}
