#!/usr/bin/env python3
"""Independent decimal cross-check of the Phase 1 acceptance values.

Re-derives every acceptance-table figure from the FY2026-27 rates using
Python's decimal arithmetic (no shared code with the TS engine) so the
engine's test expectations are confirmed against first principles.
"""
from decimal import Decimal as D, ROUND_HALF_UP, ROUND_DOWN

def r2(x):  # decimal half-up to 2dp
    return D(x).quantize(D("0.01"), rounding=ROUND_HALF_UP)

TIERS = [(D(0), D(15600), D("0.105")), (D(15600), D(53500), D("0.175")),
         (D(53500), D(78100), D("0.30")), (D(78100), D(180000), D("0.33")),
         (D(180000), None, D("0.39"))]
LEVY_RATE, CAP, MAXLEVY = D("0.0175"), D(156641), D("2741.22")
SEC = {"SB": D("0.105"), "S": D("0.175"), "SH": D("0.30"), "ST": D("0.33"),
       "SA": D("0.39"), "ND": D("0.45")}
SL_RATE, SL_ANNUAL = D("0.12"), D(24128)
IETC = dict(amount=D(520), lo=D(24000), abate=D(66000), hi=D(70000), rate=D("0.13"))
PPY = {"WEEKLY": 52, "FORTNIGHTLY": 26, "BIMONTHLY": 24, "MONTHLY": 12,
       "QUARTERLY": 4, "ANNUAL": 1}

def slab(annual):
    tax = D(0)
    for lo, hi, rate in TIERS:
        top = annual if hi is None else min(annual, hi)
        if top > lo:
            tax += (top - lo) * rate
    return tax

def levy(gross, freq):
    return LEVY_RATE * min(D(gross), CAP / PPY[freq])

def primary(gross, freq, me=False):
    ppy = PPY[freq]
    annual = D(gross) * ppy
    t = slab(annual)
    c = D(0)
    if me:
        a = annual
        if a < IETC["lo"] or a >= IETC["hi"]:
            c = D(0)
        elif a <= IETC["abate"]:
            c = IETC["amount"]
        else:
            c = max(D(0), IETC["amount"] - (a - IETC["abate"]) * IETC["rate"])
    tax = r2((t - c) / ppy)
    acc = r2(levy(gross, freq))
    return tax, acc, r2(tax + acc), r2(c / ppy)

def flat(code, gross, freq):
    tax = r2(D(gross) * SEC[code])
    acc = r2(levy(gross, freq))
    return tax, acc, r2(tax + acc)

def sl(gross, freq, secondary=False, rate=SL_RATE, threshold=True):
    g = D(gross)
    if secondary or not threshold:
        return r2(g * rate)
    th = (SL_ANNUAL / PPY[freq]).quantize(D("0.01"), rounding=ROUND_DOWN)
    return r2(max(D(0), g - th) * rate)

cases = [
    ("M weekly 1000",        primary(1000, "WEEKLY"),        (D("154.00"), D("17.50"), D("171.50"))),
    ("M monthly 5000",       primary(5000, "MONTHLY"),       (D("851.71"), D("87.50"), D("939.21"))),
    ("M annual 15600",       primary(15600, "ANNUAL"),       (D("1638.00"), D("273.00"), D("1911.00"))),
    ("M annual 53500",       primary(53500, "ANNUAL"),       (D("8270.50"), D("936.25"), D("9206.75"))),
    ("M annual 78100",       primary(78100, "ANNUAL"),       (D("15650.50"), D("1366.75"), D("17017.25"))),
    ("M annual 156641",      primary(156641, "ANNUAL"),      (D("41569.03"), D("2741.22"), D("44310.25"))),
    ("M annual 200000",      primary(200000, "ANNUAL"),      (D("57077.50"), D("2741.22"), D("59818.72"))),
    ("SB weekly 1000",       flat("SB", 1000, "WEEKLY"),     (D("105.00"), D("17.50"), D("122.50"))),
    ("S monthly 3000",       flat("S", 3000, "MONTHLY"),     (D("525.00"), D("52.50"), D("577.50"))),
    ("ND monthly 5000",      flat("ND", 5000, "MONTHLY"),    (D("2250.00"), D("87.50"), D("2337.50"))),
    ("CAE weekly 1000",      flat("S", 1000, "WEEKLY"),      (D("175.00"), D("17.50"), D("192.50"))),
    ("IR341 M monthly 15000", primary(15000, "MONTHLY"),     (D("4106.46"), D("228.43"), D("4334.89"))),
    ("ME monthly 2000",      primary(2000, "MONTHLY", True), (D("215.67"), D("35.00"), D("250.67"))),
    ("M monthly 2000",       primary(2000, "MONTHLY"),       (D("259.00"), D("35.00"), D("294.00"))),
    ("M weekly 4000",        primary(4000, "WEEKLY"),        (D("1157.64"), D("52.72"), D("1210.36"))),
]

ok = True
for name, got, want in cases:
    match = got[:3] == want
    ok &= match
    print(f"{'PASS' if match else 'FAIL'}  {name:26s} tax={got[0]} acc={got[1]} total={got[2]}" + ("" if match else f"  WANT {want}"))

sl_cases = [
    ("M SL monthly 3000",      sl(3000, "MONTHLY"),                    D("118.72")),
    ("M SL weekly 500",        sl(500, "WEEKLY"),                      D("4.32")),
    ("S SL monthly 3000",      sl(3000, "MONTHLY", secondary=True),    D("360.00")),
    ("STC 8% main monthly 3000", sl(3000, "MONTHLY", rate=D("0.08")),  D("79.15")),
    ("STC 8% sec monthly 3000",  sl(3000, "MONTHLY", threshold=False, rate=D("0.08")), D("240.00")),
    ("STC 8% main monthly 5000", sl(5000, "MONTHLY", rate=D("0.08")),  D("239.15")),
    ("M SL monthly 2015",      sl(2015, "MONTHLY"),                    D("0.52")),
    ("M SL fortnightly 2000",  sl(2000, "FORTNIGHTLY"),                D("128.64")),
    ("M SL bimonthly 2000",    sl(2000, "BIMONTHLY"),                  D("119.36")),
]
for name, got, want in sl_cases:
    match = got == want
    ok &= match
    print(f"{'PASS' if match else 'FAIL'}  {name:26s} sl={got}" + ("" if match else f"  WANT {want}"))

# KiwiSaver / ESCT spot checks
def ks(gross, freq, er=D("0.035"), mr=D("0.035"), esct_tiers=None):
    emp = r2(D(gross) * er)
    mgl = r2(D(gross) * mr)
    annual = (D(gross) + mgl) * PPY[freq]
    if esct_tiers is None:
        esct_tiers = [(D(0), D(18720), D("0.105")), (D(18720), D(64200), D("0.175")),
                      (D(64200), D(93720), D("0.30")), (D(93720), D(216000), D("0.33")),
                      (D(216000), None, D("0.39"))]
    rate = D(0)
    for lo, hi, rt in esct_tiers:
        if annual <= (hi if hi is not None else D("Infinity")):
            rate = rt
            break
    esct = r2(mgl * rate)
    return emp, mgl, esct, r2(mgl - esct)

ks_cases = [
    ("KS weekly 1000 @3.5%",   ks(1000, "WEEKLY"),  (D("35.00"), D("35.00"), D("6.13"), D("28.87"))),
    ("KS monthly 5000 @3.5%",  ks(5000, "MONTHLY"), (D("175.00"), D("175.00"), D("30.63"), D("144.37"))),
    ("KS monthly 2000 @10%",   ks(2000, "MONTHLY", er=D("0.10")), (D("200.00"), D("70.00"), D("12.25"), D("57.75"))),
    ("KS monthly 5300 @3.5%",  ks(5300, "MONTHLY"), (D("185.50"), D("185.50"), D("55.65"), D("129.85"))),
]
for name, got, want in ks_cases:
    match = got == want
    ok &= match
    print(f"{'PASS' if match else 'FAIL'}  {name:26s} emp={got[0]} mgl={got[1]} esct={got[2]} net={got[3]}" + ("" if match else f"  WANT {want}"))

# IETC abatement
ietc_cases = [(23999, D(0)), (24000, D(520)), (66000, D(520)), (68000, D(260)), (70000, D(0))]
for a, want in ietc_cases:
    a = D(a)
    if a < IETC["lo"] or a >= IETC["hi"]:
        got = D(0)
    elif a <= IETC["abate"]:
        got = IETC["amount"]
    else:
        got = max(D(0), IETC["amount"] - (a - IETC["abate"]) * IETC["rate"])
    match = got == want
    ok &= match
    print(f"{'PASS' if match else 'FAIL'}  IETC @ {a:>7} = {got}" + ("" if match else f"  WANT {want}"))

# netPay for the flagship aggregate case
tax, acc, tot, _ = primary(5000, "MONTHLY")
emp, mgl, esct, mnet = ks(5000, "MONTHLY")
slv = sl(5000, "MONTHLY")
net = r2(D(5000) - tot - emp - slv)
print(f"{'PASS' if net == D('3527.07') else 'FAIL'}  M SL monthly 5000 netPay = {net} (want 3527.07)")
ok &= net == D("3527.07")

print("\nALL CROSS-CHECKS PASS" if ok else "\nSOME CROSS-CHECKS FAILED")
raise SystemExit(0 if ok else 1)
