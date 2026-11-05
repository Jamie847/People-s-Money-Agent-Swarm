#!/usr/bin/env python3
"""
Calculator C — and the "recompute it yourself" script.

Anyone can run this with plain Python 3 (no packages needed) to check the swarm's number:

    python3 scripts/recompute.py                      # latest live quarter, plain-language output
    python3 scripts/recompute.py --quarter 2026-Q3    # a specific quarter
    python3 scripts/recompute.py --epoch 2020-Q1 --quarter 2022-Q2 --json

It reads the archived raw files in data/inputs/ (exactly what the sensors downloaded, fingerprinted
in data/ledger.jsonl) and the parameters in config/rule.json. It prepares its own inputs and uses
high-precision decimal arithmetic, so it does not share code with calculators A and B.
"""
import argparse, csv, datetime, hashlib, json, os, sys
from decimal import Decimal, getcontext

getcontext().prec = 40
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def read_series(name, inputs_dir=None):
    path = os.path.join(inputs_dir or os.path.join(ROOT, 'data', 'inputs'), f'{name}.csv')
    with open(path, newline='') as f:
        rows = list(csv.reader(f))
    out = {}
    for r in rows[1:]:
        if len(r) < 2 or r[1].strip() in ('', '.'):
            continue
        out[r[0].strip()] = Decimal(r[1].strip())
    return out


def sha256_file(name, inputs_dir=None):
    path = os.path.join(inputs_dir or os.path.join(ROOT, 'data', 'inputs'), f'{name}.csv')
    with open(path, 'rb') as f:
        return hashlib.sha256(f.read()).hexdigest()


def parse_q(label):
    y, q = label.split('-Q')
    return int(y), int(q)


def months(y, q):
    return [f'{y}-{3 * (q - 1) + 1 + i:02d}-01' for i in range(3)]


def comp_date(y, q, day):
    m, yy = 3 * q + 2, y
    if m > 12:
        m, yy = m - 12, y + 1
    return f'{yy}-{m:02d}-{day:02d}'


def frozen_base(base_file, epoch):
    """The starting quarter's prices exactly as frozen in the live record."""
    with open(base_file) as f:
        hist = json.load(f)
    for h in hist:
        if h.get('quarter') == epoch and h.get('inputs'):
            b = h['inputs']['base']
            return [Decimal(repr(x)) for x in b['cpi']], [Decimal(repr(x)) for x in b['pce']]
    return None


def compute(epoch, quarter, rule, inputs_dir=None, base_file=None):
    cpi, pce, gdp_raw = read_series('CPI', inputs_dir), read_series('PCE', inputs_dir), read_series('GDP', inputs_dir)
    gdp = {int(k[:4]): v for k, v in gdp_raw.items()}
    ey, eq = parse_q(epoch)
    y, q = parse_q(quarter)
    cd = comp_date(y, q, rule['computation_day_of_second_month_after_quarter'])
    last_year = int(cd[:4]) - 1 if cd[5:] >= rule['annual_gdp_available_from_month_day'] else int(cd[:4]) - 2
    if last_year not in gdp:
        last_year = max(k for k in gdp if k <= last_year)

    def avg(series, ms):
        vals = [series[m] for m in ms]  # KeyError here means the data are incomplete
        return sum(vals) / Decimal(len(vals))

    hundred = Decimal(100)
    fb = frozen_base(base_file, epoch) if base_file else None
    base_cpi = sum(fb[0]) / Decimal(3) if fb else avg(cpi, months(ey, eq))
    base_pce = sum(fb[1]) / Decimal(3) if fb else avg(pce, months(ey, eq))
    gap_cpi = hundred * (avg(cpi, months(y, q)) / base_cpi).ln()
    gap_pce = hundred * (avg(pce, months(y, q)) / base_pce).ln()
    gap = (gap_cpi + gap_pce) / 2
    n = rule['trend_growth_years']
    growth = [hundred * (gdp[t] / gdp[t - 1] - 1) for t in range(last_year - n + 1, last_year + 1)]
    trend = sum(growth) / Decimal(len(growth))
    raw = trend - Decimal(str(rule['feedback_strength'])) * gap
    lo, hi = Decimal(str(rule['path_growth_floor_pct'])), Decimal(str(rule['path_growth_ceiling_pct']))
    allowance = min(hi, max(lo, raw))
    step = hundred * (((1 + allowance / hundred).ln() / 4).exp() - 1)
    return {
        'quarter': quarter, 'epoch': epoch, 'computation_date': cd,
        'gdp_years': [last_year - n, last_year],
        'trend_growth_pct': float(trend), 'gap_cpi_lp': float(gap_cpi), 'gap_pce_lp': float(gap_pce),
        'gap_lp': float(gap), 'allowance_raw_pct': float(raw), 'allowance_pct': float(allowance),
        'quarterly_step_pct': float(step),
        'input_sha256': {k: sha256_file(k, inputs_dir) for k in ('CPI', 'PCE', 'GDP')},
        'inputs_dir': os.path.relpath(inputs_dir, ROOT) if inputs_dir else 'data/inputs',
        'base': 'frozen starting quarter' if fb else 'read from data',
    }


def latest_live_quarter(rule):
    cpi, pce = read_series('CPI'), read_series('PCE')
    today = datetime.date.today().isoformat()
    y, q = parse_q(rule['live_epoch_quarter'])
    best = None
    while True:
        cd = comp_date(y, q, rule['computation_day_of_second_month_after_quarter'])
        if cd > today or not all(m in cpi and m in pce for m in months(y, q)):
            break
        best = f'{y}-Q{q}'
        y, q = (y + 1, 1) if q == 4 else (y, q + 1)
    return best


def main():
    with open(os.path.join(ROOT, 'config', 'rule.json')) as f:
        rule = json.load(f)
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--epoch', default=rule['live_epoch_quarter'])
    ap.add_argument('--quarter')
    ap.add_argument('--json', action='store_true')
    ap.add_argument('--inputs-dir', help='folder of CPI/PCE/GDP files (default: data/inputs)')
    ap.add_argument('--base-file', help='live-history.json holding the frozen starting quarter')
    a = ap.parse_args()
    inputs_dir, base_file, quarter = a.inputs_dir, a.base_file, a.quarter
    if not quarter:
        # Default: re-check the latest frozen live reading with exactly the data it used.
        hist_path = os.path.join(ROOT, 'data', 'live-history.json')
        hist = json.load(open(hist_path)) if os.path.exists(hist_path) else []
        done = [h for h in hist if h.get('available')]
        if done:
            last = done[-1]
            quarter = last['quarter']
            vdir = (last.get('data_vintage') or {}).get('dir')
            if vdir and not inputs_dir:
                inputs_dir = os.path.join(ROOT, vdir)
            if last.get('base_source') == 'frozen starting quarter' and not base_file:
                base_file = hist_path
        else:
            quarter = latest_live_quarter(rule)
    if not quarter:
        sys.exit('No completed live quarter yet.')
    try:
        r = compute(a.epoch, quarter, rule, inputs_dir, base_file)
    except KeyError as e:
        msg = {'error': f'incomplete data: {e}'}
        print(json.dumps(msg) if a.json else msg['error'])
        sys.exit(2)
    if a.json:
        print(json.dumps(r))
        return
    print(f"The People's Money rule, recomputed independently for {r['quarter']} (prices measured from {r['epoch']})")
    print(f"  Computation date ............ {r['computation_date']}")
    print(f"  Trend real growth ........... {r['trend_growth_pct']:.3f}% a year (real GDP, {r['gdp_years'][0]}-{r['gdp_years'][1]})")
    print(f"  Price gap ................... {r['gap_lp']:+.3f} log points (CPI-U {r['gap_cpi_lp']:+.3f}, PCE {r['gap_pce_lp']:+.3f})")
    print(f"  Path growth allowed ......... {r['allowance_pct']:.3f}% a year (unclamped {r['allowance_raw_pct']:.3f}%)")
    print(f"  Quarterly step .............. {r['quarterly_step_pct']:.4f}%")
    print(f"  Data used ................... {r['inputs_dir']} (starting prices: {r['base']})")
    print('  Input fingerprints (SHA-256):')
    for k, v in r['input_sha256'].items():
        print(f'    {k}: {v}')
    print('Compare these with data/latest.json or the dashboard. They should match.')


if __name__ == '__main__':
    main()
