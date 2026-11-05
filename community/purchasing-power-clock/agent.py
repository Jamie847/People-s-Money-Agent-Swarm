"""Example community agent: the purchasing-power clock.

Reads the public record from stdin, writes ONE JSON report to stdout. Plain Python 3, no packages.
Copy this folder to start your own agent (see community/README.md).
"""
import json, sys

ctx = json.load(sys.stdin)
cpi = ctx["inputs"]["CPI"]["observations"]          # [[date, value], ...] monthly, seasonally adjusted
by_date = dict(cpi)
last_date, last_value = cpi[-1]

def cents_today(start):
    """What a dollar from `start` buys at the latest reading, in cents."""
    if start not in by_date:
        return None
    return 100 * by_date[start] / last_value

findings = []
for label, start in [("A dollar saved in January 2000", "2000-01-01"),
                     ("A dollar saved in January 2020", "2020-01-01"),
                     ("A dollar saved at the shadow-run start (April 2026)", "2026-04-01")]:
    c = cents_today(start)
    if c is not None:
        findings.append({"label": label, "value": f"buys {c:.0f}¢ of goods today",
                         "note": f"CPI-U {by_date[start]:.3f} then vs {last_value:.3f} in {last_date[:7]}"})

c2000 = cents_today("2000-01-01")
report = {
    "status": "info",
    "headline": f"A dollar saved in January 2000 now buys about {c2000:.0f}¢ (CPI-U, {last_date[:7]})" if c2000 else "Not enough CPI history",
    "findings": findings,
}
print(json.dumps(report))
