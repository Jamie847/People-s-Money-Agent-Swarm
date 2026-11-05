#!/usr/bin/env node
// HUMAN GATE → GitHub: open one issue per new decision packet so people see it and decide.
// Runs inside GitHub Actions with GH_TOKEN. Safe to run without a token (it just prints).
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJSON } from '../src/lib/util.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const packets = readJSON(join(root, 'data', 'new-packets.json'), []);
if (!packets.length) { console.log('No new packets.'); process.exit(0); }
if (!process.env.GH_TOKEN) { console.log(`${packets.length} new packet(s); no GH_TOKEN, not opening issues.`); process.exit(0); }

const gh = (args) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
try { gh(['label', 'create', 'human-gate', '--color', 'B22234', '--description', 'A swarm decision packet waiting for a person', '--force']); } catch (e) { console.log('label:', e.message.split('\n')[0]); }

for (const p of packets) {
  const body = [
    `**Packet** \`${p.id}\` · severity **${p.severity}**`,
    '',
    `**What happened:** ${p.what_happened}`,
    '',
    `**What the rule says:** ${p.what_the_rule_says}`,
    '',
    `**Who decides:** ${p.who_decides}`,
    '',
    '**Evidence:**',
    '```json',
    JSON.stringify(p.evidence, null, 2).slice(0, 6000),
    '```',
    '',
    '_Opened automatically by the decision-packet clerk. Agents prepare; people decide. Close this issue with a comment recording the decision._',
  ].join('\n');
  try {
    const url = gh(['issue', 'create', '--title', `[human gate] ${p.title}`, '--body', body, '--label', 'human-gate']).trim();
    console.log(`Opened ${url}`);
  } catch (e) {
    console.log(`Could not open issue for ${p.id}: ${e.message.split('\n')[0]}`);
  }
}
