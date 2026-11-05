#!/usr/bin/env node
// INDEPENDENT WITNESSES
// A tamper-evident ledger proves nothing if the people keeping it could quietly rewrite it all.
// So after each run, the swarm hands a fingerprint of the ledger to witnesses it does not control:
//   1. Bitcoin, via OpenTimestamps (free): proves the checkpoint existed by a given Bitcoin block.
//   2. Sigstore's public transparency log, via GitHub artifact attestations: a signed, public record
//      that this exact checkpoint was produced by this repository's workflow.
//   3. The Internet Archive's Wayback Machine: an outside copy of the checkpoint file itself.
// None of these can show the data were TRUE — only that the record existed then and was not changed.
//
//   node scripts/witness.js prepare              write the checkpoint for the latest ledger entry
//   node scripts/witness.js ots                  stamp the new checkpoint; upgrade pending proofs
//   node scripts/witness.js attest <bundle> <url>  record the Sigstore attestation
//   node scripts/witness.js wayback <commit-sha>   ask the Wayback Machine to save the checkpoint
//   node scripts/witness.js verify <checkpoint>  check a checkpoint against the ledger (anyone can run)

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, appendFileSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJSON, writeJSON, sha256 } from '../src/lib/util.js';
import { readLedger, verifyLedger } from '../src/agents/ledger.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const P = (...p) => join(root, ...p);
const REPO = process.env.GITHUB_REPOSITORY || 'Jamie847/People-s-Money-Agent-Swarm';
const witnessesPath = P('data', 'witnesses.json');
const load = () => readJSON(witnessesPath, { about: 'Independent witnesses for each checkpoint of the ledger. See scripts/witness.js.', checkpoints: [] });
const save = (w) => writeJSON(witnessesPath, w);
const output = (k, v) => { if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`); };
const run = (cmd, args) => { try { return { ok: true, out: execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 }) }; } catch (e) { return { ok: false, out: `${e.stdout || ''}${e.stderr || ''}${e.message}` }; } };

function prepare() {
  const entries = readLedger(P('data', 'ledger.jsonl'));
  const chain = verifyLedger(entries);
  if (!chain.ok) throw new Error(`Ledger chain broken at ${chain.at}: refusing to witness it`);
  const last = entries[entries.length - 1];
  const ledgerText = readFileSync(P('data', 'ledger.jsonl'), 'utf8');
  const rel = `data/checkpoints/${String(last.seq).padStart(6, '0')}-${last.run_date}.json`;
  const checkpoint = {
    what: "Checkpoint of The People's Money agent-swarm ledger",
    repository: `https://github.com/${REPO}`,
    ledger_file: 'data/ledger.jsonl',
    ledger_entries: entries.length,
    ledger_seq: last.seq,
    ledger_entry_hash: last.hash,
    ledger_file_sha256: sha256(ledgerText),
    run_date: last.run_date,
    how_to_verify: 'node scripts/witness.js verify ' + rel,
  };
  writeJSON(P(rel), checkpoint);
  const w = load();
  if (!w.checkpoints.find((c) => c.file === rel)) w.checkpoints.push({ file: rel, ledger_seq: last.seq, ledger_entry_hash: last.hash, run_date: last.run_date, bitcoin: { status: 'not stamped' }, sigstore: null, wayback: null });
  save(w);
  output('checkpoint', rel);
  console.log(`Checkpoint ${rel} (ledger #${last.seq}, ${last.hash.slice(0, 16)}…)`);
}

const blockHeight = (otsFile) => {
  const info = run('ots', ['info', otsFile]);
  const m = /BitcoinBlockHeaderAttestation\((\d+)\)/.exec(info.out);
  return m ? Number(m[1]) : null;
};

function ots() {
  const w = load();
  for (const c of w.checkpoints) {
    const file = P(c.file);
    const proof = `${file}.ots`;
    if (!existsSync(proof)) {
      if (!existsSync(file)) continue;
      const r = run('ots', ['stamp', file]);
      c.bitcoin = r.ok && existsSync(proof) ? { status: 'pending', ots_file: `${c.file}.ots`, submitted: new Date().toISOString() } : { status: 'stamp failed', detail: r.out.slice(-200) };
      console.log(`stamp ${c.file}: ${c.bitcoin.status}`);
      continue;
    }
    if (c.bitcoin?.status === 'confirmed') continue;
    run('ots', ['upgrade', proof]); // exits non-zero while still pending; that is normal
    const h = blockHeight(proof);
    c.bitcoin = h ? { status: 'confirmed', block_height: h, ots_file: `${c.file}.ots`, explorer: `https://mempool.space/block/${h}` } : { ...c.bitcoin, status: 'pending', ots_file: `${c.file}.ots` };
    console.log(`upgrade ${c.file}: ${c.bitcoin.status}${h ? ` in block ${h}` : ''}`);
  }
  save(w);
}

function attest(bundlePath, url) {
  const w = load();
  const c = w.checkpoints[w.checkpoints.length - 1];
  let logIndex = null;
  try {
    const b = JSON.parse(readFileSync(bundlePath, 'utf8'));
    logIndex = b?.verificationMaterial?.tlogEntries?.[0]?.logIndex ?? null;
  } catch { /* bundle unreadable: record the URL only */ }
  c.sigstore = {
    attestation_url: url || null,
    rekor_log_index: logIndex !== null ? Number(logIndex) : null,
    rekor_search: logIndex !== null ? `https://search.sigstore.dev/?logIndex=${logIndex}` : null,
    verify: `gh attestation verify ${c.file} --repo ${REPO}`,
  };
  save(w);
  console.log(`Sigstore: ${c.file} log index ${logIndex ?? 'n/a'}`);
}

function wayback(commit) {
  const w = load();
  const c = w.checkpoints[w.checkpoints.length - 1];
  const target = `https://raw.githubusercontent.com/${REPO}/${commit}/${c.file}`;
  const r = run('curl', ['-sS', '-m', '120', '-o', '/dev/null', '-D', '-', `https://web.archive.org/save/${target}`]);
  const loc = /^(?:content-location|location):\s*(\S+)/im.exec(r.out);
  const snap = loc ? (loc[1].startsWith('http') ? loc[1] : `https://web.archive.org${loc[1]}`) : null;
  c.wayback = { target, snapshot: snap, lookup: `https://web.archive.org/web/*/${target}`, status: snap ? 'saved' : 'requested' };
  save(w);
  console.log(`Wayback: ${c.wayback.status} ${snap || ''}`);
}

function verify(rel) {
  const cp = readJSON(P(rel));
  const entries = readLedger(P('data', 'ledger.jsonl'));
  const chain = verifyLedger(entries);
  const entry = entries[cp.ledger_seq];
  const checks = [
    ['ledger chain intact', chain.ok],
    [`ledger entry #${cp.ledger_seq} still has the checkpointed hash`, entry && entry.hash === cp.ledger_entry_hash],
  ];
  for (const [label, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  console.log(`Bitcoin proof:  ots verify ${rel}.ots   (or drop both files on https://opentimestamps.org)`);
  console.log(`Sigstore proof: gh attestation verify ${rel} --repo ${REPO}`);
  process.exit(checks.every((c) => c[1]) ? 0 : 1);
}

const [cmd, a, b] = process.argv.slice(2);
({ prepare, ots, attest: () => attest(a, b), wayback: () => wayback(a), verify: () => verify(a) }[cmd] || (() => { console.log('usage: witness.js prepare|ots|attest <bundle> <url>|wayback <sha>|verify <checkpoint>'); process.exit(2); }))();
