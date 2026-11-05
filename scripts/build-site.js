#!/usr/bin/env node
// Builds the static dashboard into _site/ — one self-contained index.html with the latest data inlined,
// plus a copy of data/ so the raw files, ledger and latest.json are downloadable from the same site.
import { readFileSync, cpSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, process.argv[2] || '_site');
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
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'index.html'), html);
cpSync(join(root, 'data'), join(out, 'data'), { recursive: true });
writeFileSync(join(out, '.nojekyll'), '');
console.log(`Built ${join(out, 'index.html')} (${(html.length / 1024).toFixed(0)} KB)`);
