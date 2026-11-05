#!/usr/bin/env python3
"""How often would each sentinel's alarm levels have gone off in the past?

Reads the stored raw files (data/inputs), rebuilds each sentinel's metric for every date it could have been
computed, and reports the share of readings at "watch or worse" and at "stress" since 2007 (or since the
series starts). With --suggest it also prints the levels reached in the worst 10% and worst 2% of readings.
With --write it records the rates for the configured levels in config/sentinels.json under "calibration".

  python3 scripts/calibrate.py [--suggest] [--write]
"""
import csv
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SINCE = '2007-01-01'
BACK = {'pct_change_13w': 13, 'pct_change_21d': 21, 'pct_change_4q': 4, 'pct_change_52w': 52}


def load(sid):
    rows = []
    with open(os.path.join(ROOT, 'data', 'inputs', f'{sid}.csv')) as f:
        r = csv.reader(f)
        next(r)
        for d, v in r:
            try:
                rows.append((d, float(v)))
            except ValueError:
                pass
    return rows


def series(cfg, sid):
    obs = load(sid)
    m = cfg['metric']
    if m == 'level':
        return obs
    if m == 'level_billions':
        return [(d, v / 1000) for d, v in obs]
    if m in BACK:
        k = BACK[m]
        return [(obs[i][0], 100 * (obs[i][1] / obs[i - k][1] - 1)) for i in range(k, len(obs)) if obs[i - k][1] > 0 and obs[i][1] > 0]
    if m == 'spread_vs':
        other = load(cfg['other'])
        out, j, ref = [], 0, None
        for d, v in obs:
            while j < len(other) and other[j][0] <= d:
                ref = other[j][1]; j += 1
            if ref is not None:
                out.append((d, v - ref))
        return out
    return None   # change since the shadow-run start has no history


def rates(vals, cfg):
    down = cfg.get('direction') == 'down'
    w, s = cfg['watch'], cfg['stress']
    if down:
        nw = sum(1 for v in vals if v <= w); ns = sum(1 for v in vals if v <= s)
    else:
        nw = sum(1 for v in vals if v >= w); ns = sum(1 for v in vals if v >= s)
    return 100 * nw / len(vals), 100 * ns / len(vals)


def pct(vals, q, down):
    v = sorted(vals)
    if down:
        return v[int(q * (len(v) - 1))]
    return v[int((1 - q) * (len(v) - 1))]


def main():
    path = os.path.join(ROOT, 'config', 'sentinels.json')
    conf = json.load(open(path))
    report = []
    for group in ('global_dollar', 'domestic', 'plumbing'):
        for sid, cfg in conf[group].items():
            if cfg.get('watch') is None:
                continue
            s = series(cfg, sid)
            if not s:
                continue
            pts = [(d, v) for d, v in s if d >= SINCE]
            vals = [v for _, v in pts]
            if len(vals) < 30:
                continue
            wr, sr = rates(vals, cfg)
            down = cfg.get('direction') == 'down'
            stress_dates = [d for d, v in pts if (v <= cfg['stress'] if down else v >= cfg['stress'])]
            row = {'id': sid, 'since': pts[0][0], 'readings': len(vals), 'watch_rate_pct': round(wr, 1),
                   'stress_rate_pct': round(sr, 1),
                   'stress_periods': sorted({d[:4] for d in stress_dates}),
                   'worst10': round(pct(vals, 0.10, down), 2), 'worst2': round(pct(vals, 0.02, down), 2)}
            report.append(row)
            if '--write' in sys.argv:
                cfg['calibration'] = {k: row[k] for k in ('since', 'readings', 'watch_rate_pct', 'stress_rate_pct', 'stress_periods')}
    for r in report:
        print(f"{r['id']:16} since {r['since']}  watch-or-worse {r['watch_rate_pct']:5.1f}%  stress {r['stress_rate_pct']:5.1f}%  "
              f"stress years {','.join(r['stress_periods']) or 'none'}" + (f"  | worst10% {r['worst10']}  worst2% {r['worst2']}" if '--suggest' in sys.argv else ''))
    if '--write' in sys.argv:
        json.dump(conf, open(path, 'w'), indent=2)
        open(path, 'a').write('\n')


if __name__ == '__main__':
    main()
