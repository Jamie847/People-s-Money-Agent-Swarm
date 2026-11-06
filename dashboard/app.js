(function () {
  var D = window.SWARM_DATA;
  // Works before and after the repository is renamed: on GitHub Pages the repo name is the first path segment.
  var REPO = (function () {
    var m = /^([a-z0-9-]+)\.github\.io$/i.exec(location.hostname);
    var seg = location.pathname.split('/')[1];
    return m && seg ? 'https://github.com/' + m[1] + '/' + seg : 'https://github.com/Jamie847/peoples-money-watch';
  })();
  var app = document.getElementById('app');
  var EMBED = /[?&]embed=1/.test(location.search);
  if (EMBED) document.documentElement.className += ' embed';
  if (!D) { app.innerHTML = '<p>No data yet.</p>'; return; }

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function n(x, d) { return x == null || isNaN(x) ? '—' : Number(x).toFixed(d == null ? 2 : d); }
  function signed(x, d) { return x == null ? '—' : (x > 0 ? '+' : '') + n(x, d); }
  function pill(status, text) { return '<span class="pill s-' + esc(status) + '"><span class="dot"></span>' + esc(text || status) + '</span>'; }
  function fmtDate(iso) {
    if (!iso) return '—';
    var d = new Date(iso + 'T12:00:00Z');
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
  }
  function daysUntil(iso) { return Math.round((new Date(iso + 'T00:00:00Z') - new Date(D.run.date + 'T00:00:00Z')) / 86400000); }

  // Architecture at a glance (static SVG).
  function archSvg() {
    var rows = [['Outside agencies', 'BLS, BEA, Federal Reserve, BIS publish the data', 'tint'], ['Tier 1 · Sensors and integrity', 'Fetch the data, fingerprint it, flag problems', ''], ['Tier 2 · Calculators A, B and C', 'Every calculator that runs must agree, or nothing is published', ''], ['SPLIT'], ['Tier 5 · Human gates', 'Packets name who decides; each opens a public issue', 'accent'], ['Tier 6 · Executor (shadow)', 'Writes only what the rule authorizes; executes nothing', ''], ['Tier 7 · Reporters', 'Plain-language report; every number checked', ''], ['The public', 'Dashboard, raw data, one-command recompute', 'tint']];
    var y = 16, out = '<svg viewBox="0 0 760 ' + (16 + rows.length * 72 + 4) + '" role="img" aria-label="How The People\'s Watch is built: data flows down seven tiers to a human gate">';
    var box = function (x, w, yy, t, s, k) {
      var fill = k === 'accent' ? '#e8ecf8' : k === 'tint' ? '#f3f1ea' : '#fff', stroke = k === 'accent' ? '#13235b' : '#c9cedb';
      return '<rect x="' + x + '" y="' + yy + '" width="' + w + '" height="52" rx="8" fill="' + fill + '" stroke="' + stroke + '" stroke-width="' + (k === 'accent' ? 2 : 1) + '"/><text x="' + (x + w / 2) + '" y="' + (yy + 22) + '" text-anchor="middle" font-size="14" font-weight="600" fill="#13235b">' + esc(t) + '</text><text x="' + (x + w / 2) + '" y="' + (yy + 40) + '" text-anchor="middle" font-size="12" fill="#5a6072">' + esc(s) + '</text>';
    };
    var arrow = function (x, y1, y2) { return '<line x1="' + x + '" y1="' + y1 + '" x2="' + x + '" y2="' + (y2 - 4) + '" stroke="#9aa1b3" stroke-width="1.4"/><path d="M' + (x - 4) + ' ' + (y2 - 8) + 'L' + x + ' ' + (y2 - 2) + 'L' + (x + 4) + ' ' + (y2 - 8) + '" fill="none" stroke="#9aa1b3" stroke-width="1.4"/>'; };
    rows.forEach(function (r, i) {
      if (r[0] === 'SPLIT') {
        out += box(100, 270, y, 'Tier 3 · Sentinels', 'Brake, dollar, stress, community agents', '') + box(390, 270, y, 'Tier 4 · Auditors and witnesses', 'Ledger, Bitcoin, Sigstore, Archive', '');
        out += arrow(235, y + 52, y + 72) + arrow(525, y + 52, y + 72);
      } else {
        out += box(100, 560, y, r[0], r[1], r[2]);
        if (i < rows.length - 1) { if (rows[i + 1][0] === 'SPLIT') out += arrow(235, y + 52, y + 72) + arrow(525, y + 52, y + 72); else out += arrow(380, y + 52, y + 72); }
      }
      y += 72;
    });
    return out + '</svg>';
  }

  // Tiny dependency-free SVG line chart.
  function lineChart(series, opts) {
    opts = opts || {};
    var W = 760, H = opts.height || 220, L = opts.noAxis ? 4 : 44, R = opts.noAxis ? 4 : 12, T = opts.noAxis ? 4 : 12, B = opts.noAxis ? 4 : 28;
    var all = [];
    series.forEach(function (s) { s.points.forEach(function (p) { if (p[1] != null) all.push(p[1]); }); });
    (opts.bands || []).forEach(function (b) { all.push(b.y); });
    var min = opts.min != null ? opts.min : Math.min.apply(null, all);
    var max = opts.max != null ? opts.max : Math.max.apply(null, all);
    if (min === max) { min -= 1; max += 1; }
    var step = null;
    if (opts.max == null) {
      var raw = (max - min) / 4, mag = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / mag;
      step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * mag;
      if (opts.min == null) min = Math.floor(min / step) * step;
      max = Math.ceil(max / step) * step;
      if (max === min) max = min + step;
    }
    var count = series[0].points.length;
    var x = function (i) { return L + (count <= 1 ? 0 : (i * (W - L - R)) / (count - 1)); };
    var y = function (v) { return T + (H - T - B) * (1 - (v - min) / (max - min)); };
    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(opts.label || 'chart') + '">';
    var ticks = [];
    if (step) { for (var tv = min; tv <= max + step / 1000; tv += step) ticks.push(tv); }
    else { for (var k = 0; k <= 4; k++) ticks.push(min + ((max - min) * k) / 4); }
    for (var ti = 0; ti < ticks.length && !opts.noAxis; ti++) {
      var v = ticks[ti]; var yy = y(v);
      svg += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + yy + '" y2="' + yy + '" stroke="#eceef4"/>';
      svg += '<text x="' + (L - 6) + '" y="' + (yy + 4) + '" font-size="11" text-anchor="end" fill="#7a8193">' + n(v, opts.yDigits == null ? 1 : opts.yDigits) + '</text>';
    }
    (opts.shade || []).forEach(function (i) { svg += '<rect x="' + (x(i) - (W - L - R) / Math.max(1, count - 1) / 2) + '" y="' + T + '" width="' + ((W - L - R) / Math.max(1, count - 1)) + '" height="' + (H - T - B) + '" fill="#b22234" opacity=".07"/>'; });
    (opts.bands || []).forEach(function (b) { svg += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y(b.y) + '" y2="' + y(b.y) + '" stroke="' + b.color + '" stroke-dasharray="5 4"/>'; if (b.label) svg += '<text x="' + (b.anchor === 'start' ? L + 6 : W - R) + '" y="' + (y(b.y) + (b.below ? 14 : -4)) + '" font-size="11" text-anchor="' + (b.anchor || 'end') + '" fill="' + b.color + '">' + esc(b.label) + '</text>'; });
    series.forEach(function (s) {
      var d = ''; s.points.forEach(function (p, i) { if (p[1] == null) return; d += (d ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(p[1]).toFixed(1); });
      svg += '<path d="' + d + '" fill="none" stroke="' + s.color + '" stroke-width="' + (s.width || 2.2) + '"/>';
    });
    var labels = opts.xLabels || [];
    labels.forEach(function (lab) { svg += '<text x="' + x(lab.i) + '" y="' + (H - 8) + '" font-size="11" text-anchor="middle" fill="#7a8193">' + esc(lab.text) + '</text>'; });
    return svg + '</svg>';
  }

  function spark(history, color) {
    if (!history || history.length < 2) return '';
    var vals = history.map(function (h) { return h[1]; });
    return lineChart([{ points: history, color: color || '#1d3278', width: 1.6 }], { height: 70, label: 'trend', noAxis: true, min: Math.min.apply(null, vals), max: Math.max.apply(null, vals) }).replace('viewBox="0 0 760 70"', 'viewBox="0 0 760 70" preserveAspectRatio="none" style="height:56px"');
  }

  var live = D.live || {};
  var latest = live.latest;
  var out = latest && latest.outputs;
  var brake = live.brake || {};
  var next = live.next;
  var brakeStatus = { off: 'ok', released: 'ok', armed: 'warn', engaged: 'fail' }[brake.phase] || 'info';
  var gd = D.sentinels.global_dollar, dm = D.sentinels.domestic, pl = D.sentinels.plumbing;

  document.getElementById('notice').innerHTML = '<strong>Unofficial shadow run.</strong> ' + esc(D.disclaimer);

  var h = '';

  // ---- Headline numbers ----
  h += '<section><h2>This quarter, by the rule</h2><p class="sub">The shadow run started from prices in ' + esc(live.epoch) + '. Each quarter, on a fixed date, the rule reads the published data and sets how fast the target path for public money may grow. Last updated ' + fmtDate(D.run.date) + '.</p>';
  h += '<div class="grid g4">';
  h += '<div class="card kpi"><div class="label">Price gap from the flat target</div><div class="value">' + (out ? signed(out.gap_lp, 2) : '—') + '</div><div class="hint">log points (≈ percent), ' + esc(latest ? latest.quarter : '') + '</div></div>';
  h += '<div class="card kpi"><div class="label">Path growth the rule allows</div><div class="value">' + (out ? n(out.allowance_pct, 2) + '%' : '—') + '</div><div class="hint">a year · trend growth ' + (out ? n(out.trend_growth_pct, 2) + '%' : '—') + ' − ½ × gap, kept within 0–4%</div></div>';
  h += '<div class="card kpi"><div class="label">The brake</div><div class="value" style="font-size:24px">' + pill(brakeStatus, brake.phase || 'off') + '</div><div class="hint">' + esc(brake.note || '') + '</div></div>';
  h += '<div class="card kpi"><div class="label">Next computation</div><div class="value" style="font-size:24px">' + (next ? fmtDate(next.computation_date) : '—') + '</div><div class="hint">' + (next ? esc(next.quarter) + ' · ' + (daysUntil(next.computation_date) >= 0 ? 'in ' + daysUntil(next.computation_date) + ' days' : 'due') + ' · data published: CPI ' + next.months_published.CPI.length + '/3, PCE ' + next.months_published.PCE.length + '/3' : '') + '</div></div>';
  h += '</div>';
  if (latest && latest.launch_backfill) h += '<p class="caveat">The ' + esc(latest.quarter) + ' reading is the starting point (gap zero by definition). It was computed when the shadow run launched; every later quarter is computed on its own date and then frozen.</p>';
  h += '</section>';

  // ---- Plain-language report ----
  var rep = D.report || {};
  h += '<section><div class="card report"><p class="eyebrow" style="color:#8a6d0f">Plain-language report · ' + (rep.source === 'ai' ? 'written by the AI reporter, every number checked against the engine' : 'standard template') + '</p><h3>' + esc(rep.headline) + '</h3>';
  (rep.paragraphs || []).forEach(function (p) { h += '<p>' + esc(p) + '</p>'; });
  if (rep.source !== 'ai' && rep.reason) h += '<p class="meta">' + (/rejected/i.test(rep.reason) ? 'The AI reporter\'s text was rejected because it contained a number the engine did not produce, so the standard template is shown.' : 'The AI reporter is not running right now, so the standard template is shown.') + '</p>';
  h += '</div></section>';

  // ---- The calculation ----
  // ---- Side by side: the rule and today's Fed ----
  var HH = D.head_to_head;
  if (HH && HH.available) {
    var nw = HH.now, pub = HH.published, rc = HH.rule_costs, s20 = (HH.starts || []).filter(function (s) { return s.start.slice(0, 4) === '2020'; })[0], s00 = HH.starts[0];
    var fedMoney = HH.money.map(function (m) { return m.fed_base_growth_pct; }).filter(function (x) { return x != null; });
    var lastCost = HH.costs.filter(function (c) { return c.inflation_on_cash_b != null; }).slice(-1)[0];
    h += '<section id="side-by-side"><h2>Side by side: the rule and today’s Fed</h2><p class="sub">Two ways to run a currency, on the same public data. The left column is what the book’s rule would say and what it costs to run it in public. The right column is what the Federal Reserve is doing and what it costs, from its own audited statements.</p>';
    h += '<div class="grid g2 h2h">';
    h += '<div class="card h2h-rule"><div class="h2h-tag">The rule</div><div class="h2h-q">What it would do</div>';
    h += '<div class="h2h-big">' + n(nw.rule_allowed_pct, 2) + '%<span> a year</span></div><p>Public money may grow ' + n(nw.rule_allowed_pct, 2) + '% a year (' + esc(nw.rule_quarter) + ' reading), brake ' + esc(nw.rule_brake || 'off') + '. Its goal: prices that stay flat, so a dollar keeps its value. Whatever happens, its money growth stays between 0% and 4% a year, by a formula published in advance.</p>';
    h += '<div class="h2h-q">What it costs to run in public</div><div class="h2h-big">' + (rc.ai_per_month_usd != null ? '$' + n(rc.ai_per_month_usd, 2) : 'pennies') + '<span> a month</span></div><p>AI fees for the plain-English report' + (rc.ai_per_run_usd != null ? ' ($' + n(rc.ai_per_run_usd, 4) + ' a run)' : '') + '. ' + esc(rc.compute) + ' This is the cost of computing and publishing the rule, not of running a money authority: ' + esc(rc.not_estimated) + '</p></div>';
    h += '<div class="card h2h-fed"><div class="h2h-tag">Today’s Fed</div><div class="h2h-q">What it is doing</div>';
    h += '<div class="h2h-big">' + n(nw.prices_12m_pct, 1) + '%<span> price rise (PCE), past 12 months</span></div><p>' + esc(HH.goals.fed) + (s20 ? ' Since January 2020 prices have risen ' + n(s20.prices_vs_flat_pct, 1) + '%, which is ' + n(s20.prices_vs_fed_target_pct, 1) + '% above even its own 2% path.' : '') + ' Its own public money (the monetary base) has grown as much as ' + n(Math.max.apply(null, fedMoney), 0) + '% and shrunk as much as ' + n(-Math.min.apply(null, fedMoney), 0) + '% in a single year since ' + HH.money[0].year + '. It now pays banks ' + n(nw.fed_rate_on_reserves_pct, 2) + '% on their reserves.</p>';
    h += '<div class="h2h-q">What it costs (' + esc(pub.year) + ', audited)</div><div class="h2h-big">$' + n(pub.interest_paid_deposits + pub.interest_paid_reverse_repo + pub.operating_expenses + pub.dividends, 0) + 'B<span> paid out, against $' + n(pub.interest_income, 0) + 'B earned</span></div><ul class="h2h-list">';
    h += '<li>$' + n(pub.interest_paid_deposits, 1) + 'B interest to banks and others on their deposits at the Fed</li><li>$' + n(pub.interest_paid_reverse_repo, 1) + 'B interest on reverse repos (mostly money-market funds)</li><li>$' + n(pub.operating_expenses, 1) + 'B to run the system, including $' + n(pub.board_and_currency, 1) + 'B for the Board and printing currency</li><li>$' + n(pub.dividends, 1) + 'B in dividends to member banks</li>';
    h += '<li>The year ended in a $' + n(pub.net_loss, 1) + 'B loss. Losses not yet earned back stand at $' + n(nw.deferred_asset_b, 1) + 'B (as of ' + esc(fmtDate(nw.deferred_as_of)) + '); Reserve Banks still carrying losses send nothing to the Treasury until they are recovered</li>';
    if (lastCost) h += '<li>Separately, inflation cut the buying power of the cash people hold by about $' + n(lastCost.inflation_on_cash_b, 0) + 'B in ' + lastCost.year + '</li>';
    h += '</ul><p class="meta">The Fed also earned $' + n(pub.interest_income, 1) + 'B in interest in ' + esc(pub.year) + '. Until 2022 it earned more than it paid out and sent its profits to the Treasury. Source: <a href="' + esc(pub.url) + '">' + esc(pub.source) + '</a>.</p></div>';
    h += '</div>';
    // chart 1: prices since 2000 vs each goal
    var ps = HH.price_series;
    var lab1 = []; ps.forEach(function (p, i) { if (p.year % 5 === 0) lab1.push({ i: i, text: String(p.year) }); });
    h += '<div class="card chart"><div class="h2h-ct">Prices since January ' + ps[0].year + ' (PCE, ' + ps[0].year + ' = 100): what happened, the Fed’s goal and the rule’s goal</div>' + lineChart([
      { points: ps.map(function (p) { return [p.year, p.actual]; }), color: '#b22234' },
      { points: ps.map(function (p) { return [p.year, p.fed_target_path]; }), color: '#7a8193', width: 1.6 },
      { points: ps.map(function (p) { return [p.year, p.rule_target]; }), color: '#c9a227' }], { label: 'prices versus goals', height: 200, xLabels: lab1, yDigits: 0 });
    h += '<div class="legend"><span><i style="background:#b22234"></i>actual prices</span><span><i style="background:#7a8193"></i>Fed goal: +2% a year</span><span><i style="background:#c9a227"></i>rule goal: flat</span></div>';
    h += '<p class="meta">A dollar from January ' + s00.start.slice(0, 4) + ' buys about ' + s00.dollar_now_cents + '¢ today. Had prices risen exactly 2% a year, it would buy ' + s00.fed_target_dollar_cents + '¢. The rule aims for 100¢.</p></div>';
    // chart 2: money growth
    var mm = HH.money; var lab2 = []; mm.forEach(function (m, i) { if (m.year % 5 === 0) lab2.push({ i: i, text: String(m.year) }); });
    var rp20 = (D.replays || []).filter(function (r) { return r.epoch === '2020-Q1'; })[0];
    var r20 = {}; if (rp20) { var prev = 100; rp20.rows.forEach(function (r) { if (r.quarter.slice(-2) === 'Q4') { r20[r.quarter.slice(0, 4)] = 100 * (r.path_index / prev - 1); prev = r.path_index; } }); }
    h += '<div class="card chart"><div class="h2h-ct">Growth of public money each year: the Fed’s monetary base versus the rule’s 0–4% band</div>' + lineChart([
      { points: mm.map(function (m) { return [m.year, m.fed_base_growth_pct]; }), color: '#b22234' },
      { points: mm.map(function (m) { return [m.year, r20[m.year] != null ? r20[m.year] : null]; }), color: '#c9a227', width: 3 },
      { points: mm.map(function (m) { return [m.year, m.pop_plus_productivity_pct]; }), color: '#2e7d32', width: 1.4 }], { label: 'money growth', height: 200, xLabels: lab2, yDigits: 0, bands: [{ y: 4, label: 'rule ceiling 4%', color: '#c9a227' }, { y: 0, label: 'rule floor 0%', color: '#c9a227', below: true }] });
    h += '<div class="legend"><span><i style="background:#b22234"></i>Fed: monetary base, % change in the year</span><span><i style="background:#c9a227"></i>rule’s formula, started in 2020</span><span><i style="background:#2e7d32"></i>population + productivity growth</span></div>';
    h += '<p class="meta">Friedman’s fixed rule would be ' + HH.money[0].friedman_k_pct + '% every year. The rule’s line is what its formula would have said given the prices that actually happened under the Fed; it is not what prices would have done under the rule.</p></div>';
    // chart 3: costs over time
    var cc = HH.costs; var lab3 = []; cc.forEach(function (c, i) { if (c.year % 4 === 0) lab3.push({ i: i, text: String(c.year) }); });
    h += '<div class="card chart"><div class="h2h-ct">Two costs of today’s system, $ billions a year</div>' + lineChart([
      { points: cc.map(function (c) { return [c.year, c.interest_to_banks_estimate_b]; }), color: '#13235b' },
      { points: cc.map(function (c) { return [c.year, c.inflation_on_cash_b]; }), color: '#b22234' }], { label: 'costs', height: 180, xLabels: lab3, yDigits: 0, min: 0 });
    h += '<div class="legend"><span><i style="background:#13235b"></i>interest the Fed pays banks on reserves (estimated weekly from public data; audited totals above)</span><span><i style="background:#b22234"></i>buying power inflation took from cash in circulation</span></div></div>';
    // other rules
    h += '<div class="card"><div class="h2h-ct">How far the economy ran from each goal since ' + HH.money[0].year + ' (largest gap)</div><table><thead><tr><th>Goal</th><th class="num">Largest gap from the goal</th></tr></thead><tbody>';
    HH.targets.forEach(function (t) { h += '<tr><td>' + esc(t.rule) + '</td><td class="num">' + (t.largest_gap_pct > 0 ? '+' : '') + n(t.largest_gap_pct, 1) + '%</td></tr>'; });
    h += '</tbody></table><p class="meta">Each row measures actual history against a different goal. Prices ran far above a flat level because the Fed aims for 2% a year, not zero.</p></div>';
    h += '<p class="caveat"><strong>What this does and does not show.</strong> ' + esc(HH.caveat) + ' Whether the rule would keep prices steady, keep credit affordable or survive the switch has not been tested; those tests are in Chapter 9 of the book.</p></section>';
  }

  h += '<section><h2>Three calculators, one answer</h2><p class="sub">Nothing is published unless the calculators agree: two in JavaScript using different arithmetic, and one in Python that re-reads the raw files on its own. If one cannot run, the reading needs the other two to agree and the gap is flagged for a person. All three are written from the same specification, so they catch coding mistakes, not mistakes in the specification itself; a slot is open for an outside economist to add a calculator written from the book alone. Anyone can run the Python one.</p>';
  if (latest && latest.calculators) {
    var keys = [['trend_growth_pct', 'Trend real growth, % a year', 4], ['gap_cpi_lp', 'CPI-U gap, log points', 4], ['gap_pce_lp', 'PCE gap, log points', 4], ['gap_lp', 'Price gap (average)', 4], ['allowance_raw_pct', 'Path growth before limits, %', 4], ['allowance_pct', 'Path growth allowed, %', 4], ['quarterly_step_pct', 'Quarterly step, %', 5]];
    h += '<div class="card"><table><thead><tr><th>' + esc(latest.quarter) + '</th><th>Calculator A</th><th>Calculator B</th><th>Calculator C (Python)</th></tr></thead><tbody>';
    keys.forEach(function (k) {
      h += '<tr><td>' + k[1] + '</td>';
      ['A', 'B', 'C'].forEach(function (c) { var r = latest.calculators[c]; h += '<td class="num">' + (r && !r.error ? n(r[k[0]], k[2]) : esc(r && r.error ? 'unavailable' : '—')) + '</td>'; });
      h += '</tr>';
    });
    h += '</tbody></table><p style="margin:12px 0 0">' + (latest.consensus.agreed ? pill('ok', 'calculators agree') : pill('fail', 'calculators disagree — nothing published')) + ' <span class="meta">tolerance ' + latest.consensus.tolerance + ' · inputs: ' + esc(latest.inputs.current_months[0].slice(0, 7)) + ' to ' + esc(latest.inputs.current_months[2].slice(0, 7)) + ' vs ' + esc(latest.inputs.base_months[0].slice(0, 7)) + ' to ' + esc(latest.inputs.base_months[2].slice(0, 7)) + '; real GDP ' + latest.inputs.gdp_years[0] + '–' + latest.inputs.gdp_years[latest.inputs.gdp_years.length - 1] + '</span></p></div>';
  }
  if (latest && latest.data_vintage) h += '<p class="meta" style="margin:10px 0 0">Data used: ' + (latest.data_vintage.as_published_on ? 'figures exactly as published on ' + esc(latest.data_vintage.as_published_on) + ' (ALFRED archive), so later revisions never change this reading' : esc(latest.data_vintage.note || '')) + ' · starting prices: ' + esc(latest.base_source || '') + '.</p>';
  var rc = D.recomputes || [];
  h += '<div class="card" style="margin-top:14px"><p style="margin:0"><strong>Independent recomputes by outside authors</strong> <span class="meta">(Calculator D and beyond)</span></p>';
  if (!rc.length) h += '<p class="meta" style="margin:6px 0 0">None yet. Anyone can submit one as a community agent that reports its own answer; the Watch compares it to the published number and raises a public flag on any disagreement.</p>';
  else rc.forEach(function (r) { h += '<p style="margin:6px 0 0">' + pill(r.agrees === false ? 'fail' : r.agrees ? 'ok' : 'info', r.agrees === false ? 'disagrees' : r.agrees ? 'agrees' : 'no matching quarter') + ' ' + esc(r.name) + ' by ' + esc(r.author) + ' · ' + esc(r.quarter) + ': gap ' + esc(r.gap_lp) + ', path growth ' + esc(r.allowance_pct) + '%</p>'; });
  h += '</div>';
  h += '<div class="card instruction" style="margin-top:14px"><p class="eyebrow" style="color:#8a6d0f">What the executor would instruct · nothing is executed</p><p style="margin:0">' + esc(D.instruction.instruction) + '</p>' + (D.instruction.note ? '<p class="meta" style="margin:6px 0 0">' + esc(D.instruction.note) + '</p>' : '') + '</div>';
  h += '</section>';

  // ---- Agent roster ----
  var tiers = {};
  D.agents.forEach(function (a) { (tiers[a.tier] = tiers[a.tier] || { group: a.group, list: [] }).list.push(a); });
  var tierNames = { 1: 'Sensors and integrity: fetch, fingerprint, check', 2: 'Calculators: apply the rule', 3: 'Sentinels and community agents: watch, never act', 4: 'Auditors and witnesses: check the system itself', 5: 'Human gates: people decide', 6: 'Executors: act only on what is authorized', 7: 'Reporters: tell the public' };
  h += '<section><h2>Meet the agents</h2><p class="sub">Every agent has one job. Data flows down the tiers; anything that needs judgment stops at a human gate. Outside witnesses keep a copy of the record nobody here controls.</p>';
  h += '<div class="card chart" style="margin-bottom:16px">' + archSvg() + '</div>';
  Object.keys(tiers).sort().forEach(function (t) {
    h += '<div class="tier"><div class="tier-head"><span class="n">Tier ' + t + '</span><span class="t">' + esc(tierNames[t]) + '</span></div><div class="agents">';
    tiers[t].list.forEach(function (a) { h += '<div class="agent"><div class="name"><span class="s-' + esc(a.status) + '" style="border:0"><span class="dot"' + (a.status === 'planned' ? ' style="background:transparent;border:1.5px dashed currentColor"' : '') + '></span></span>' + esc(a.name) + '</div><div class="job">' + esc(a.job) + '</div></div>'; });
    h += '</div></div>';
  });
  h += '<div class="legend"><span>' + pill('ok', 'ok') + '</span><span>' + pill('warn', 'needs a look') + '</span><span>' + pill('fail', 'problem') + '</span><span>' + pill('info', 'info') + '</span><span>' + pill('planned', 'planned') + '</span></div></section>';

  // ---- Global dollar watch ----
  function watchCards(group) {
    var s = '<div class="grid g3">';
    group.readings.forEach(function (r) {
      if (r.status === 'unavailable') { s += '<div class="card watch-card"><div class="title">' + esc(r.id) + '</div><p class="meta">Unavailable: ' + esc(r.detail) + '</p></div>'; return; }
      var color = { calm: '#2e7d32', watch: '#b7791f', stress: '#b22234' }[r.status] || '#1d3278';
      s += '<div class="card watch-card"><div class="row"><div class="title">' + esc(r.title) + '</div>' + pill(r.status) + '</div>';
      s += '<div class="val">' + n(r.value, 2) + '</div><div class="meta">' + esc(r.metric_label) + ' · as of ' + esc(r.as_of) + (r.watch != null ? ' · watch ' + r.watch + ', stress ' + r.stress : '') + '</div>';
      var cal = r.calibration ? '<p class="meta" style="margin:4px 0 0"><strong>How often these levels were reached</strong> (since ' + esc(r.calibration.since.slice(0, 4)) + ', ' + r.calibration.readings + ' readings): watch or worse ' + n(r.calibration.watch_rate_pct, 1) + '%, stress ' + n(r.calibration.stress_rate_pct, 1) + '%' + (r.calibration.stress_periods.length ? ' (stress in ' + esc(r.calibration.stress_periods.join(', ')) + ')' : '') + '.</p>' : '';
      s += '<div class="chart">' + spark(r.history, color) + '</div><p class="meta" style="margin:4px 0 0">' + esc(r.note) + ' Source: ' + esc(r.agency) + '.</p>' + cal + '</div>';
    });
    return s + '</div>';
  }
  h += '<section><h2>Global dollar watch ' + pill(gd.overall) + '</h2><p class="sub">Trillions of dollars are borrowed and lent outside the United States (the "Eurodollar" system). A dollar squeeze abroad can push foreign holders to sell Treasuries to raise dollars. These sentinels watch for it. Their watch levels are provisional, set for this test run, open to review, and not part of the book\'s rule. Most of these indicators describe today\'s Federal Reserve system; they show conditions the switch-over would start from.</p>' + watchCards(gd) + '</section>';
  h += '<section><h2>Home financial stress ' + pill(dm.overall) + '</h2><p class="sub">Stand-ins for the design\'s payment-stress index (not yet specified), plus bank credit and the 10-year Treasury yield, for context. Watch levels are provisional.</p>' + watchCards(dm) + '</section>';
  if (pl) h += '<section><h2>Plumbing and expectations ' + pill(pl.overall) + '</h2><p class="sub">The pipes money flows through (overnight funding, bank reserves, the Treasury\'s cash) and what markets and households expect prices to do. A funding squeeze or slipping expectations are early signs of trouble. Watch levels are provisional; each card shows how often its levels were reached in the past.</p>' + watchCards(pl) + '</section>';

  // ---- Transition backstop proposal ----
  var bp = D.backstop_proposal;
  if (bp && bp.available) {
    h += '<section><h2>Transition dollar backstop <span class="pill s-warn">proposal</span></h2><p class="sub">Not part of the design yet. The idea: while the country switches systems, keep a published, capped, tapering dollar backstop for foreign central banks, so an offshore squeeze cannot force a fire sale of Treasuries before the new system is steady. It works like a step-down plan: it shrinks on a schedule and pauses while the global-dollar watch says stress. Two cautions: it would create dollars outside the rule, and whether the Exchange Stabilization Fund could fund a cap this size is an open question. Every number here is a placeholder awaiting independent review.</p>';
    h += '<div class="card proposal"><div class="grid g3">';
    h += '<div class="kpi"><div class="label">Cap if the switch happened today</div><div class="value">$' + n(bp.cap_billions, 0) + 'B</div><div class="hint">20% of foreign official Treasury custody holdings (placeholder)</div></div>';
    h += '<div class="kpi"><div class="label">Current usage (swap lines + foreign repo)</div><div class="value">$' + n(bp.usage_billions, 2) + 'B</div><div class="hint">' + n(bp.utilization_pct, 2) + '% of the cap · as of ' + esc(bp.as_of) + '</div></div>';
    h += '<div class="kpi"><div class="label">Taper</div><div class="value" style="font-size:22px">' + (bp.taper_would_pause ? pill('warn', 'would pause') : pill('ok', 'on schedule')) + '</div><div class="hint">' + bp.taper_years + '-year step-down; hard sunset at ' + bp.sunset_years + ' years unless a ' + esc(bp.extension_requires) + '</div></div>';
    h += '</div><div style="margin-top:16px"><div class="meta" style="margin-bottom:6px">For scale ($ billions)</div>';
    [['2008 swap-line peak', 583, '#7a8193'], ['2020 swap-line peak', 449, '#7a8193'], ['Proposed cap (placeholder)', bp.cap_billions, '#c9a227'], ['Usage today', bp.usage_billions, '#1d3278']].forEach(function (b) {
      h += '<div style="display:grid;grid-template-columns:minmax(100px,190px) 1fr 56px;gap:10px;align-items:center;font-size:13px;margin:4px 0"><span>' + esc(b[0]) + '</span><div class="bar"><span style="width:' + Math.max(0.4, Math.min(100, (b[1] / 650) * 100)) + '%;background:' + b[2] + '"></span></div><span class="mono">' + n(b[1], b[1] < 10 ? 2 : 0) + '</span></div>';
    });
    h += '</div>';
    h += '<p style="margin:14px 0 4px"><strong>Never:</strong> ' + esc(bp.never.join('; ')) + '.</p><p style="margin:0 0 4px"><strong>Open questions for reviewers:</strong></p><ul style="margin:0">';
    bp.open_questions.forEach(function (q) { h += '<li>' + esc(q) + '</li>'; });
    h += '</ul></div></section>';
  }

  // ---- Replay ----
  (D.replays || []).forEach(function (rp) {
    var rows = rp.rows;
    var shade = []; rows.forEach(function (r, i) { if (r.brake === 'engaged') shade.push(i); });
    var every = rows.length > 48 ? 5 : rows.length > 24 ? 2 : 1;
    var labels = []; rows.forEach(function (r, i) { if (r.quarter.slice(5) === 'Q1' && +r.quarter.slice(0, 4) % every === 0) labels.push({ i: i, text: r.quarter.slice(0, 4) }); });
    h += '<section><h2>' + esc(rp.label) + '</h2><p class="sub">The rule’s flat target set in ' + esc(rp.epoch) + ', fed the prices that actually happened under the Fed. The dark line is how far those prices sat from the flat target; shaded quarters are when the rule’s brake would have been on; the gold line is the money growth its formula would have allowed. First brake: <strong>' + esc(rp.summary.first_brake_engaged || 'never') + '</strong>. Largest gap: <strong>' + n(rp.summary.max_gap_lp, 1) + ' log points</strong>. These prices came from a central bank aiming for 2% a year, so they show how far apart the two goals are, not what prices would have done under the rule.</p>';
    h += '<div class="card chart">' + lineChart([{ points: rows.map(function (r) { return [r.quarter, r.gap_lp]; }), color: '#13235b' }], { label: 'price gap replay', bands: [{ y: 3, label: 'brake trigger (3)', color: '#b22234' }, { y: 1, label: 'release (1)', color: '#2e7d32', anchor: 'start', below: false }, { y: 0, label: 'target (0)', color: '#7a8193', below: true }], shade: shade, xLabels: labels });
    h += '<div class="legend"><span><i style="background:#13235b"></i>price gap, log points</span><span><i style="background:#b22234;opacity:.3;height:10px"></i>brake engaged</span></div>';
    h += lineChart([{ points: rows.map(function (r) { return [r.quarter, r.allowance_pct]; }), color: '#c9a227' }], { label: 'path growth replay', min: 0, max: 4, height: 160, xLabels: labels });
    h += '<div class="legend"><span><i style="background:#c9a227"></i>path growth allowed, % a year (0–4%)</span></div><p class="caveat">' + esc(rp.caveat) + '</p></div></section>';
  });

  // ---- Community agents ----
  var cm = D.community || { agents: [] };
  h += '<section><h2>Community agents</h2><p class="sub">Agents written by outside contributors and their AIs, plugged into The People\'s Watch like building blocks. Each runs in a sealed sandbox (no secrets, no internet, read-only) and its report is advisory. <a href="' + REPO + '/tree/main/community">Add your own agent</a>.</p>';
  if (!cm.agents.length) h += '<div class="card"><p style="margin:0">No community agents yet. Be the first.</p></div>';
  else {
    h += '<div class="grid g2">';
    cm.agents.forEach(function (a) {
      var st = a.error ? 'warn' : a.report.status;
      h += '<div class="card"><div class="row" style="display:flex;justify-content:space-between;gap:8px"><div><strong>' + esc(a.name || a.id) + '</strong><div class="meta">by ' + esc(a.author || 'unknown') + ' · ' + esc(a.role || '') + (a.isolated ? ' · ran sealed' : '') + '</div></div>' + pill(a.error ? 'warn' : (a.report.status === 'ok' ? 'ok' : a.report.status), a.error ? 'did not run' : a.report.status) + '</div>';
      if (a.error) h += '<p class="meta">' + esc(a.error) + '</p>';
      else {
        h += '<p style="margin:10px 0 6px"><strong>' + esc(a.report.headline) + '</strong></p><ul style="margin:0;padding-left:18px">';
        a.report.findings.forEach(function (f) { h += '<li>' + esc(f.label) + (f.value ? ': ' + esc(f.value) : '') + (f.note ? ' <span class="meta">(' + esc(f.note) + ')</span>' : '') + '</li>'; });
        h += '</ul>';
      }
      h += '<p class="meta" style="margin:8px 0 0">' + esc(a.description || '') + (a.output_sha256 ? ' · fingerprint ' + esc(a.output_sha256.slice(0, 12)) + '…' : '') + '</p></div>';
    });
    h += '</div>';
  }
  h += '</section>';

  // ---- Red team ----
  var rt = D.redteam;
  if (rt) {
    h += '<section><h2>Red team ' + pill(rt.all_caught ? 'ok' : 'fail', rt.all_caught ? 'every attack caught' : 'attack missed') + '</h2><p class="sub">Before every run, a red-team agent attacks a throwaway copy of the record: forging the ledger, editing inputs, making a calculator lie, trying to break out of the sandbox. Each control must catch its attack. Anything missed raises an urgent public flag.</p><div class="card"><table><thead><tr><th>Attack</th><th>Result</th></tr></thead><tbody>';
    rt.attacks.forEach(function (a) { h += '<tr><td>' + esc(a.description) + '<div class="meta">' + esc(a.detail) + '</div></td><td>' + pill(a.caught ? 'ok' : 'fail', a.caught ? 'caught' : 'missed') + '</td></tr>'; });
    h += '</tbody></table>';
    if (rt.ai_ideas && rt.ai_ideas.ideas && rt.ai_ideas.ideas.length) { h += '<p style="margin:12px 0 4px"><strong>New attacks to try next</strong> <span class="meta">(suggested by the AI red-teamer; for humans to review, never executed)</span></p><ul style="margin:0">'; rt.ai_ideas.ideas.forEach(function (x) { h += '<li>' + esc(x) + '</li>'; }); h += '</ul>'; }
    h += '<p class="meta" style="margin:10px 0 0">Last attacked ' + esc(rt.ran_at.slice(0, 16).replace('T', ' ')) + ' UTC.</p></div></section>';
  }

  // ---- Independent witnesses ----
  var wt = (D.witnesses && D.witnesses.checkpoints) || [];
  h += '<section><h2>Independent witnesses</h2><p class="sub">After every run, a fingerprint of the ledger is handed to three witnesses this project does not control: the Bitcoin blockchain (via OpenTimestamps, free), Sigstore\'s public transparency log (signed by GitHub\'s workflow identity), and the Internet Archive. Like printing the day\'s fingerprint in a newspaper the whole world keeps, no one can quietly rewrite the record later. A witness proves when the record existed and that it has not changed, not that the numbers are true.</p>';
  if (!wt.length) h += '<div class="card"><p style="margin:0">The first checkpoint is witnessed on the next scheduled run.</p></div>';
  else {
    h += '<div class="card"><table><thead><tr><th>Checkpoint</th><th>Bitcoin</th><th>Sigstore log</th><th>Internet Archive</th></tr></thead><tbody>';
    wt.slice(-10).reverse().forEach(function (c) {
      var b = c.bitcoin || {};
      var btc = b.status === 'confirmed' ? pill('ok', 'block ' + b.block_height) + (b.explorer ? ' <a class="meta" href="' + esc(b.explorer) + '">view</a>' : '') : b.status === 'pending' ? pill('warn', 'waiting for a block') : pill('info', b.status || '—');
      var sg = c.sigstore && c.sigstore.rekor_log_index != null ? '<a href="' + esc(c.sigstore.rekor_search) + '">#' + esc(c.sigstore.rekor_log_index) + '</a>' : (c.sigstore && c.sigstore.attestation_url ? '<a href="' + esc(c.sigstore.attestation_url) + '">attested</a>' : '—');
      var wb = c.wayback ? '<a href="' + esc(c.wayback.snapshot || c.wayback.lookup) + '">' + esc(c.wayback.status) + '</a>' : '—';
      h += '<tr><td><a href="' + REPO + '/blob/main/' + esc(c.file) + '">#' + esc(c.ledger_seq) + ' · ' + esc(c.run_date) + '</a><div class="meta mono">' + esc((c.ledger_entry_hash || '').slice(0, 16)) + '…</div></td><td>' + btc + '</td><td>' + sg + '</td><td>' + wb + '</td></tr>';
    });
    h += '</tbody></table><p class="meta" style="margin:10px 0 0">Verify any checkpoint: <span class="mono">node scripts/witness.js verify data/checkpoints/&lt;file&gt;</span> · Bitcoin proofs can also be checked by dropping the file and its .ots proof on opentimestamps.org. A Bitcoin proof completes a few hours after submission.</p></div>';
  }
  h += '</section>';

  // ---- Human gates ----
  h += '<section><h2>Human gates</h2><p class="sub">Agents prepare, people decide. Each packet says what happened, what the rule says, and who decides. New packets open an issue on GitHub.</p>';
  D.packets.forEach(function (p) {
    h += '<div class="packet ' + esc(p.severity) + '"><div class="h">' + esc(p.title) + ' <span class="meta">· ' + esc(p.severity) + '</span></div><div>' + esc(p.what_happened) + '</div><div class="who"><strong>Rule:</strong> ' + esc(p.what_the_rule_says) + '</div><div class="who"><strong>Who decides:</strong> ' + esc(p.who_decides) + '</div></div>';
  });
  h += '</section>';

  // ---- Check it yourself ----
  h += '<section><h2>Check it yourself</h2><p class="sub">Every run is sealed into a public, append-only ledger. Each entry is chained to the one before it, so a quiet edit would break every seal after it. The auditor re-checks everything after each run.</p><div class="grid g2"><div class="card"><table><thead><tr><th>Audit check</th><th>Result</th></tr></thead><tbody>';
  D.audit.checks.forEach(function (c) { h += '<tr><td>' + esc(c.name) + '<div class="meta">' + esc(c.detail) + '</div></td><td>' + pill(c.status === 'ok' ? 'ok' : 'fail', c.status === 'ok' ? 'pass' : 'fail') + '</td></tr>'; });
  h += '</tbody></table><p class="meta">Ledger entry #' + D.run.ledger_seq + ' · seal <span class="mono">' + esc(D.run.ledger_hash.slice(0, 24)) + '…</span></p></div>';
  h += '<div class="card"><p style="margin-top:0"><strong>Recompute the number on your own computer</strong> (Python 3, no installs):</p><pre>git clone ' + REPO + '.git\ncd ' + REPO.split('/').pop() + '\npython3 scripts/recompute.py --fetch</pre><p class="meta">FRED\'s terms don\'t allow this project to republish its downloads, so the script fetches CPI, PCE and GDP from FRED for you, then prints the same numbers shown above with each file\'s fingerprint. A dated snapshot matches the record exactly; the latest files match until FRED adds or revises data.</p></div></div>';
  h += '<div class="card" style="margin-top:14px"><table><thead><tr><th>Input</th><th>Agency</th><th>Latest</th><th>Fingerprint (SHA-256)</th></tr></thead><tbody>';
  D.sources.forEach(function (s) { h += '<tr><td><a href="' + esc(s.url) + '">' + esc(s.id) + '</a><div class="meta">' + esc(s.title) + '</div></td><td>' + esc(s.agency) + '</td><td class="num">' + esc(s.last ? s.last.date + ' = ' + s.last.value : (s.error || '—')) + '</td><td class="num">' + esc(s.sha256 ? s.sha256.slice(0, 16) + '…' : '—') + '</td></tr>'; });
  h += '</tbody></table></div></section>';

  // ---- Interpretations ----
  h += '<section><h2>Choices waiting for a ruling</h2><p class="sub">The book leaves some details to the Design Paper. Until they are ruled on, the shadow run uses these readings, published here so reviewers can challenge them.</p><div class="card"><ol style="margin:0">';
  D.rule.interpretations_pending_review.forEach(function (x) { h += '<li>' + esc(x) + '</li>'; });
  h += '</ol></div></section>';

  // ---- Have your say ----
  h += '<section><h2>Have your say</h2><p class="sub">Found a data problem, think a rule reading is wrong, or broke something? Tell us in public. Every report is answered on the record.</p><div class="btns">';
  h += '<a class="btn primary" href="' + REPO + '/issues/new?template=red-team-finding.md">Report a red-team finding</a>';
  h += '<a class="btn" href="' + REPO + '/issues/new?template=data-problem.md">Report a data problem</a>';
  h += '<a class="btn" href="' + REPO + '/issues/new?template=rule-question.md">Question a rule reading</a>';
  h += '<a class="btn" href="' + REPO + '/issues/new?template=idea.md">Suggest an agent or idea</a>';
  h += '<a class="btn" href="' + REPO + '">See all the code</a></div></section>';

  app.innerHTML = h;
  // When embedded on peoplesmoneyproject.org, tell the host page how tall we are, so there is no inner scrollbar.
  if (window.parent !== window) {
    var tell = function () { try { window.parent.postMessage({ type: 'watch-height', height: document.documentElement.scrollHeight }, '*'); } catch (e) {} };
    tell(); window.addEventListener('resize', tell); setTimeout(tell, 600); setTimeout(tell, 2000);
  }
  document.getElementById('footer').innerHTML = '<p style="margin:0 0 6px"><strong>The People\'s Money</strong> · <a href="https://peoplesmoneyproject.org">peoplesmoneyproject.org</a> · <a href="' + REPO + '">source code (MIT)</a> · <a href="data/latest.json">raw data</a> · <a href="data/ledger.jsonl">ledger</a></p><p style="margin:0">' + esc(D.disclaimer) + ' Run ' + esc(D.run.date) + ' (' + esc(D.run.mode) + ').</p>';
})();
