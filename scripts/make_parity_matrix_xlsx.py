#!/usr/bin/env python3
"""Build the 309-feature parity matrix workbook from the matrix doc.

Parses docs/Fernly_HRMS_Feature_Parity_Matrix.md (the sweep's own ledger,
post-P36) and the P16-P36 sweep table from the enhancement plan, then emits
a two-sheet xlsx: the full feature matrix (filterable, status color-coded)
and the census (status totals, per-domain pivot, the sweep ledger).
"""
import re
import sys
import os

XLSX_SKILL_DIR = "/home/z/my-project/skills/xlsx"
for sub in [XLSX_SKILL_DIR, os.path.join(XLSX_SKILL_DIR, "templates")]:
    if sub not in sys.path:
        sys.path.insert(0, sub)

from base import (  # noqa: E402
    setup_sheet, style_header_row, style_data_row, style_total_row,
    font_title, font_header, font_body, font_subheader, font_caption,
    fill_header, fill_total, align_header, align_text, align_number,
    auto_fit_columns, FONT_NAME,
    ACCENT_POSITIVE, ACCENT_NEGATIVE, ACCENT_WARNING, NEUTRAL_600, PRIMARY,
)
from openpyxl import Workbook  # noqa: E402
from openpyxl.styles import Font, PatternFill, Alignment  # noqa: E402
from openpyxl.utils import get_column_letter  # noqa: E402

MATRIX_DOC = "/home/z/my-project/docs/Fernly_HRMS_Feature_Parity_Matrix.md"
PLAN_DOC = "/home/z/my-project/docs/Fernly_HR_Payroll_Enhancement_Plan.md"
OUT_PATH = "/home/z/my-project/download/Fernly_HRMS_Feature_Parity_Matrix_309.xlsx"

DOMAIN_NAMES = {
    "PR": "Payroll",
    "LV": "Leave & Holidays",
    "AT": "Attendance & Shifts",
    "EM": "Employee Lifecycle",
    "RJ": "Recruitment & Joining",
    "PF": "Performance & Training",
    "EX": "Expenses, Travel & Grievance",
    "PL": "Platform",
}

STATUS_VOCAB = ("Partial", "Missing", "Out of scope")


def split_cells(line: str):
    body = line.strip()
    if body.startswith("|"):
        body = body[1:]
    if body.endswith("|"):
        body = body[:-1]
    parts = re.split(r"(?<!\\)\|", body)
    return [p.strip() for p in parts]


def clean(text: str) -> str:
    """Markdown → plain text (bold, backticks kept readable)."""
    t = text.replace("**", "").replace("`", "")
    t = re.sub(r"\s+", " ", t).strip()
    return t


def parse_matrix():
    rows = []
    section = ""
    with open(MATRIX_DOC, encoding="utf-8") as f:
        for line in f:
            m = re.match(r"^### (\S+)\s*(.*)", line)
            if m:
                section = f"{m.group(1)} {m.group(2)}".strip()
                continue
            m = re.match(r"^## (\S+)\s*(.*)", line)
            if m:
                section = f"{m.group(1)} {m.group(2)}".strip()
                continue
            if not line.startswith("|"):
                continue
            cells = split_cells(line)
            if not cells:
                continue
            cid = cells[0]
            if not re.match(r"^[A-Z]{2}-[A-Z0-9]", cid):
                continue
            # status = first cell that is a status word (bold stripped);
            # prefix matching catches the census's qualified statuses
            # ("Missing (cheap win…)", "Partial (was Missing)", "Out of
            # scope (flat by design)", compound "Out of scope / Missing")
            status_idx = None
            status = None
            for i, c in enumerate(cells[1:], start=1):
                cc = c.replace("*", "").strip()
                if cc.startswith(("Partial", "Missing", "Out of scope", "Parity", "Beyond benchmark")):
                    status_idx = i
                    status = cc
                    break
            if status_idx is None:
                rows.append({"id": cid, "section": section, "unparsed": True,
                            "artifact": clean(cells[1]) if len(cells) > 1 else ""})
                continue
            surface = cells[status_idx - 1] if status_idx >= 2 else ""
            family = cells[status_idx + 1] if status_idx + 1 < len(cells) else ""
            rows.append({
                "id": cid,
                "section": section,
                "unparsed": False,
                "artifact": clean(cells[1]) if len(cells) > 1 else "",
                "surface": clean(surface),
                "status": status,
                "family": clean(family),
            })
    return rows


def bucket_of(status: str) -> str:
    if status.startswith("Parity+"):
        return "Parity"
    if status.startswith("Parity"):
        return "Parity"
    if status.startswith("Beyond benchmark"):
        return "Beyond benchmark"
    if status.startswith("Partial"):
        return "Partial"
    if status.startswith("Missing"):
        return "Missing"
    if status.startswith("Out of scope"):
        return "Out of scope"
    return "Unknown"


def parse_sweep_ledger():
    """P16-P36 rows from the enhancement plan's §7.2.2 table only."""
    entries = []
    in_722 = False
    with open(PLAN_DOC, encoding="utf-8") as f:
        for line in f:
            if line.startswith("### 7.2.2"):
                in_722 = True
                continue
            if in_722 and line.startswith("### 7.3"):
                break
            if not in_722:
                continue
            m = re.match(r"^\| P(\d+) \|", line)
            if m:
                cells = split_cells(line)
                if len(cells) >= 3:
                    num = int(m.group(1))
                    rows_closed = clean(cells[1])
                    item = clean(cells[2])
                    done = item.startswith("DONE")
                    entries.append((num, rows_closed, done, item))
    return [e for e in entries if 16 <= e[0] <= 36]


STATUS_FILLS = {
    "Parity": PatternFill("solid", fgColor="E8F5E9"),
    "Partial": PatternFill("solid", fgColor="FFF4E5"),
    "Missing": PatternFill("solid", fgColor="FDEDEC"),
    "Out of scope": PatternFill("solid", fgColor="EFEFEF"),
    "Beyond benchmark": PatternFill("solid", fgColor="E7F0FA"),
    "Unknown": PatternFill("solid", fgColor="FFFFFF"),
}
STATUS_FONTS = {
    "Parity": Font(name=FONT_NAME, color=ACCENT_POSITIVE, bold=True),
    "Partial": Font(name=FONT_NAME, color=ACCENT_WARNING, bold=True),
    "Missing": Font(name=FONT_NAME, color=ACCENT_NEGATIVE, bold=True),
    "Out of scope": Font(name=FONT_NAME, color=NEUTRAL_600, bold=True),
    "Beyond benchmark": Font(name=FONT_NAME, color=PRIMARY, bold=True),
    "Unknown": Font(name=FONT_NAME, bold=True),
}


def build_matrix_sheet(ws, rows):
    headers = ["#", "ID", "Domain", "Section", "Benchmark feature (Frappe HRMS)",
               "Fernly surface", "Status", "Family / epic"]
    setup_sheet(ws, title="Fernly HRMS Feature Parity Matrix — the full feature table (post-P36, 2026-11-11)", last_col=2 + len(headers) - 1)
    header_row = 4
    for i, h in enumerate(headers, start=2):
        ws.cell(row=header_row, column=i, value=h)
    style_header_row(ws, header_row, 2, 2 + len(headers) - 1)

    r = header_row + 1
    for idx, row in enumerate(rows, start=1):
        b = bucket_of(row.get("status", ""))
        values = [
            idx,
            row["id"],
            DOMAIN_NAMES.get(row["id"][:2], row["id"][:2]),
            row["section"],
            row["artifact"],
            row.get("surface", ""),
            row.get("status", ""),
            row.get("family", ""),
        ]
        for ci, v in enumerate(values, start=2):
            ws.cell(row=r, column=ci, value=v)
        style_data_row(ws, r, 2, 2 + len(headers) - 1, idx - 1)
        # status column styling (color-coded by bucket)
        sc = ws.cell(row=r, column=2 + 6)
        sc.fill = STATUS_FILLS.get(b, PatternFill("solid", fgColor="FFFFFF"))
        sc.font = STATUS_FONTS.get(b, font_body())
        sc.alignment = Alignment(horizontal="left", vertical="center", wrap_text=True)
        # long text columns: wrap + top alignment
        for col in (2 + 4, 2 + 5, 2 + 7):
            ws.cell(row=r, column=col).alignment = Alignment(horizontal="left", vertical="top", wrap_text=True)
        ws.cell(row=r, column=2).alignment = align_number()
        r += 1
    last = r - 1
    ws.auto_filter.ref = f"B{header_row}:I{last}"
    ws.freeze_panes = f"D{header_row + 1}"
    widths = {"B": 6, "C": 9, "D": 16, "E": 34, "F": 52, "G": 80, "H": 34, "I": 26}
    for col, w in widths.items():
        ws.column_dimensions[col].width = w
    return last


def build_census_sheet(ws, rows, ledger):
    setup_sheet(ws, title="Census — status totals, domain pivot, sweep ledger", last_col=8)
    from collections import Counter, defaultdict

    buckets = Counter(bucket_of(r.get("status", "Unknown")) for r in rows)
    total_rows = len(rows)

    # --- Status totals block ---
    ws.cell(row=4, column=2, value="Status totals (rows parsed from the matrix doc)")
    ws.cell(row=4, column=2).font = font_subheader()
    hdr = 5
    for ci, h in enumerate(["Bucket", "Rows", "Share"], start=2):
        ws.cell(row=hdr, column=ci, value=h)
    style_header_row(ws, hdr, 2, 4)
    order = ["Parity", "Partial", "Missing", "Out of scope", "Beyond benchmark", "Unknown"]
    r = hdr + 1
    for i, b in enumerate(order):
        n = buckets.get(b, 0)
        ws.cell(row=r, column=2, value=b)
        ws.cell(row=r, column=3, value=n)
        ws.cell(row=r, column=4, value=(round(n / total_rows, 4) if total_rows else 0))
        style_data_row(ws, r, 2, 4, i)
        ws.cell(row=r, column=2).fill = STATUS_FILLS.get(b, PatternFill("solid", fgColor="FFFFFF"))
        ws.cell(row=r, column=2).font = STATUS_FONTS.get(b, font_body())
        ws.cell(row=r, column=3).alignment = align_number()
        ws.cell(row=r, column=4).number_format = "0.0%"
        ws.cell(row=r, column=4).alignment = align_number()
        r += 1
    style_total_row(ws, r, 2, 4)
    ws.cell(row=r, column=2, value="Total rows in the matrix table")
    ws.cell(row=r, column=3, value=total_rows)
    ws.cell(row=r, column=4, value=1.0)
    ws.cell(row=r, column=4).number_format = "0.0%"
    ws.cell(row=r, column=3).alignment = align_number()
    ws.cell(row=r, column=4).alignment = align_number()

    # --- The sweep's census ledger note ---
    note_r = r + 2
    ws.cell(row=note_r, column=2,
            value=("The sweep ledger's counted convention: 309 feature rows counted "
                   "(the raw table carries 314 multi-item rows — split/compound rows reconcile the two). "
                   "Post-P36 census (2026-11-11): 126 Parity · 47 Partial · 100 Missing · 36 Out of scope. "
                   "P35 closed EM-12/EM-B06/EM-11/EM-14/EM-B05 — onboarding/separation template depth: the "
                   "user-XOR-role assignee (a pinned user or a role KEY — every holder sees and ticks the "
                   "task; the manager pass skips role rows), the per-task required flag "
                   "(required_for_employee_creation riding the instantiation onto the task rows with the "
                   "checklist's requiredOpen counter), the holiday-aware due dates (OnboardingChecklist.startDate "
                   "— HR-pinnable, profile hireDate/lastWorkingDay/today — anchoring addWorkingDays: weekends + "
                   "full holiday-calendar entries skipped, half-days count), and the DERIVED boarding status "
                   "(checklistCompletion: done/total/percent + NOT_STARTED|IN_PROGRESS|COMPLETE + requiredOpen, "
                   "computed per read, never stored). P34 before it closed EM-03 — Partial → Parity — the "
                   "employee grouping axes: grade (free-form ladder, "
                   "the Employee Grade master stays EM-09's later epic) + employmentType (the controlled vocabulary "
                   "FULL_TIME/PART_TIME/CONTRACT/INTERN/CONSULTANT) + branch (plain string) as HR-owned EmployeeProfile "
                   "facts (QA-19 \"\" = unclassified), the directory's four filter chips (department + the three axes) "
                   "as the org-slicing surface, the roster card / settings strip / CSV export carrying the facts, and "
                   "grade registered in the P33 property-history registry (a promotion moves the ladder). "
                   "P36 closed EM-21 — Partial → Parity — employee identification documents: the DocumentTypeConfig scope axis (CANDIDATE joining formalities | EMPLOYEE identification types) + the EmployeeDocument lifecycle (REQUESTED→RECEIVED→VERIFIED|REJECTED, the member submits their own row from Settings, request/verify/reject stay hr:admin, the directory ID panel + summary line), with the joining gate pinned to CANDIDATE-scope mandatory types only. Next sweep head: P37 (skill master + employee skill maps — EM-19, PF-07, EM-18)."))
    ws.cell(row=note_r, column=2).font = font_caption()
    ws.merge_cells(start_row=note_r, start_column=2, end_row=note_r, end_column=8)
    ws.cell(row=note_r, column=2).alignment = Alignment(horizontal="left", vertical="top", wrap_text=True)
    ws.row_dimensions[note_r].height = 58

    # --- Per-domain pivot ---
    pivot_start = note_r + 2
    ws.cell(row=pivot_start, column=2, value="Rows by domain × status")
    ws.cell(row=pivot_start, column=2).font = font_subheader()
    domains = ["PR", "LV", "AT", "EM", "RJ", "PF", "EX", "PL"]
    hdr2 = pivot_start + 1
    ws.cell(row=hdr2, column=2, value="Domain")
    ws.cell(row=hdr2, column=3, value="Scope")
    for ci, b in enumerate(order, start=4):
        ws.cell(row=hdr2, column=ci, value=b)
    ws.cell(row=hdr2, column=4 + len(order), value="Total")
    style_header_row(ws, hdr2, 2, 4 + len(order))
    per = defaultdict(Counter)
    for row in rows:
        per[row["id"][:2]][bucket_of(row.get("status", "Unknown"))] += 1
    r = hdr2 + 1
    for i, d in enumerate(domains):
        ws.cell(row=r, column=2, value=DOMAIN_NAMES[d])
        ws.cell(row=r, column=3, value=d)
        rowtot = 0
        for ci, b in enumerate(order, start=4):
            n = per[d].get(b, 0)
            rowtot += n
            ws.cell(row=r, column=ci, value=n)
            ws.cell(row=r, column=ci).alignment = align_number()
        ws.cell(row=r, column=4 + len(order), value=rowtot)
        ws.cell(row=r, column=4 + len(order)).alignment = align_number()
        style_data_row(ws, r, 2, 4 + len(order), i)
        # re-apply number alignment after styling
        for ci in range(4, 6 + len(order)):
            ws.cell(row=r, column=ci).alignment = align_number()
        r += 1
    style_total_row(ws, r, 2, 4 + len(order))
    ws.cell(row=r, column=2, value="Total")
    for ci, b in enumerate(order, start=4):
        ws.cell(row=r, column=ci, value=buckets.get(b, 0))
        ws.cell(row=r, column=ci).alignment = align_number()
    ws.cell(row=r, column=4 + len(order), value=total_rows)
    ws.cell(row=r, column=4 + len(order)).alignment = align_number()

    # --- Sweep ledger P16-P36 ---
    sweep_start = r + 2
    ws.cell(row=sweep_start, column=2, value="§7.2.2 Partial Residual Sweep — the P16–P36 ledger")
    ws.cell(row=sweep_start, column=2).font = font_subheader()
    hdr3 = sweep_start + 1
    for ci, h in enumerate(["Item", "Rows closed", "Status", "Scope (condensed)"], start=2):
        ws.cell(row=hdr3, column=ci, value=h)
    style_header_row(ws, hdr3, 2, 5)
    r = hdr3 + 1
    for i, (num, rows_closed, done, item) in enumerate(ledger):
        ws.cell(row=r, column=2, value=f"P{num}")
        ws.cell(row=r, column=3, value=rows_closed)
        ws.cell(row=r, column=4, value="DONE" if done else "open")
        condensed = item if len(item) <= 220 else item[:217] + "…"
        ws.cell(row=r, column=5, value=condensed)
        style_data_row(ws, r, 2, 5, i)
        ws.cell(row=r, column=5).alignment = Alignment(horizontal="left", vertical="top", wrap_text=True)
        stc = ws.cell(row=r, column=4)
        stc.font = Font(name=FONT_NAME, color=ACCENT_POSITIVE if done else ACCENT_WARNING, bold=True)
        r += 1
    for col, w in {"B": 22, "C": 26, "D": 10, "E": 40, "F": 13, "G": 13, "H": 15, "I": 13, "J": 13, "K": 13}.items():
        ws.column_dimensions[col].width = w
    return r


def main():
    rows = parse_matrix()
    unparsed = [r for r in rows if r.get("unparsed")]
    print(f"parsed rows: {len(rows)}  (unparsed-status rows: {len(unparsed)})")
    for u in unparsed:
        print("  UNPARSED:", u["id"], u["artifact"][:70])

    ledger = parse_sweep_ledger()
    print(f"sweep ledger entries P16-P36: {len(ledger)}")

    wb = Workbook()
    ws1 = wb.active
    ws1.title = "Feature Matrix"
    last1 = build_matrix_sheet(ws1, rows)
    print(f"matrix sheet rows written: {last1 - 4}")

    ws2 = wb.create_sheet("Census")
    build_census_sheet(ws2, rows, ledger)

    wb.properties.creator = "Z.ai"
    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    wb.save(OUT_PATH)
    print("saved:", OUT_PATH)


if __name__ == "__main__":
    main()
