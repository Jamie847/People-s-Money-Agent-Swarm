// HEAD-TO-HEAD AGENT
// Job: put the rule and today's Federal Reserve side by side, using public data and audited figures only.
// What it compares: each system's stated goal, what each does with the money it controls, and what each costs.
// What it does NOT claim: outcomes. The rule's numbers are what its formula would have said given actual
// history; had the rule been in charge, the economy would have behaved differently.

const r2 = (x, d = 2) => (x == null || !isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);
const obsOf = (byId, id) => (byId[id]?.ok ? byId[id].observations : []);
const year = (d) => Number(d.slice(0, 4));

function lastInMonth(obs, ym) {
  let v = null;
  for (const o of obs) { if (o.date.slice(0, 7) === ym) v = o.value; else if (o.date.slice(0, 7) > ym) break; }
  return v;
}
function valueOnOrBefore(obs, date) {
  let v = null;
  for (const o of obs) { if (o.date <= date) v = o.value; else break; }
  return v;
}
function decValues(obs) {           // year -> December (or last available) value
  const out = {};
  for (const o of obs) out[year(o.date)] = o.value;
  return out;
}
function decGrowth(obs) {           // year -> % change December over December (fourth quarter for quarterly data)
  const quarterly = obs.slice(-8).every((o) => ['01', '04', '07', '10'].includes(o.date.slice(5, 7)));
  const endMonth = quarterly ? '10' : '12';
  const dec = {};
  for (const o of obs) { if (o.date.slice(5, 7) === endMonth) dec[year(o.date)] = o.value; }
  const out = {};
  for (const y of Object.keys(dec).map(Number)) if (dec[y - 1]) out[y] = 100 * (dec[y] / dec[y - 1] - 1);
  return out;
}

export function runHeadToHead({ byId, replays, live, cfg, aiUsage }) {
  const cpi = obsOf(byId, 'CPI');
  const pce = obsOf(byId, 'PCE');
  const base = obsOf(byId, 'BASE');
  const cur = obsOf(byId, 'CURRENCY');
  const ngdp = obsOf(byId, 'NGDP');
  const pop = obsOf(byId, 'POPULATION');
  const prod = obsOf(byId, 'PRODUCTIVITY');
  const res = obsOf(byId, 'RESERVES');
  const ioer = obsOf(byId, 'IOER');
  const iorb = obsOf(byId, 'IORB');
  const remit = obsOf(byId, 'FED_REMIT');
  if (!cpi.length || !pce.length || !base.length) return { available: false, reason: 'comparison data unavailable' };

  const target = cfg.fed_target_inflation_pct;
  const lastCpi = cpi[cpi.length - 1];
  const lastPce = pce[pce.length - 1];

  // 1. Goals and what happened to a dollar, from several starting points
  const starts = cfg.comparison_starts.map((s) => {
    const c0 = lastInMonth(cpi, s.slice(0, 7));
    const p0 = lastInMonth(pce, s.slice(0, 7));
    const yrs = (new Date(lastPce.date) - new Date(s)) / (365.25 * 864e5);
    const fedPath = (1 + target / 100) ** yrs;
    return {
      start: s,
      dollar_now_cents: r2(100 * c0 / lastCpi.value, 0),                 // what a dollar from then buys now (CPI)
      fed_target_dollar_cents: r2(100 / fedPath, 0),                    // what it would buy had prices risen exactly 2% a year
      rule_target_dollar_cents: 100,                                     // the rule's aim: a dollar keeps its value
      prices_vs_fed_target_pct: r2(100 * ((lastPce.value / p0) / fedPath - 1), 1),
      prices_vs_flat_pct: r2(100 * (lastPce.value / p0 - 1), 1),
      years: r2(yrs, 1),
    };
  });

  // 2. Price level since 2000 against each target (PCE, the Fed's own measure), yearly
  const y0 = year(cfg.comparison_starts[0]);
  const pLast = {};                   // year -> last observation in that year (December, or latest month this year)
  for (const o of pce) pLast[year(o.date)] = o;
  const p0 = lastInMonth(pce, cfg.comparison_starts[0].slice(0, 7));
  const t0 = new Date(cfg.comparison_starts[0]);
  const yrsTo = (d) => (new Date(d) - t0) / (365.25 * 864e5);
  const years = Object.keys(pLast).map(Number).filter((y) => y >= y0).sort();
  const pDec = {};
  years.forEach((y) => { pDec[y] = pLast[y].value; });
  const priceSeries = years.map((y) => ({
    year: y,
    through: pLast[y].date.slice(0, 7),
    actual: r2(100 * pDec[y] / p0, 1),
    fed_target_path: r2(100 * (1 + target / 100) ** yrsTo(pLast[y].date), 1),
    rule_target: 100,
  }));

  // 3. Money growth: the Fed's own public money (monetary base) vs the rule's formula and two classic rules
  const baseG = decGrowth(base);
  const popG = decGrowth(pop);
  const prodG = decGrowth(prod);
  const rep = (replays || []).find((r) => r.epoch === `${y0}-Q1`);
  const ruleG = {};
  if (rep) {
    const q4 = {};
    rep.rows.forEach((row) => { if (row.quarter.endsWith('Q4')) q4[Number(row.quarter.slice(0, 4))] = row.path_index; });
    let prev = 100;
    Object.keys(q4).map(Number).sort().forEach((y) => { ruleG[y] = 100 * (q4[y] / prev - 1); prev = q4[y]; });
  }
  const moneyYears = Object.keys(baseG).map(Number).filter((y) => y >= y0).sort();
  const money = moneyYears.map((y) => ({
    year: y,
    fed_base_growth_pct: r2(baseG[y], 1),
    rule_allowed_pct: ruleG[y] != null ? r2(ruleG[y], 2) : null,
    friedman_k_pct: cfg.friedman_k_pct,
    pop_plus_productivity_pct: popG[y] != null && prodG[y] != null ? r2(popG[y] + prodG[y], 2) : null,
  }));
  const avg = (arr) => { const v = arr.filter((x) => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  const sd = (arr) => { const v = arr.filter((x) => x != null); const m = avg(v); return v.length > 1 ? Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1)) : null; };
  const pick = (k) => money.map((m) => m[k]);
  const moneySummary = {
    fed: { average_pct: r2(avg(pick('fed_base_growth_pct')), 1), largest_pct: r2(Math.max(...pick('fed_base_growth_pct').filter((x) => x != null)), 1), smallest_pct: r2(Math.min(...pick('fed_base_growth_pct').filter((x) => x != null)), 1), swing_sd: r2(sd(pick('fed_base_growth_pct')), 1) },
    rule: { average_pct: r2(avg(pick('rule_allowed_pct')), 2), largest_pct: r2(Math.max(...pick('rule_allowed_pct').filter((x) => x != null)), 2), smallest_pct: r2(Math.min(...pick('rule_allowed_pct').filter((x) => x != null)), 2), swing_sd: r2(sd(pick('rule_allowed_pct')), 2) },
  };

  // 4. How far the economy ran from each target since the first start (largest gap, log points)
  const lp = (a, b) => 100 * Math.log(a / b);
  let worstFlat = 0; let worstFed = 0; let worstNgdp = 0;
  for (const y of years) {
    const g1 = lp(pDec[y], p0); const g2 = lp(pDec[y], p0 * (1 + target / 100) ** yrsTo(pLast[y].date));
    if (Math.abs(g1) > Math.abs(worstFlat)) worstFlat = g1;
    if (Math.abs(g2) > Math.abs(worstFed)) worstFed = g2;
  }
  const n0 = valueOnOrBefore(ngdp, `${y0}-03-31`);
  for (const o of ngdp) {
    if (o.date < cfg.comparison_starts[0]) continue;
    const t = (new Date(o.date) - new Date(cfg.comparison_starts[0])) / (365.25 * 864e5);
    const g = lp(o.value, n0 * (1 + cfg.ngdp_path_pct / 100) ** t);
    if (Math.abs(g) > Math.abs(worstNgdp)) worstNgdp = g;
  }
  const targets = [
    { rule: 'Flat price level (this book)', largest_gap_lp: r2(worstFlat, 1), largest_gap_pct: r2(100 * (Math.exp(worstFlat / 100) - 1), 1) },
    { rule: 'Prices rising 2% a year (the Fed’s target)', largest_gap_lp: r2(worstFed, 1), largest_gap_pct: r2(100 * (Math.exp(worstFed / 100) - 1), 1) },
    { rule: `Total spending growing ${cfg.ngdp_path_pct}% a year (a nominal-GDP path)`, largest_gap_lp: r2(worstNgdp, 1), largest_gap_pct: r2(100 * (Math.exp(worstNgdp / 100) - 1), 1) },
  ];

  // 5. Costs to the public
  // (a) interest paid to banks on reserves, estimated week by week from public data: balance x rate / 52
  const iorByYear = {};
  for (const o of res) {
    const rate = o.date >= '2021-07-29' ? valueOnOrBefore(iorb, o.date) : o.date >= '2008-10-09' ? valueOnOrBefore(ioer, o.date) : 0;
    if (rate == null) continue;
    const y = year(o.date);
    iorByYear[y] = (iorByYear[y] || 0) + (o.value / 1000) * (rate / 100) / 52;   // $ billions
  }
  // (b) the Fed's deferred asset (losses not yet recouped), weekly
  const deferred = remit.filter((o) => o.date >= '2022-01-01').map((o) => [o.date, r2(Math.max(0, -o.value) / 1000, 1)]);
  // (c) what a year's inflation took from the cash people hold
  const cpiG = decGrowth(cpi);
  const curDec = decValues(cur);
  const inflationOnCash = {};
  for (const y of Object.keys(cpiG).map(Number)) if (curDec[y - 1] && y >= y0) inflationOnCash[y] = r2(curDec[y - 1] * cpiG[y] / 100, 1);
  const lastRes = res.length ? res[res.length - 1].date : '';
  const partialYear = lastRes && lastRes.slice(5, 7) !== '12' ? year(lastRes) : null;   // leave out an unfinished year
  const costYears = Object.keys(iorByYear).map(Number).filter((y) => y >= 2008 && y !== partialYear).sort();
  const costs = costYears.map((y) => ({ year: y, interest_to_banks_estimate_b: r2(iorByYear[y], 1), inflation_on_cash_b: inflationOnCash[y] ?? null }));
  const pubYears = cfg.published.years;
  const latestPub = Object.keys(pubYears).sort().pop();

  // (d) running the rule in public: AI fees (from token counts) and free public CI
  let aiPerRun = null;
  if (aiUsage && (aiUsage.input_tokens || aiUsage.output_tokens)) {
    aiPerRun = (aiUsage.input_tokens * cfg.ai_price_per_million.input + aiUsage.output_tokens * cfg.ai_price_per_million.output) / 1e6;
  }

  const L = live?.latest?.outputs;
  return {
    available: true,
    as_of: lastPce.date,
    caveat: cfg._about,
    goals: { fed: `Its goal is prices rising ${target}% a year, measured by PCE prices (a goal it adopted in January 2012). At that pace prices double about every ${Math.round(Math.log(2) / Math.log(1 + target / 100))} years.`, rule: 'A flat price level: a dollar that buys about the same decades from now. Untested.' },
    now: {
      rule_allowed_pct: L ? r2(L.allowance_pct, 2) : null,
      rule_quarter: live?.latest?.quarter ?? null,
      rule_brake: live?.brake?.phase ?? null,
      fed_base_growth_12m_pct: r2(100 * (base[base.length - 1].value / base[base.length - 13].value - 1), 1),
      fed_base_as_of: base[base.length - 1].date,
      prices_12m_pct: r2(100 * (lastPce.value / pce[pce.length - 13].value - 1), 1),
      prices_as_of: lastPce.date,
      fed_rate_on_reserves_pct: iorb.length ? iorb[iorb.length - 1].value : null,
      deferred_asset_b: deferred.length ? deferred[deferred.length - 1][1] : null,
      deferred_as_of: deferred.length ? deferred[deferred.length - 1][0] : null,
    },
    starts,
    price_series: priceSeries,
    money,
    money_summary: moneySummary,
    targets,
    costs,
    published: { source: cfg.published.source, url: cfg.published.url, year: latestPub, ...pubYears[latestPub], previous: pubYears[String(Number(latestPub) - 1)] ?? null },
    rule_costs: {
      ai_per_run_usd: aiPerRun == null ? null : r2(aiPerRun, 4),
      ai_per_month_usd: aiPerRun == null ? null : r2(aiPerRun * cfg.runs_per_month, 2),
      ai_tokens_last_run: aiUsage || null,
      compute: 'GitHub Actions runs public projects free.',
      not_estimated: 'Running a full money authority (payments, custody, audits, staff) has not been estimated. The book lists those costs in Chapter 9: interest on Stabilization Bills when the brake is on, custody fees, the cost of the switch, possibly dearer credit, and any losses on emergency loans.',
    },
  };
}
