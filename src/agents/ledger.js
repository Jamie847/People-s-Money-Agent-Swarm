// LEDGER AGENT
// Job: keep an append-only, tamper-evident record. Each entry is sealed to the one before it
// (a hash chain), so any later change to an old entry breaks every hash after it.
// Limit (as the book says): a tamper-evident record shows changes after the fact; it cannot prove
// the original information was true.

import { readFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { sha256, stableStringify } from '../lib/util.js';

export const GENESIS = '0'.repeat(64);

export function readLedger(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

export const sealEntry = (body, prevHash) => sha256(prevHash + stableStringify(body));

export function appendLedger(path, body) {
  const entries = readLedger(path);
  const prev = entries.length ? entries[entries.length - 1] : null;
  const prevHash = prev ? prev.hash : GENESIS;
  const full = { seq: entries.length, ...body, prev_hash: prevHash };
  const hash = sealEntry(full, prevHash);
  const entry = { ...full, hash };
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(entry) + '\n');
  return entry;
}

export function verifyLedger(entries) {
  let prevHash = GENESIS;
  for (let i = 0; i < entries.length; i++) {
    const { hash, ...full } = entries[i];
    if (full.seq !== i) return { ok: false, at: i, reason: 'sequence number out of order' };
    if (full.prev_hash !== prevHash) return { ok: false, at: i, reason: 'previous-hash link broken' };
    if (sealEntry(full, prevHash) !== hash) return { ok: false, at: i, reason: 'entry content does not match its seal' };
    prevHash = hash;
  }
  return { ok: true, entries: entries.length, head: prevHash };
}
