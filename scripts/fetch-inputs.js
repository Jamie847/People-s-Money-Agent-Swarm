#!/usr/bin/env node
// Download the raw input files into data/inputs/ so the sandboxed community agents (which run before the main
// run) see today's data. Nothing here is committed: FRED's terms don't allow keeping its downloads in a public
// archive, and data/inputs/ is git-ignored except the BIS file. The main run downloads and seals its own copy.
// Keyless, same validation as the sensors. Never fails the job: missing files just mean less context.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSensors } from '../src/agents/sensors.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { sources } = JSON.parse(readFileSync(join(root, 'config', 'sources.json'), 'utf8'));
const today = process.env.SWARM_TODAY || new Date().toISOString().slice(0, 10);
try {
  const results = await runSensors(sources, { inputsDir: join(root, 'data', 'inputs'), fredKey: '', today });
  const ok = results.filter((r) => r.ok).length;
  console.log(`Fetched ${ok} of ${results.length} input files for the sandboxed agents (not committed).`);
} catch (err) {
  console.log(`Could not fetch inputs for the sandboxed agents: ${String(err.message || err).slice(0, 160)}`);
}
