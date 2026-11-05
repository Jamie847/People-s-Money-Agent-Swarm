// VINTAGE SENSOR
// The book: the rule uses figures "as first released", and "later revisions never change money already issued".
// This agent fetches the three rule inputs exactly as they were published ON the computation date, from
// ALFRED (the St. Louis Fed's archive of past data versions; free, no key), and archives them with fingerprints.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256, writeText } from '../lib/util.js';
import { download, parseFredCsv } from './sensors.js';

export const VINTAGE_SERIES = [
  { id: 'CPI', series: 'CPIAUCSL', start: '1998-01-01', key: 'cpi' },
  { id: 'PCE', series: 'PCEPI', start: '1998-01-01', key: 'pce' },
  { id: 'GDP', series: 'GDPCA', start: '1980-01-01', key: 'gdp' },
];

export const vintageUrl = (s, date) => `https://alfred.stlouisfed.org/graph/alfredgraph.csv?id=${s.series}&cosd=${s.start}&vintage_date=${date}`;

export async function fetchVintage(root, date, { offline = false } = {}) {
  const dir = `data/inputs/vintages/${date}`;
  const out = { ok: true, dir, date, series: {}, sha256: {}, urls: {} };
  try {
    for (const s of VINTAGE_SERIES) {
      const file = join(root, dir, `${s.id}.csv`);
      let text;
      if (existsSync(file)) text = readFileSync(file, 'utf8');            // archived: never re-fetched, never changed
      else if (offline) throw new Error(`no archived vintage for ${s.id} on ${date}`);
      else { text = await download(vintageUrl(s, date)); writeText(file, text); }
      const header = text.split('\n')[0];
      if (!/_\d{8}/.test(header)) throw new Error(`${s.id}: response is not an ALFRED vintage`);
      out.series[s.key] = parseFredCsv(text);
      out.sha256[s.id] = sha256(text);
      out.urls[s.id] = vintageUrl(s, date);
    }
  } catch (err) {
    return { ok: false, error: String(err.message || err).slice(0, 160) };
  }
  return out;
}
