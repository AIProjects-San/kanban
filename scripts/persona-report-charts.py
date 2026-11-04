#!/usr/bin/env python3
"""Charts for the Fernly persona acceptance assessment report (English labels)."""
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import os

OUT = "/home/z/my-project/scripts/persona-report-assets"
os.makedirs(OUT, exist_ok=True)

# MIN-1 Warm Gold palette (docx design-system) — keep charts on-brand
GOLD = "#D6C096"
DARK = "#1A1A1A"
MID = "#8A8273"
RED = "#B4552D"      # warm terracotta for NO-BUY
AMBER = "#C9A227"    # for HOLD
GREEN = "#5F7A50"    # for BUY
GRID = "#DDD8CC"

plt.rcParams["font.family"] = "DejaVu Sans"
plt.rcParams["axes.unicode_minus"] = False

# ---------------------------------------------------------------- Chart 1
# Verdict distribution across the rated persona panel (11 rated, QA = findings-only)
fig, ax = plt.subplots(figsize=(7.2, 2.9), constrained_layout=True)
cats = ["BUY", "HOLD", "NO-BUY"]
vals = [0, 5, 6]
colors = [GREEN, AMBER, RED]
bars = ax.barh(cats, vals, color=colors, height=0.55)
for b, v in zip(bars, vals):
    ax.text(v + 0.08, b.get_y() + b.get_height() / 2, str(v),
            va="center", ha="left", fontsize=12, color=DARK, fontweight="bold")
ax.set_xlim(0, 7.5)
ax.set_xlabel("Personas of 11 rated. BUY = does the job; HOLD = usable, competitor better; NO-BUY = core job broken or missing.\nThe QA persona contributes defect findings rather than a buy decision.", fontsize=8.5, color=DARK)
ax.set_title("Would the panel's companies pay for Fernly?",
             fontsize=11, color=DARK, fontweight="bold", loc="left")
ax.tick_params(axis="y", labelsize=9, colors=DARK)
ax.tick_params(axis="x", labelsize=8, colors=MID)
ax.invert_yaxis()
for s in ["top", "right"]:
    ax.spines[s].set_visible(False)
for s in ["left", "bottom"]:
    ax.spines[s].set_color(GRID)
ax.set_facecolor("white")
fig.savefig(f"{OUT}/chart-verdicts.png", dpi=200, facecolor="white")
plt.close(fig)

# ---------------------------------------------------------------- Chart 2
# Assessed capability coverage vs market baseline (Keka / Zoho People / greytHR / Rippling)
areas = [
    "Candidate pipeline & stages",
    "Interviews & scorecards",
    "Offers & e-signature",
    "Onboarding workflow",
    "Payroll mechanics",
    "Employee self-service",
    "Candidate communication",
    "Reporting & analytics",
    "Statutory & compliance",
    "Platform (API, SSO, integrations)",
]
coverage = [80, 65, 60, 45, 50, 25, 20, 30, 5, 15]

fig, ax = plt.subplots(figsize=(7.2, 4.4), constrained_layout=True)
colors2 = [GOLD if v >= 50 else (AMBER if v >= 25 else RED) for v in coverage]
bars = ax.barh(areas, coverage, color=colors2, height=0.62)
for b, v in zip(bars, coverage):
    ax.text(v + 1.2, b.get_y() + b.get_height() / 2, f"{v}%",
            va="center", ha="left", fontsize=9, color=DARK, fontweight="bold")
ax.set_xlim(0, 100)
ax.set_xlabel("Assessed coverage of market-standard capability (%) — assessor judgment, not vendor data.\nStatutory coverage is assessed against the India CTC design basis.",
              fontsize=8.5, color=DARK)
ax.set_title("Capability coverage vs market baseline", fontsize=11, color=DARK,
             fontweight="bold", loc="left")
ax.tick_params(axis="y", labelsize=9, colors=DARK)
ax.tick_params(axis="x", labelsize=8, colors=MID)
ax.invert_yaxis()
for s in ["top", "right"]:
    ax.spines[s].set_visible(False)
for s in ["left", "bottom"]:
    ax.spines[s].set_color(GRID)
ax.set_facecolor("white")
fig.savefig(f"{OUT}/chart-coverage.png", dpi=200, facecolor="white")
plt.close(fig)

print("charts written to", OUT)
