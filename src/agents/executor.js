// EXECUTOR AGENT (shadow mode)
// Job: turn an authorized, verified result into the instruction the money authority WOULD issue.
// It refuses anything the rule does not authorize. In this shadow run nothing is ever executed.

import { round } from '../lib/util.js';

export function shadowInstruction({ liveLatest, consensusResult, brake }) {
  const reasons = [];
  if (!liveLatest) reasons.push('No completed live quarter yet.');
  else {
    if (!liveLatest.complete) reasons.push(`Inputs incomplete: ${liveLatest.missing.join(', ')}.`);
    if (!consensusResult?.agreed) reasons.push('Calculators did not agree.');
  }
  if (reasons.length) {
    return {
      authorized: false,
      instruction: 'NO ACTION. The executor refuses to act without a verified target.',
      reasons,
      executed: false,
    };
  }
  const o = liveLatest.outputs;
  const brakeLine = brake.current.phase === 'engaged'
    ? 'Brake ENGAGED: the Treasury must offer Stabilization Bills by public auction; only bills actually bought withdraw money.'
    : brake.current.phase === 'armed'
      ? 'Brake ARMED: no bills yet; the brake engages if the gap is still above 3 at the next available reading.'
      : brake.current.phase === 'released'
        ? 'Brake RELEASED: no new brake bills; existing bills run off as they mature.'
        : 'Brake OFF: no Stabilization Bill offer.';
  return {
    authorized: true,
    quarter: liveLatest.quarter,
    instruction: `Raise the target path for public money by ${round(o.quarterly_step_pct, 3)}% this quarter (an annual rate of ${round(o.allowance_pct, 3)}%). Issue only enough to close any shortfall below the path, in three monthly installments; if the stock is at or above the path, issue nothing. ${brakeLine}`,
    reasons: [],
    executed: false,
    note: 'Shadow run: nothing is executed. No national dollar issuance figure is published until a reconciled model release supports one (Ch. 10).',
  };
}
