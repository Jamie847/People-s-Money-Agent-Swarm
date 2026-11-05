#!/usr/bin/env node
// NEWSLETTER DRAFTER — writes the monthly issue of The People's Watch from the public record.
//   node scripts/newsletter.js                 draft this month's issue (overwrites)
//   node scripts/newsletter.js --month 2026-11 draft a given month
//   node scripts/newsletter.js --auto          daily job: draft once per month, on or after the 16th
// Output: data/newsletter/<YYYY-MM>.json (title, subject, preview, html in beehiiv's format).
// Every number comes from the engine. The optional AI opener is checked number by number like the reporter.
// A person reviews and sends every issue; nothing here sends email.

import { existsSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { readJSON, writeJSON, round, quarterOfDate, quarterMonths, quarterLabel } from '../src/lib/util.js';
import { parseFredCsv } from '../src/agents/sensors.js';
import { allowedNumbers, verifyNumbers, DEFAULT_MODEL } from '../src/agents/reporter.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const P = (...p) => join(root, ...p);
const args = process.argv.slice(2);
const auto = args.includes('--auto');
const today = process.env.SWARM_TODAY || new Date().toISOString().slice(0, 10);
const month = args.includes('--month') ? args[args.indexOf('--month') + 1] : today.slice(0, 7);
const outFile = P('data', 'newsletter', `${month}.json`);

if (auto && (Number(today.slice(8, 10)) < 16 || existsSync(outFile) || month !== today.slice(0, 7))) {
  console.log(`Newsletter: nothing to do (${existsSync(outFile) ? 'draft exists' : 'before the 16th'})`);
  process.exit(0);
}

const L = readJSON(P('data', 'latest.json'));
const W = readJSON(P('data', 'witnesses.json'), { checkpoints: [] });
const R = readJSON(P('data', 'redteam.json'), null);
const C = readJSON(P('data', 'community.json'), { agents: [] });
const H = readJSON(P('data', 'live-history.json'), []);
const B = readJSON(P('newsletter', 'bank.json'));
const SITE = 'https://peoplesmoneyproject.org';
const WATCH = `${SITE}/watch.html`;

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const n = (x, d = 2) => (x === null || x === undefined || Number.isNaN(x) ? 'n/a' : Number(x).toFixed(d));
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const mIdx = Number(month.slice(5, 7));
const monthName = `${MONTHS[mIdx - 1]} ${month.slice(0, 4)}`;
const day = (iso) => { const [y, m, d] = iso.split('-').map(Number); return `${MONTHS[m - 1]} ${d}, ${y}`; };
const rot = (arr) => arr[(Number(month.slice(0, 4)) * 12 + mIdx) % arr.length];

// ---------- facts ----------
const live = L.live.latest;
const out = live?.outputs;
const quarterly = Boolean(live && live.computation_date.slice(0, 7) === month && !live.launch_backfill);
const series = (id) => { try { return parseFredCsv(readFileSync(P('data', 'inputs', `${id}.csv`), 'utf8')); } catch { return []; } };
const cpi = series('CPI'); const pce = series('PCE');
const cpiM = new Map(cpi.map((o) => [o.date, o.value])); const pceM = new Map(pce.map((o) => [o.date, o.value]));

// Running tally for the quarter in progress (not the official reading).
const epoch = H.find((h) => h.quarter === L.live.epoch && h.inputs);
let tally = null;
if (epoch) {
  const b = epoch.inputs.base;
  const avg = (xs) => xs.reduce((a, c) => a + c, 0) / xs.length;
  const lastBoth = cpi.map((o) => o.date).filter((d) => pceM.has(d)).pop();
  if (lastBoth) {
    const q = quarterOfDate(lastBoth);
    const months = quarterMonths(q).filter((m) => m <= lastBoth && cpiM.has(m) && pceM.has(m));
    if (months.length) {
      const g = (100 * Math.log(avg(months.map((m) => cpiM.get(m))) / avg(b.cpi)) + 100 * Math.log(avg(months.map((m) => pceM.get(m))) / avg(b.pce))) / 2;
      tally = { quarter: quarterLabel(q), months: months.length, through: lastBoth, gap_lp: round(g, 2) };
    }
  }
}
const cents = (from) => (cpiM.has(from) && cpi.length ? round((100 * cpiM.get(from)) / cpi[cpi.length - 1].value, 0) : null);
const dollar = { since2000: cents('2000-01-01'), since2020: cents('2020-01-01'), through: cpi.length ? cpi[cpi.length - 1].date : null };
const reading = (group, id) => L.sentinels[group]?.readings.find((r) => r.id === id);
const confirmed = W.checkpoints.filter((c) => c.bitcoin?.status === 'confirmed');
const lastBtc = confirmed.length ? confirmed[confirmed.length - 1].bitcoin.block_height : null;

// ---------- sections ----------
const sec = (inner, bg = '#F8F5EC', border = '#C9A54C') => `<div class="node-section" data-background-color="${bg}" data-border-color="${border}" data-border-style="solid" data-border-width-top="1" data-border-width-right="1" data-border-width-bottom="1" data-border-width-left="1" data-border-top-left-radius="8" data-border-top-right-radius="8" data-border-bottom-left-radius="8" data-border-bottom-right-radius="8" data-padding-top="16" data-padding-right="18" data-padding-bottom="16" data-padding-left="18">${inner}</div>`;
const button = (label, href) => `<div class="node-button"><a data-type="button" href="${href}" data-alignment="left" data-size="normal" data-custom-background-color="#13245C" data-custom-text-color="#ffffff">${esc(label)}</a></div>`;
const hr = '<div data-type="horizontalRule"><hr></div>';
const li = (t) => `<li><p>${t}</p></li>`;

const gapWords = (g) => (g === null || g === undefined ? 'unknown' : Math.abs(g) < 0.05 ? 'right at the target' : `${n(Math.abs(g))} log points (about ${n(Math.abs(g))}%) ${g > 0 ? 'above' : 'below'} the target`);
const brake = L.live.brake;
const short = [];
if (quarterly) short.push(`<strong>This quarter's official reading is in.</strong> For ${live.quarter}, prices sat ${gapWords(out.gap_lp)}, so the rule would let money grow ${n(out.allowance_pct)}% a year.`);
else if (tally) short.push(`<strong>Running tally:</strong> with ${tally.months} of 3 months in for ${tally.quarter}, prices sit ${gapWords(tally.gap_lp)}. The official reading comes on ${day(L.live.next.computation_date)}.`);
const BRAKE_WORDS = { off: 'The brake is off: prices are nowhere near high enough to need it.', armed: 'The brake is armed: prices ran hot once, and if they still do next quarter, it engages.', engaged: 'The brake is ON: the Treasury must offer savings bills to pull money out of circulation.', released: 'The brake has been released: prices are back near target, and the extra bills will simply mature.' };
short.push(`<strong>${esc((BRAKE_WORDS[brake.phase] || brake.note).split(':')[0])}:</strong>${esc((BRAKE_WORDS[brake.phase] || ': ' + brake.note).split(':').slice(1).join(':'))}`);
short.push(`<strong>The watchers:</strong> dollar trouble abroad reads <em>${esc(L.sentinels.global_dollar.overall)}</em>, home financial stress reads <em>${esc(L.sentinels.domestic.overall)}</em>${L.sentinels.plumbing ? `, and the money plumbing reads <em>${esc(L.sentinels.plumbing.overall)}</em>` : ''}.`);
if (R) short.push(`<strong>We attacked our own record ${R.attacks.length} ways.</strong> ${R.all_caught ? 'Every attack was caught.' : 'At least one got through, and it is flagged in public.'}`);

const numberSection = quarterly
  ? `<h2>The number this quarter</h2><p>Think of the rule as a thermostat for the dollar. Every quarter, on a fixed date, it reads the official price data and decides how fast the supply of public money may grow.</p><ul>${li(`<strong>Prices vs. the flat target:</strong> ${gapWords(out.gap_lp)}, measured from where prices stood when the shadow run began (${esc(L.live.epoch)}).`)}${li(`<strong>The economy's long-run growth:</strong> ${n(out.trend_growth_pct)}% a year (real GDP, ten-year average).`)}${li(`<strong>So the rule allows:</strong> ${n(out.trend_growth_pct)}% minus half the price gap = <strong>${n(out.allowance_pct)}% a year</strong>, kept between 0% and 4%.`)}${li('<strong>Checked three ways:</strong> three separately written calculators all got the same answer.')}</ul><p>${out.gap_lp > 0.05 ? 'Prices drifted above target, so the rule eases off a little, the way a thermostat clicks the heat down when the room runs warm.' : out.gap_lp < -0.05 ? 'Prices slipped below target, so the rule lets money grow a little faster, the way a thermostat clicks the heat up when the room runs cool.' : 'Prices are right where the rule wants them, so it simply follows the economy\'s long-run growth.'} Nothing is executed and no dollar amount is published; this is a public test run.</p>`
  : `<h2>The number this month</h2><p>The rule only makes its official call once a quarter, on a fixed date. In between, we keep a running tally from the monthly price reports so you can see which way things are drifting.</p>${tally ? `<ul>${li(`<strong>${esc(tally.quarter)} so far</strong> (${tally.months} of 3 months, through ${MONTHS[Number(tally.through.slice(5, 7)) - 1]}): prices are ${gapWords(tally.gap_lp)}.`)}${li(`<strong>Last official reading</strong> (${esc(live.quarter)}): the rule allowed money to grow ${n(out.allowance_pct)}% a year.`)}${li(`<strong>Next official reading:</strong> ${day(L.live.next.computation_date)}.`)}</ul><p><em>A running tally is not the official reading: it uses revised data and an incomplete quarter. It's like checking the score at halftime.</em></p>` : '<p>No running tally yet.</p>'}`;

const dollarSection = `<h2>Your dollar, then and now</h2><p>Here's what inflation has done to a dollar saved at different times, by the government's own price index (CPI-U, through ${dollar.through ? MONTHS[Number(dollar.through.slice(5, 7)) - 1] + ' ' + dollar.through.slice(0, 4) : 'latest'}):</p><ul>${li(`A dollar saved in <strong>January 2000</strong> buys about <strong>${dollar.since2000}¢</strong> of goods today.`)}${li(`A dollar saved in <strong>January 2020</strong> buys about <strong>${dollar.since2020}¢</strong>.`)}</ul><p>The book's goal is a dollar that still buys about the same when your grandchildren spend it. Whether a rule can deliver that is what this experiment is testing.</p>`;

const watchLines = [];
const sw = reading('global_dollar', 'SWAPS'); if (sw) watchLines.push(`<strong>Emergency dollar loans to foreign central banks:</strong> $${n(sw.value, 2)} billion outstanding (${esc(sw.status)}). In the 2020 panic they peaked near $449 billion.`);
const fc = reading('global_dollar', 'FOREIGN_CUSTODY'); if (fc) watchLines.push(`<strong>Treasuries held for foreign governments at the Fed:</strong> ${fc.value < 0 ? 'down' : 'up'} ${n(Math.abs(fc.value), 1)}% over 13 weeks (${esc(fc.status)}). A fast drop can mean foreign holders are raising dollars.`);
const di = reading('global_dollar', 'DOLLAR_INDEX'); if (di) watchLines.push(`<strong>The dollar against other currencies:</strong> ${di.value < 0 ? 'down' : 'up'} ${n(Math.abs(di.value), 1)}% over about a month (${esc(di.status)}). A sudden jump is the classic sign of a dollar squeeze abroad.`);
const so = reading('plumbing', 'SOFR'); if (so) watchLines.push(`<strong>Overnight borrowing costs:</strong> ${n(so.value, 2)} points above the rate the Fed pays banks (${esc(so.status)}). When this spikes, cash is getting scarce.`);
const ex = reading('plumbing', 'EXPECT_5Y5Y'); if (ex) watchLines.push(`<strong>What markets expect for inflation in the long run:</strong> ${n(ex.value, 2)}% a year (${esc(ex.status)}).`);
const st = reading('domestic', 'STRESS_STL'); if (st) watchLines.push(`<strong>Overall financial stress (St. Louis Fed index):</strong> ${n(st.value, 2)}, where 0 is normal (${esc(st.status)}).`);
const watchersSection = `<h2>What the watchers saw</h2><p>Our sentinels never act; they just keep watch around the clock, like smoke detectors. Here's what they read this month:</p><ul>${watchLines.map(li).join('')}</ul>`;

const myth = rot(B.myths);
const mythSection = sec(`<h3>Myth or fact? "${esc(myth.claim)}"</h3><p><strong>${esc(myth.verdict)}.</strong> ${esc(myth.text)}</p><p><em>Source: ${esc(myth.source)}</em></p>`);
const hist = B.history[String(mIdx)];
const historySection = `<h2>This month in money history</h2><h3>${esc(hist.title)}</h3><p>${esc(hist.text)}</p><p><em>Source: ${esc(hist.source)}</em></p>`;
const expl = rot(B.explainers);
const explainerSection = sec(`<h3>Kitchen-table explainer: ${esc(expl.title)}</h3><p>${esc(expl.text)}</p>`, '#EEF2FA', '#A9B4CF');

const comm = C.agents.filter((a) => !a.error);
const lockSection = `<h2>We tried to break it</h2><p>Before every run, a red-team agent attacks a throwaway copy of the public record: forging the ledger, editing the data, making a calculator lie, trying to escape the sandbox. ${R ? `This month: <strong>${R.attacks.filter((a) => a.caught).length} of ${R.attacks.length} attacks caught.</strong>` : ''} Every run's fingerprint is also handed to three outside witnesses we don't control: the Bitcoin blockchain, a public transparency log, and the Internet Archive.${lastBtc ? ` Our latest checkpoint is sealed in Bitcoin block ${lastBtc}.` : ''}</p>${comm.length ? `<p><strong>From the community:</strong> ${comm.map((a) => `${esc(a.name)}, by ${esc(a.author)}: ${esc(a.report.headline)}`).join(' · ')}</p>` : ''}`;

const unknownSection = sec(`<h3>What we still don't know</h3><p>${esc(B.unknowns)}</p>`, '#FFFFFF', '#DED5BF');
const act = rot(B.actions);
const actionSection = `<h2>One thing you can do</h2><p>${esc(act.text)}</p>${act.href ? button(act.label, act.href) : ''}`;
const turnSection = `<h2>Your turn</h2><p>Hit reply and tell us what confuses you about money, or what you'd want watched next. Economists and skeptics: tell us where we're wrong. Every serious objection gets a public answer.</p>${button('See the live record', WATCH)}`;
const footer = `<p><em>The People's Watch is an unofficial, public shadow run of the money rule proposed in The People's Money by Jamie Murray. It executes nothing, publishes no dollar issuance figure, and has not shown that the rule keeps prices stable; those tests are still ahead. Not financial advice. Corrections: corrections@peoplesmoneyproject.org.</em></p>`;

// ---------- optional AI opener (numbers verified) ----------
async function opener() {
  const facts = { month: monthName, quarterly, quarter: live?.quarter, gap_lp: out ? round(out.gap_lp, 2) : null, allowance_pct: out ? round(out.allowance_pct, 2) : null, trend_pct: out ? round(out.trend_growth_pct, 2) : null, tally, brake: brake.phase, global_dollar: L.sentinels.global_dollar.overall, home_stress: L.sentinels.domestic.overall, dollar_since_2000_cents: dollar.since2000, attacks: R?.attacks.length ?? null, attacks_caught: R ? R.attacks.filter((a) => a.caught).length : null, next_reading: L.live.next?.computation_date };
  const fallback = quarterly
    ? `The official reading for ${live.quarter} is in, and the short story is this: prices drifted ${out.gap_lp >= 0 ? 'a little above' : 'a little below'} the rule's target, so it eased money growth to ${n(out.allowance_pct)}% a year. Here's what that means, what the watchers saw, and one money myth worth retiring.`
    : `Welcome to this month's People's Watch. The rule's next official call is on ${day(L.live.next.computation_date)}; until then, here's the running tally, what our watchers saw, and a few things worth knowing about the money in your pocket.`;
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { text: fallback, ai: false };
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: process.env.SWARM_REPORTER_MODEL || DEFAULT_MODEL, max_tokens: 600, thinking: { type: 'disabled' }, system: 'You write the 2-3 sentence opening of a friendly monthly newsletter, The People\'s Watch, for ordinary readers. Warm, plain, a little wry, never preachy or partisan, no hype. Use ONLY numbers that appear in the facts. Never use the word "swarm". No forecasts. Return just the paragraph.', messages: [{ role: 'user', content: JSON.stringify(facts) }] }),
    });
    if (!res.ok) return { text: fallback, ai: false };
    const b = await res.json();
    const t = (b.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('').trim();
    if (!t || !verifyNumbers(t, allowedNumbers(facts)).ok || /swarm/i.test(t)) return { text: fallback, ai: false };
    return { text: t, ai: true };
  } catch { return { text: fallback, ai: false }; }
}

const op = await opener();
const html = [
  `<p>${esc(op.text)}</p>`,
  sec(`<h3>The short version</h3><ul>${short.map(li).join('')}</ul>`),
  numberSection,
  dollarSection,
  hr,
  watchersSection,
  mythSection,
  historySection,
  explainerSection,
  hr,
  lockSection,
  unknownSection,
  actionSection,
  turnSection,
  hr,
  footer,
].join('\n');

const title = quarterly ? `The People's Watch · ${monthName}: the ${live.quarter} reading` : `The People's Watch · ${monthName}`;
const subject = quarterly ? `The rule's ${live.quarter} call: ${n(out.allowance_pct)}% (and a money myth, busted)` : `${monthName}: halftime score for the dollar, plus ${hist.title.toLowerCase()}`;
const preview = quarterly ? `Prices vs. target, the brake, and what the watchers saw.` : `The running tally, your dollar then and now, and myth or fact: "${myth.claim}"`;
const issue = { month, kind: quarterly ? 'quarterly' : 'monthly', title, subtitle: 'Watching a proposed money rule run in public, every month.', subject, preview, ai_opener: op.ai, generated_at: new Date().toISOString(), ledger_seq: L.run.ledger_seq, html };
writeJSON(outFile, issue);
console.log(`Newsletter draft written: ${outFile} (${issue.kind}; AI opener: ${op.ai})`);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `drafted=${month}\n`);
