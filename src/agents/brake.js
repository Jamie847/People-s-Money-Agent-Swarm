// BRAKE MONITOR AGENT
// The book (Ch. 7): if prices are still more than 3% above target at two successive AVAILABLE
// quarterly computations, the brake MUST engage — Stabilization Bills are offered. When prices
// come back within 1% of target, no new brake bills are sold and existing ones run off.
// A missing reading is disclosed; it is not treated as a low reading and does not reset the count.

export function runBrake(readings, rule) {
  const trigger = rule.brake_trigger_log_points;
  const release = rule.brake_release_log_points;
  const need = rule.brake_successive_readings;
  let consecutive = 0;
  let active = false;
  const states = [];
  for (const r of readings) {
    let phase;
    let note = '';
    if (r.gap_lp === null || r.gap_lp === undefined) {
      phase = active ? 'engaged' : (consecutive > 0 ? 'armed' : 'off');
      note = 'Reading unavailable — disclosed; count not reset; an active brake holds its bill target.';
    } else if (r.gap_lp > trigger) {
      consecutive += 1;
      if (active) { phase = 'engaged'; note = `Gap above ${trigger} — brake stays on and holds its bill target.`; }
      else if (consecutive >= need) { active = true; phase = 'engaged'; note = `Gap above ${trigger} at ${consecutive} successive readings — Stabilization Bills must be offered.`; }
      else { phase = 'armed'; note = `Gap above ${trigger} at ${consecutive} reading(s); the brake engages if it is still above at the next available reading.`; }
    } else {
      consecutive = 0;
      if (active && r.gap_lp <= release) { active = false; phase = 'released'; note = `Prices back within ${release} of target — no new brake bills; existing bills run off.`; }
      else if (active) { phase = 'engaged'; note = `Gap between ${release} and ${trigger} — brake stays on and holds its bill target.`; }
      else { phase = 'off'; note = 'Brake not needed.'; }
    }
    states.push({ quarter: r.quarter, gap_lp: r.gap_lp ?? null, phase, consecutive_above: consecutive, note });
  }
  return { states, current: states[states.length - 1] ?? { phase: 'off', note: 'No readings yet.' } };
}
