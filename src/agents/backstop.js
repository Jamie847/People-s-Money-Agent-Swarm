// TRANSITION BACKSTOP AGENT (PROPOSAL ONLY — not in Design Paper 0.7.2)
// Shows what the proposed transition dollar backstop would look like if the switch happened today:
// the cap it would allow, how much of it current usage would take, and whether the taper would pause.

import { round } from '../lib/util.js';

export function runBackstop(sensorById, proposal, globalStatus) {
  const custody = sensorById.FOREIGN_CUSTODY;
  const swaps = sensorById.SWAPS;
  const fima = sensorById.FIMA_REPO;
  if (!custody?.ok || !swaps?.ok || !fima?.ok) {
    return { status: proposal.status, available: false, detail: 'Missing one of foreign custody, swap-line or FIMA repo data.' };
  }
  const capM = (proposal.cap_pct_of_foreign_official_custody / 100) * custody.last.value;
  const usageM = swaps.last.value + fima.last.value;
  return {
    status: proposal.status,
    available: true,
    as_of: [custody.last.date, swaps.last.date, fima.last.date].sort()[0],
    cap_billions: round(capM / 1000, 1),
    usage_billions: round(usageM / 1000, 3),
    utilization_pct: round((100 * usageM) / capM, 3),
    taper_would_pause: globalStatus === proposal.taper_pauses_when_sentinel,
    taper_years: proposal.taper_years,
    sunset_years: proposal.sunset_years,
    extension_requires: proposal.extension_requires,
    operated_by: proposal.operated_by,
    instruments: proposal.instruments,
    never: proposal.never,
    open_questions: proposal.open_questions,
    reference_peaks_billions: { swaps_dec_2008: 583, swaps_may_2020: 449 },
  };
}
