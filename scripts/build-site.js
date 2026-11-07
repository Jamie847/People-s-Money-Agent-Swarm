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
// Small input arrays still published inside the frozen readings, pending FRED's answer on derived results
// (3 monthly CPI/PCE values per quarter and up to 11 annual GDP levels). Anything longer is a series and fails.
export const MAX_SERIES_POINTS = 12;

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

const D = /^\d{4}-\d{2}(-\d{2})?$/;
const isPoint = (x) => typeof x === 'number'
  || (Array.isArray(x) && x.length === 2 && typeof x[0] === 'string' && D.test(x[0]) && typeof x[1] === 'number')
  || (x && typeof x === 'object' && !Array.isArray(x) && ('date' in x || 'd' in x) && (typeof x.value === 'number' || typeof x.v === 'number'));

// Returns a list of problems; empty means the output is clean.
export function scanSite(out) {
  const problems = [];
  const walk = (dir) => readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
  const allowed = new Set(['index.html', '.nojekyll']);
  const scanJson = (obj, where, path = '') => {
    if (Array.isArray(obj)) {
      if (obj.length > MAX_SERIES_POINTS && obj.filter(isPoint).length >= 0.8 * obj.length) problems.push(`${where}: series of ${obj.length} data points at ${path || '(root)'}`);
      obj.forEach((v, i) => scanJson(v, where, `${path}[${i}]`));
    } else if (obj && typeof obj === 'object') {
      for (const [k, v] of Object.entries(obj)) {
        if (k === 'history' && Array.isArray(v) && v.some(isPoint)) problems.push(`${where}: observation history at ${path}.${k}`);
        scanJson(v, where, `${path}.${k}`);
      }
    }
  };
  for (const file of walk(out)) {
    const rel = relative(out, file).split(sep).join('/');
    const top = rel.startsWith('data/') ? rel.slice(5).split('/')[0] : rel;
    if (!(allowed.has(rel) || (rel.startsWith('data/') && DATA_ALLOWLIST.includes(top)))) { problems.push(`not on the allowlist: ${rel}`); continue; }
    if (/\.csv$/i.test(rel)) problems.push(`raw data file: ${rel}`);
    if (/\.(ots)$/i.test(rel)) continue;
    const text = readFileSync(file, 'utf8');
    if (/observation_date,|^DATE,/m.test(text)) problems.push(`raw CSV content in ${rel}`);
    if (rel.endsWith('.json')) { try { scanJson(JSON.parse(text), rel); } catch { problems.push(`unreadable JSON: ${rel}`); } }
    if (rel.endsWith('.jsonl')) text.split('\n').filter(Boolean).forEach((l, i) => { try { scanJson(JSON.parse(l), `${rel}:${i + 1}`); } catch { problems.push(`unreadable line ${i + 1} in ${rel}`); } });
    if (rel === 'index.html') {
      const m = text.match(/window\.SWARM_DATA = ([\s\S]*?);<\/script>/);
      if (!m) problems.push('index.html: inlined record not found');
      else { try { scanJson(JSON.parse(m[1]), 'index.html (inlined record)'); } catch { problems.push('index.html: inlined record unreadable'); } }
    }
  }
  return problems;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const out = join(ROOT, process.argv[2] || '_site');
  const { html } = buildSite({ out });
  const problems = scanSite(out);
  if (problems.length) {
    console.error(`Publication check FAILED (nothing will be uploaded):\n- ${problems.slice(0, 30).join('\n- ')}`);
    process.exit(1);
  }
  console.log(`Built ${join(out, 'index.html')} (${(html.length / 1024).toFixed(0)} KB); publication check passed.`);
}
