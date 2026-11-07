#!/usr/bin/env python3
"""Module rollup for the Fernly x Frappe HR feature parity matrix.

Counts every row of docs/Fernly_HRMS_Feature_Parity_Matrix.md per target
logic module (hr / admin / account / joining), using the default
domain->module mapping plus the row-level exceptions recorded in
docs/Fernly_Domain_Modules_Architecture_Plan.md (section 5).

Reproduction:

    python3 scripts/module_rollup.py [path/to/Fernly_HRMS_Feature_Parity_Matrix.md]

Prints a Markdown rollup table (module x status) plus a sanity check
against the totals documented in the matrix section 10.
"""

from __future__ import annotations

import re
import sys
from collections import Counter

# Default assignment: matrix domain prefix -> logic module.
DEFAULTS = {
    "PR": "account",  # payroll domain
    "LV": "hr",       # leave & holidays
    "AT": "hr",       # attendance & shifts
    "EM": "hr",       # employee lifecycle
    "RJ": "joining",  # recruitment & joining
    "PF": "hr",       # performance & training
    "EX": "account",  # expenses, travel & money (grievance -> hr, below)
    "PL": "admin",    # platform surfaces
}

# Row-level exceptions (architecture plan section 5). Keys are exact row IDs.
EXCEPTIONS = {
    # Employee-lifecycle rows that belong to the Joining arc.
    "EM-11": "joining",   # Employee Onboarding
    "EM-12": "joining",   # Employee Onboarding Template
    "EM-13": "joining",   # onboarding gate on employee creation
    "EM-B05": "joining",  # onboarding task dates pushed off holidays
    "EM-B06": "joining",  # task assignee = user XOR role
    "EM-B07": "joining",  # boarding_status derived from facts
    "EM-B08": "joining",  # creation gated on required tasks
    "EM-B09": "joining",  # creation back-flips applicant/offer
    "EM-17": "joining",   # Employee Referral
    # Employee-lifecycle rows that belong to Account (full-and-final).
    "EM-16": "account",   # Full and Final Statement
    "EM-B12": "account",  # FnF auto-assemble payables/receivables
    "EM-B13": "account",  # FnF asset reconstruction (declined)
    "EM-B14": "account",  # FnF settlement gate
    # Employee-lifecycle rows that belong to Admin (platform singles).
    "EM-23": "admin",     # HR Settings
    "EM-24": "admin",     # HR Telemetry (declined)
    "EM-25": "admin",     # PWA Notification store (declined)
    # Payroll row that belongs to Admin (settings single).
    "PR-32": "admin",     # Payroll Settings
    # Expense row that belongs to HR.
    "EX-06": "hr",        # Employee Grievance
    # Platform rows with a domain home.
    "PL-08": "hr",        # roster app + roster API (shift planning)
    "PL-13": "joining",   # job_application web form (public intake)
}

ROW_RE = re.compile(r"^\|\s*([A-Z]{2}-[A-Za-z0-9\-/\u2013]+)\s*\|")

# A status cell begins with one of these (after stripping markdown bold).
STATUS_MATCHERS: list[tuple[str, re.Pattern[str]]] = [
    ("beyond", re.compile(r"^beyond benchmark", re.I)),
    ("parity", re.compile(r"^parity", re.I)),
    ("oos", re.compile(r"^out of scope", re.I)),
    ("partial", re.compile(r"^partial", re.I)),
    ("missing", re.compile(r"^missing", re.I)),
]


def classify_status(cells: list[str]) -> str:
    """Return the status of a table row from its cells.

    The status column position varies across the matrix's table shapes
    (4th or 5th column), so the first cell that *begins* with a status
    keyword wins. Cells from other columns never begin with one.
    """
    for cell in cells:
        text = cell.replace("*", "").strip()
        for name, rx in STATUS_MATCHERS:
            if rx.match(text):
                return name
    return "unknown"


def main(path: str) -> int:
    rows: list[tuple[str, str, str, str]] = []
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            m = ROW_RE.match(line)
            if not m:
                continue
            row_id = m.group(1)
            cells = [c.strip() for c in line.strip().strip("|").split("|")]
            status = classify_status(cells)
            domain = row_id[:2]
            module = EXCEPTIONS.get(row_id, DEFAULTS.get(domain))
            rows.append((row_id, domain, module or "?", status))

    unknown = [r for r in rows if r[3] == "unknown" or r[2] == "?"]
    if unknown:
        print("UNCLASSIFIED ROWS (fix the parser or the mapping):")
        for row_id, domain, module, status in unknown:
            print(f"  {row_id} domain={domain} module={module} status={status}")
        return 1

    overall = Counter(r[3] for r in rows)
    per_module: dict[str, Counter[str]] = {}
    for _, _, module, status in rows:
        per_module.setdefault(module, Counter())[status] += 1

    statuses = ["parity", "partial", "missing", "oos", "beyond"]
    labels = {
        "parity": "Parity",
        "partial": "Partial",
        "missing": "Missing",
        "oos": "Out of scope",
        "beyond": "Beyond",
    }
    print(f"Total rows parsed: {len(rows)}\n")
    header = "| Module | " + " | ".join(labels[s] for s in statuses) + " | Total |"
    print(header)
    print("| --- | " + " | ".join("---" for _ in statuses) + " | --- |")
    for module in ["hr", "admin", "account", "joining"]:
        c = per_module.get(module, Counter())
        total = sum(c.values())
        cells = " | ".join(str(c[s]) for s in statuses)
        print(f"| `{module}` | {cells} | {total} |")
    total_row = " | ".join(str(overall[s]) for s in statuses)
    print(f"| **Total** | {total_row} | **{sum(overall.values())}** |")

    documented = {"parity": 31, "partial": 84, "missing": 161, "oos": 37, "beyond": 1}
    ok = all(overall[s] == documented[s] for s in statuses)
    print()
    print("Matrix section-10 sanity check:", "PASS" if ok else "FAIL")
    if not ok:
        for s in statuses:
            if overall[s] != documented[s]:
                print(f"  {s}: parsed {overall[s]} vs documented {documented[s]}")
    return 0 if ok else 2


if __name__ == "__main__":
    matrix = sys.argv[1] if len(sys.argv) > 1 else "docs/Fernly_HRMS_Feature_Parity_Matrix.md"
    sys.exit(main(matrix))
