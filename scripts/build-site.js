#!/usr/bin/env node
// Builds the static dashboard into _site/: one self-contained index.html with the latest record inlined, plus
// an explicit allowlist of public record files (ledger, checkpoints, witnesses, results). Raw input files are
// never published: FRED's terms don't allow keeping its downloads in a public archive. After building, the
// whole output is scanned (scanSite) and the build fails if anything prohibited got in, so nothing is uploaded.
import { readFileSync, cpSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Public record files the dashboard links to. Everything else in data/ stays out (inputs, internal state).
export const DATA_ALLOWLIST = ['latest.json', 'live-history.json', 'ledger.jsonl', 'witnesses.json', 'community.json',
  'redteam.json', 'packets.json', 'checkpoints'];
// Lists longer than this that look like a data series fail, unless they are one of the named derived series below.
export const MAX_SERIES_POINTS = 12;
// Derived series that are still published, pending FRED's answer on derived results. Each is named by its
// place in the record, with a maximum length and the only fields its rows may have. Anything else fails.
export const DERIVED_SERIES = {
  'data/latest.json': [
    { path: '.live.path_index', max: 400, keys: ['quarter', 'path_index'] },
    { path: '.replays[].rows', max: 200, keys: ['quarter', 'trend_growth_pct', 'gap_lp', 'allowance_pct', 'allowance_raw_pct', 'brake', 'path_index'] },
    { path: '.head_to_head.price_series', max: 40, keys: ['year', 'through', 'actual', 'fed_target_path', 'rule_target'] },
    { path: '.head_to_head.money', max: 40, keys: ['year', 'fed_base_growth_pct', 'rule_allowed_pct', 'friedman_k_pct', 'pop_plus_productivity_pct'] },
    { path: '.head_to_head.costs', max: 40, keys: ['year', 'interest_to_banks_estimate_b', 'inflation_on_cash_b'] },
  ],
};
// Witness records are one row per checkpoint (fingerprints and receipts), not data; named so they aren't
// mistaken for a series. Their nested receipts are still scanned.
const WITNESS_ROWS = { path: '.checkpoints', max: 100000, keys: ['file', 'ledger_seq', 'ledger_entry_hash', 'run_date', 'bitcoin', 'sigstore', 'wayback'], nested: true };
DERIVED_SERIES['data/witnesses.json'] = [WITNESS_ROWS];
DERIVED_SERIES['index.html (inlined record)'] = [...DERIVED_SERIES['data/latest.json'], { ...WITNESS_ROWS, path: '.witnesses.checkpoints' }];
// The few inputs stored with each frozen reading (so anyone can recheck it), with a fixed shape.
export const READING_INPUTS = { paths: { 'data/latest.json': '.live.latest.inputs', 'index.html (inlined record)': '.live.latest.inputs', 'data/live-history.json': '[].inputs' },
  arrays: { base_months: 3, current_months: 3, gdp_years: 11, gdp_levels: 11 }, pairs: { base: ['cpi', 'pce'], cur: ['cpi', 'pce'] }, pairMax: 3 };
const NEWSLETTER_KEYS = new Set(['month', 'kind', 'title', 'subtitle', 'subject', 'preview', 'ai_opener', 'generated_at', 'ledger_seq', 'html']);
const BIS_HEADER = 'FREQ,CURR_DENOM,BORROWERS_CTY,BORROWERS_SECTOR,LENDERS_SECTOR,L_POS_TYPE,L_INSTR,UNIT_MEASURE,TITLE,UNIT_MULT,DECIMALS,COLLECTION,AVAILABILITY,TIME_PERIOD,OBS_VALUE,OBS_STATUS,OBS_PRE_BREAK,OBS_CONF';
const MAX_OTS_BYTES = 16384;
// Expected top-level type of each record file.
const TOP_TYPES = { 'data/latest.json': 'object', 'data/live-history.json': 'array', 'data/community.json': 'object', 'data/redteam.json': 'object',
  'data/packets.json': 'array', 'data/witnesses.json': 'object', 'data/new-packets.json': 'array', 'data/packets-seen.json': 'array' };
const LEDGER_KEYS = new Set(['seq', 'run_date', 'started_at', 'mode', 'inputs_sha256', 'rule_sha256', 'live_history_sha256', 'latest_quarter',
  'latest_outputs_sha256', 'brake_phase', 'global_dollar', 'domestic', 'plumbing', 'packets', 'community_sha256', 'redteam_sha256', 'prev_hash', 'hash']);
const CHECKPOINT_KEYS = new Set(['what', 'repository', 'ledger_file', 'ledger_entries', 'ledger_seq', 'ledger_entry_hash', 'ledger_file_sha256', 'run_date', 'how_to_verify']);
const OTS_MAGIC = Buffer.from('\x00OpenTimestamps\x00\x00Proof\x00', 'latin1');

// The dashboard page without its data: template + style + app code from the repository.
export function pageShell(root = ROOT) {
  const tpl = readFileSync(join(root, 'dashboard', 'index.html'), 'utf8');
  const css = readFileSync(join(root, 'dashboard', 'style.css'), 'utf8');
  const js = readFileSync(join(root, 'dashboard', 'app.js'), 'utf8');
  return tpl.replace('/*__STYLE__*/', () => css).replace('/*__APP__*/', () => js);
}

export function buildSite({ root = ROOT, out = join(ROOT, '_site') } = {}) {
  const tpl = readFileSync(join(root, 'dashboard', 'index.html'), 'utf8');
  const css = readFileSync(join(root, 'dashboard', 'style.css'), 'utf8');
  const js = readFileSync(join(root, 'dashboard', 'app.js'), 'utf8');
  // Inline the latest record plus the witnesses file (which is written after the run is sealed).
  const latestObj = JSON.parse(readFileSync(join(root, 'data', 'latest.json'), 'utf8'));
  try { latestObj.witnesses = JSON.parse(readFileSync(join(root, 'data', 'witnesses.json'), 'utf8')); } catch { latestObj.witnesses = { checkpoints: [] }; }
  const data = JSON.stringify(latestObj);
  // Make the JSON safe to embed inside a <script> element.
  const safeData = data.trim().replace(/</g, '\\u003c').split(String.fromCharCode(0x2028)).join('\\u2028').split(String.fromCharCode(0x2029)).join('\\u2029');
  const html = tpl
    .replace('/*__STYLE__*/', () => css)
    .replace('/*__DATA__*/null', () => safeData)
    .replace('/*__APP__*/', () => js);

  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, 'data'), { recursive: true });
  writeFileSync(join(out, 'index.html'), html);
  for (const name of DATA_ALLOWLIST) {
    const src = join(root, 'data', name);
    if (existsSync(src)) cpSync(src, join(out, 'data', name), { recursive: true });
  }
  writeFileSync(join(out, '.nojekyll'), '');
  return { html };
}

const NUM = (x) => (typeof x === 'number' && Number.isFinite(x)) || (typeof x === 'string' && /^\s*[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?\s*$/i.test(x));
const DATEISH = (x) => typeof x === 'string' && /^\s*(\d{4}(-\d{1,2}(-\d{1,2})?)?|\d{4}-?Q[1-4]|\d{4}-?M\d{1,2}|\d{1,2}\/\d{1,2}\/\d{2,4})\s*$/i.test(x);
const TIME_KEYS = new Set(['date', 'd', 't', 'x', 'year', 'quarter', 'month', 'period', 'through', 'as_of', 'observation_date', 'time']);
// One observation, in any common shape: a number or numeric string, a [date, value] pair, or a record with a
// time field and a numeric field.
const VAL = (x) => NUM(x) && !DATEISH(x); // "2008" in a list of years is a label, not a value
const isPoint = (x) => {
  if (VAL(x)) return true;
  if (Array.isArray(x)) return x.length === 2 && (DATEISH(x[0]) || NUM(x[0])) && NUM(x[1]);
  if (x && typeof x === 'object') {
    const entries = Object.entries(x);
    const timed = entries.some(([k, v]) => TIME_KEYS.has(k) || DATEISH(v));
    return timed && entries.some(([k, v]) => !TIME_KEYS.has(k) && NUM(v));
  }
  return false;
};
// Text that carries a table of dated values (CSV, TSV, or similar), however it is wrapped.
const tableRows = (s) => s.replace(/<[^>]*>/g, '\n').split(/\r?\n/).filter((l) => /^\s*"?(\d{4}(-\d{1,2}){0,2}|\d{4}-?Q[1-4]|\d{1,2}\/\d{1,2}\/\d{2,4})"?\s*[,;\t|:]\s*"?[+-]?(\d|\.\d)/.test(l)).length;
const textProblem = (s) => (/observation_date|realtime_start|realtime_end/i.test(s) ? 'raw FRED field names' : tableRows(s) >= 3 ? `table of ${tableRows(s)} dated values` : null);

// Returns a list of problems; empty means the output is clean.
// Options: extraFiles (more allowed files, exact names or RegExps, checked like JSON); bisFiles (allowed only if
// they really are the BIS layout); shellRoot (repository whose dashboard templates index.html must match).
export function scanSite(out, { extraFiles = [], bisFiles = [], shellRoot = null } = {}) {
  const problems = [];
  const counts = new Map(); // per file: observation points and date keys outside named structures (catches split series)
  const tally = (where, kind, n) => { const c = counts.get(where) || { points: 0, dateKeys: 0 }; c[kind] += n; counts.set(where, c); };
  const strictPoint = (x) => VAL(x) || (Array.isArray(x) && x.length === 2 && (DATEISH(x[0]) || NUM(x[0])) && NUM(x[1]))
    || (x && typeof x === 'object' && !Array.isArray(x) && Object.keys(x).length <= 3 && Object.keys(x).some((k) => TIME_KEYS.has(k)) && Object.entries(x).some(([k, v]) => !TIME_KEYS.has(k) && NUM(v)));
  const checkInputs = (obj, where, path) => {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) { problems.push(`${where}: ${path} is not a reading-inputs record`); return; }
    for (const [k, v] of Object.entries(obj)) {
      if (k in READING_INPUTS.arrays) {
        if (!Array.isArray(v) || v.length > READING_INPUTS.arrays[k] || !v.every((x) => NUM(x) || DATEISH(x))) problems.push(`${where}: ${path}.${k} is not a short list of values (max ${READING_INPUTS.arrays[k]})`);
      } else if (k in READING_INPUTS.pairs) {
        if (!v || typeof v !== 'object' || Array.isArray(v)) { problems.push(`${where}: ${path}.${k} is not a record`); continue; }
        for (const [kk, vv] of Object.entries(v)) {
          if (!READING_INPUTS.pairs[k].includes(kk)) problems.push(`${where}: unexpected field "${kk}" in ${path}.${k}`);
          else if (!Array.isArray(vv) || vv.length > READING_INPUTS.pairMax || !vv.every(NUM)) problems.push(`${where}: ${path}.${k}.${kk} is not a list of up to ${READING_INPUTS.pairMax} values`);
        }
      } else problems.push(`${where}: unexpected field "${k}" in ${path}`);
    }
  };
  const walk = (dir) => readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
  const scanJson = (obj, where, path = '') => {
    const norm = path.replace(/\[\d+\]/g, '[]');
    if (READING_INPUTS.paths[where] === norm) { checkInputs(obj, where, path); return; }
    if (typeof obj === 'string') { const tp = textProblem(obj); if (tp) problems.push(`${where}: ${tp} in a text value at ${path || '(root)'}`); return; }
    if (Array.isArray(obj)) {
      const named = (DERIVED_SERIES[where] || []).find((s) => s.path === norm);
      if (named) {
        if (obj.length > named.max) problems.push(`${where}: ${norm} has ${obj.length} rows (limit ${named.max})`);
        obj.forEach((row, i) => {
          if (!row || typeof row !== 'object' || Array.isArray(row)) { problems.push(`${where}: ${norm}[${i}] is not a row`); return; }
          for (const [k, v] of Object.entries(row)) {
            if (!named.keys.includes(k)) problems.push(`${where}: unexpected field "${k}" in ${norm}[${i}]`);
            if (v !== null && typeof v === 'object') {
              if (named.nested) scanJson(v, where, `${path}[${i}].${k}`);
              else problems.push(`${where}: nested data in ${norm}[${i}].${k}`);
            } else if (typeof v === 'string') scanJson(v, where, `${path}[${i}].${k}`);
          }
        });
        return;
      }
      if (obj.length > MAX_SERIES_POINTS && obj.filter(isPoint).length >= 0.8 * obj.length) problems.push(`${where}: series of ${obj.length} data points at ${path || '(root)'}`);
      tally(where, 'points', obj.filter(strictPoint).length);
      obj.forEach((v, i) => scanJson(v, where, `${path}[${i}]`));
      return;
    }
    if (obj && typeof obj === 'object') {
      const keys = Object.keys(obj);
      if (keys.length > MAX_SERIES_POINTS && keys.filter(DATEISH).length >= 0.8 * keys.length) problems.push(`${where}: date-keyed series of ${keys.length} values at ${path || '(root)'}`);
      tally(where, 'dateKeys', keys.filter(DATEISH).length);
      for (const [k, v] of Object.entries(obj)) {
        if (k === 'history' && Array.isArray(v) && v.some(isPoint)) problems.push(`${where}: observation history at ${path}.${k}`);
        scanJson(v, where, `${path}.${k}`);
      }
    }
  };
  const parse = (text, rel) => { try { return JSON.parse(text); } catch { problems.push(`unreadable JSON: ${rel}`); return undefined; } };
  const isExtra = (rel) => extraFiles.some((e) => (e instanceof RegExp ? e.test(rel) : e === rel));
  const checkFile = (file, rel) => {
    if (rel === '.nojekyll') { if (statSync(file).size) problems.push('.nojekyll is not empty'); return; }
    const cp = rel.match(/^data\/checkpoints\/(\d{6}-\d{4}-\d{2}-\d{2}\.json)(\.ots(\.bak)?)?$/);
    if (cp && cp[2]) { // Bitcoin timestamp proofs: small binary OpenTimestamps files; any embedded text must be a calendar URL
      const buf = readFileSync(file);
      if (!buf.subarray(0, OTS_MAGIC.length).equals(OTS_MAGIC)) { problems.push(`not an OpenTimestamps proof: ${rel}`); return; }
      if (buf.length > MAX_OTS_BYTES) problems.push(`timestamp proof too large (${buf.length} bytes): ${rel}`);
      const latin = buf.toString('latin1');
      const tp = textProblem(latin); if (tp) problems.push(`${rel}: ${tp} inside a timestamp proof`);
      for (const m of latin.matchAll(/[\x20-\x7e]{16,}/g)) if (!/^.{0,3}https:\/\/[a-z0-9.-]+(\/[\w.\/-]*)?$/i.test(m[0]) && !/^\x00?OpenTimestamps/.test(m[0])) problems.push(`${rel}: unexpected text inside a timestamp proof`);
      return;
    }
    if (bisFiles.includes(rel)) { // the BIS file is allowed only if it really is the BIS layout
      const lines = readFileSync(file, 'utf8').trim().split(/\r?\n/);
      if (lines[0] !== BIS_HEADER) problems.push(`${rel}: not the BIS file layout`);
      else if (lines.slice(1).some((l) => !/^Q,USD,/.test(l))) problems.push(`${rel}: unexpected rows in the BIS file`);
      if (/observation_date|realtime_start/i.test(lines.join('\n'))) problems.push(`${rel}: FRED content in the BIS file`);
      return;
    }
    const newsletter = /^data\/newsletter\/\d{4}-\d{2}\.json$/.test(rel) && isExtra(rel);
    const isData = cp || isExtra(rel) || (rel.startsWith('data/') && !rel.slice(5).includes('/') && DATA_ALLOWLIST.includes(rel.slice(5)));
    if (!(rel === 'index.html' || isData)) { problems.push(`not on the allowlist: ${rel}`); return; }
    const text = readFileSync(file, 'utf8');
    if (rel === 'index.html') {
      const m = text.match(/window\.SWARM_DATA = ([\s\S]*?);<\/script>/);
      if (!m) { problems.push('index.html: inlined record not found'); return; }
      const rest = text.replace(m[0], 'window.SWARM_DATA = /*__DATA__*/null;</script>');
      if (shellRoot) { if (rest !== pageShell(shellRoot)) problems.push('index.html: page differs from the dashboard templates (extra content or scripts)'); }
      else { const tp = textProblem(rest); if (tp) problems.push(`index.html: ${tp} in the page itself`); }
      const inl = parse(m[1], 'index.html (inlined record)');
      if (inl === undefined) return;
      scanJson(inl, 'index.html (inlined record)');
      // The inlined record must be exactly the published latest.json plus witnesses.json, nothing more.
      try {
        const expect = JSON.parse(readFileSync(join(out, 'data', 'latest.json'), 'utf8'));
        expect.witnesses = existsSync(join(out, 'data', 'witnesses.json')) ? JSON.parse(readFileSync(join(out, 'data', 'witnesses.json'), 'utf8')) : { checkpoints: [] };
        if (JSON.stringify(inl) !== JSON.stringify(expect)) problems.push('index.html: inlined record differs from data/latest.json + witnesses.json');
      } catch { problems.push('index.html: cannot compare the inlined record with data/latest.json'); }
      return;
    }
    const isObj = (o) => o && typeof o === 'object' && !Array.isArray(o);
    if (rel.endsWith('.jsonl')) {
      text.split('\n').filter(Boolean).forEach((l, i) => {
        const e = parse(l, `${rel}:${i + 1}`); if (e === undefined) return;
        if (!isObj(e)) { problems.push(`${rel}:${i + 1}: not a ledger entry`); return; }
        for (const k of Object.keys(e)) if (!LEDGER_KEYS.has(k)) problems.push(`${rel}:${i + 1}: unexpected ledger field "${k}"`);
        if (e.inputs_sha256 != null && !isObj(e.inputs_sha256)) problems.push(`${rel}:${i + 1}: inputs_sha256 is not a record`);
        for (const [id, h] of Object.entries(isObj(e.inputs_sha256) ? e.inputs_sha256 : {})) if (h !== null && !/^[a-f0-9]{64}$/.test(String(h))) problems.push(`${rel}:${i + 1}: inputs_sha256.${id} is not a fingerprint`);
        scanJson(e, rel);
      });
      return;
    }
    const obj = parse(text, rel); if (obj === undefined) return;
    const want = TOP_TYPES[rel] || (newsletter || cp ? 'object' : null);
    if (want && (want === 'array' ? !Array.isArray(obj) : !isObj(obj))) { problems.push(`${rel}: expected a JSON ${want}`); return; }
    if (cp) { if (!isObj(obj)) { problems.push(`${rel}: not a checkpoint record`); return; } for (const k of Object.keys(obj)) if (!CHECKPOINT_KEYS.has(k)) problems.push(`${rel}: unexpected checkpoint field "${k}"`); }
    if (newsletter) {
      if (!isObj(obj)) { problems.push(`${rel}: not a newsletter draft`); return; }
      for (const k of Object.keys(obj)) if (!NEWSLETTER_KEYS.has(k)) problems.push(`${rel}: unexpected newsletter field "${k}"`);
    }
    scanJson(obj, rel);
  };
  for (const file of walk(out)) {
    const rel = relative(out, file).split(sep).join('/');
    try { checkFile(file, rel); } catch (err) { problems.push(`could not check ${rel}: ${String(err && err.message || err).slice(0, 120)}`); }
  }
  // Split series: many small lists (or date-keyed maps) in one file that together form a series.
  for (const [where, c] of counts) {
    if (c.points > MAX_SERIES_POINTS) problems.push(`${where}: ${c.points} data points spread across small lists (limit ${MAX_SERIES_POINTS} outside named series)`);
    if (c.dateKeys > MAX_SERIES_POINTS) problems.push(`${where}: ${c.dateKeys} date keys spread across records (limit ${MAX_SERIES_POINTS})`);
  }
  return problems;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const out = join(ROOT, process.argv[2] || '_site');
  const { html } = buildSite({ out });
  const problems = scanSite(out, { shellRoot: ROOT });
  if (problems.length) {
    console.error(`Publication check FAILED (nothing will be uploaded):\n- ${problems.slice(0, 30).join('\n- ')}`);
    process.exit(1);
  }
  console.log(`Built ${join(out, 'index.html')} (${(html.length / 1024).toFixed(0)} KB); publication check passed.`);
}
