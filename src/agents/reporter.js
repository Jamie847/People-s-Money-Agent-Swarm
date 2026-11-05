// REPORTER AGENT (AI)
// Job: explain the run in plain language for the public. It may only restate numbers the other agents
// produced. Every number in its text is checked against the facts it was given; if any number cannot be
// matched, the AI text is rejected and a plain template is published instead (and the rejection is logged).
// The reporter cannot change any result. If no API key is configured, the template is used.

import { round } from '../lib/util.js';

export const DEFAULT_MODEL = 'claude-haiku-5-5'; // Anthropic's low-cost model; one short call per day

const fmt = (x, d = 2) => (x === null || x === undefined ? 'n/a' : Number(x).toFixed(d));

export function buildFacts(latest) {
  const live = latest.live.latest;
  const g = latest.sentinels.global_dollar;
  const d = latest.sentinels.domestic;
  return {
    run_date: latest.run.date,
    shadow_run_started_from: latest.live.epoch,
    latest_quarter: live ? live.quarter : null,
    latest_computation_date: live ? live.computation_date : null,
    trend_real_growth_pct: live?.outputs ? round(live.outputs.trend_growth_pct, 2) : null,
    price_gap_log_points: live?.outputs ? round(live.outputs.gap_lp, 2) : null,
    path_growth_allowed_pct_per_year: live?.outputs ? round(live.outputs.allowance_pct, 2) : null,
    quarterly_step_pct: live?.outputs ? round(live.outputs.quarterly_step_pct, 3) : null,
    calculators_agree: live?.consensus ? live.consensus.agreed : null,
    calculators_count: live?.calculators ? Object.keys(live.calculators).length : null,
    brake_phase: latest.live.brake.phase,
    brake_note: latest.live.brake.note,
    next_computation: latest.live.next,
    global_dollar_overall: g.overall,
    global_dollar_readings: g.readings.map((r) => ({ name: r.title, value: r.value, measure: r.metric_label, status: r.status, as_of: r.as_of })),
    domestic_overall: d.overall,
    plumbing_overall: latest.sentinels.plumbing ? latest.sentinels.plumbing.overall : null,
    domestic_readings: d.readings.map((r) => ({ name: r.title, value: r.value, measure: r.metric_label, status: r.status, as_of: r.as_of })),
    open_human_packets: latest.packets.filter((p) => p.severity !== 'info').map((p) => p.title),
    replays: latest.replays.map((r) => ({ from: r.epoch, quarters: r.summary.quarters, largest_gap_log_points: r.summary.max_gap_lp, brake_first_engaged: r.summary.first_brake_engaged })),
  };
}

export function templateReport(facts) {
  const paras = [];
  if (facts.latest_quarter) {
    const where = facts.price_gap_log_points === 0 ? 'right at its flat target (this is the starting quarter, so the gap is zero by definition)' : `${fmt(Math.abs(facts.price_gap_log_points))} log points ${facts.price_gap_log_points > 0 ? 'above' : 'below'} its flat target`;
    paras.push(`For ${facts.latest_quarter}, the rule measured prices ${where} and long-run real growth of ${fmt(facts.trend_real_growth_pct)}% a year. So it would let the path for public money grow at ${fmt(facts.path_growth_allowed_pct_per_year)}% a year. ${({ 2: 'Two', 3: 'Three', 4: 'Four' })[facts.calculators_count] || 'The'} separately written calculators ${facts.calculators_agree ? 'agreed' : 'did not agree'}.`);
  } else {
    paras.push('The live shadow run has no completed quarter yet.');
  }
  const nextLine = facts.next_computation ? ` The next computation, for ${facts.next_computation.quarter}, is due on ${facts.next_computation.computation_date}.` : '';
  paras.push(`The brake is ${facts.brake_phase}. ${facts.brake_note}${nextLine}`);
  paras.push(`Global dollar watch: ${facts.global_dollar_overall}. Home financial stress: ${facts.domestic_overall}. This is an unofficial shadow run: nothing is executed, and no dollar issuance figure is published.`);
  const headline = facts.latest_quarter
    ? `Rule allows ${fmt(facts.path_growth_allowed_pct_per_year)}% path growth for ${facts.latest_quarter}; brake ${facts.brake_phase}`
    : 'Shadow run waiting for its first completed quarter';
  return { headline, paragraphs: paras };
}

// Every number the reporter is allowed to say.
export function allowedNumbers(facts) {
  const allowed = new Set();
  const addNum = (n) => {
    if (typeof n !== 'number' || !Number.isFinite(n)) return;
    for (const v of [n, Math.abs(n)]) {
      allowed.add(String(v));
      for (let dp = 0; dp <= 3; dp++) allowed.add(Number(v.toFixed(dp)).toString());
    }
  };
  const walk = (x) => {
    if (typeof x === 'number') addNum(x);
    else if (typeof x === 'string') (x.match(/\d+(?:\.\d+)?/g) || []).forEach((s) => { allowed.add(s); allowed.add(String(Number(s))); });
    else if (Array.isArray(x)) x.forEach(walk);
    else if (x && typeof x === 'object') Object.values(x).forEach(walk);
  };
  walk(facts);
  for (let i = 0; i <= 12; i++) allowed.add(String(i)); // small counts ("three months", "two readings")
  return allowed;
}

export function verifyNumbers(text, allowed) {
  const found = (text.match(/-?\d[\d,]*(?:\.\d+)?/g) || []).map((s) => s.replace(/,/g, '').replace(/^-/, ''));
  const bad = found.filter((s) => !allowed.has(s) && !allowed.has(String(Number(s))));
  return { ok: bad.length === 0, unverified: [...new Set(bad)] };
}

// Accept the requested JSON, JSON inside a code fence, or plain text (first line = headline). Numbers are checked either way.
export function parseReport(text) {
  if (!text) return null;
  const i = text.indexOf('{'); const j = text.lastIndexOf('}');
  if (i >= 0 && j > i) {
    try {
      const o = JSON.parse(text.slice(i, j + 1));
      if (typeof o.headline === 'string' && Array.isArray(o.paragraphs) && o.paragraphs.length) return { headline: o.headline.trim(), paragraphs: o.paragraphs.map((x) => String(x).trim()).filter(Boolean) };
    } catch { /* fall through to plain text */ }
  }
  const lines = text.replace(/```[a-z]*|```/g, '').split(/\n+/).map((l) => l.replace(/^#+\s*|^\*\*|\*\*$/g, '').trim()).filter(Boolean);
  if (lines.length < 2) return null;
  return { headline: lines[0].slice(0, 140), paragraphs: lines.slice(1, 5) };
}

const SYSTEM = `You are the Reporter agent of The People's Watch, an open-source, unofficial shadow run of "The People's Money" issuance rule. Call the project "The People's Watch"; never use the word "swarm".
Write for ordinary readers: plain words, short sentences, no jargon (explain any term with a simple everyday comparison, like a thermostat).
Hard rules:
- Use ONLY the facts given. Every number you write must appear in the facts exactly (you may drop trailing zeros or round to fewer decimals). Do not compute new numbers.
- No forecasts, no investment advice, no political or partisan language, no claims that the design works — the tests of whether it stabilizes prices have not been run.
- Say plainly that this is an unofficial shadow run and nothing is executed.
- Lead the headline with this quarter's result in plain words. There are three separately written calculators; say "three" when you mention them.
Return ONLY JSON: {"headline": "<= 14 words", "paragraphs": ["2 to 4 short paragraphs"]}.`;

export async function runReporter(latest, { apiKey = process.env.ANTHROPIC_API_KEY, model = process.env.SWARM_REPORTER_MODEL || DEFAULT_MODEL, fetchImpl = globalThis.fetch } = {}) {
  const facts = buildFacts(latest);
  const template = templateReport(facts);
  if (!apiKey) return { source: 'template', reason: 'No ANTHROPIC_API_KEY configured', model: null, ...template };
  try {
    const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: 1000, thinking: { type: 'disabled' }, system: SYSTEM, messages: [{ role: 'user', content: `Facts for this run:\n${JSON.stringify(facts, null, 2)}` }] }),
    });
    if (!res.ok) throw new Error(`Anthropic API HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = await res.json();
    const text = (body.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('').trim();
    const json = parseReport(text);
    if (!json) return { source: 'template', reason: `AI reply could not be read (stop: ${body.stop_reason || 'n/a'})`, model, raw_excerpt: text.slice(0, 400), ...template };
    const check = verifyNumbers([json.headline, ...json.paragraphs].join(' '), allowedNumbers(facts));
    const words = { one: 1, two: 2, both: 2, three: 3, four: 4 };
    const countClaims = [...[json.headline, ...json.paragraphs].join(' ').matchAll(/\b(one|two|both|three|four)\s+(?:independent\s+|separate\s+|separately written\s+)?calculators?\b/gi)].map((m) => words[m[1].toLowerCase()]);
    if (facts.calculators_count && countClaims.some((c) => c !== facts.calculators_count)) {
      return { source: 'template', reason: `AI text rejected: it gives the wrong number of calculators (facts: ${facts.calculators_count})`, model, rejected_ai_text: json, ...template };
    }
    if (!check.ok) {
      return { source: 'template', reason: `AI text rejected: numbers not found in the facts (${check.unverified.join(', ')})`, model, rejected_ai_text: json, ...template };
    }
    return { source: 'ai', model, verified: true, headline: json.headline, paragraphs: json.paragraphs };
  } catch (err) {
    return { source: 'template', reason: `Reporter error: ${String(err.message || err).slice(0, 200)}`, model, ...template };
  }
}
