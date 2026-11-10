#!/usr/bin/env python3
"""Parse the parity matrix and enumerate all Partial-status rows (pipe-safe)."""
import re
from collections import defaultdict

PATH = "/home/z/my-project/docs/Fernly_HRMS_Feature_Parity_Matrix.md"


def split_cells(line: str):
    body = line.strip()
    if body.startswith("|"):
        body = body[1:]
    if body.endswith("|"):
        body = body[:-1]
    # split on unescaped pipes only
    parts = re.split(r"(?<!\\)\|", body)
    return [p.strip() for p in parts]


rows = []
status_counts = defaultdict(int)
section = ""
with open(PATH, encoding="utf-8") as f:
    for line in f:
        m = re.match(r"^### (\S+)", line)
        if m:
            section = m.group(1)
            continue
        m = re.match(r"^## (\S+)", line)
        if m:
            section = m.group(1)
            continue
        if line.startswith("|"):
            cells = split_cells(line)
            if len(cells) < 4:
                continue
            cid = cells[0]
            if not re.match(r"^[A-Z]{2}(-[A-Z0-9/]+|\d+)", cid):
                continue
            # status = first cell that is exactly a status word (bold
            # markdown stripped — census cells read "**Parity (…)"),
            st = None
            for c in cells[1:]:
                cc = c.replace("*", "").strip()
                if cc in ("Partial", "Missing", "Out of scope") or cc.startswith("Parity"):
                    st = cc
                    break
            if st is None:
                continue
            status_counts[st] += 1
            if st == "Partial":
                rows.append((cid, section, cells[1]))

print(f"TOTAL Partial rows: {len(rows)}")
print(f"Status totals: {dict(status_counts)}\n")
by_sec = defaultdict(list)
for rid, sec, art in rows:
    by_sec[sec].append(rid)
for sec in sorted(by_sec):
    print(f"{sec}: {len(by_sec[sec])} rows: {', '.join(by_sec[sec])}")
print()
print("=== Detail ===")
for rid, sec, art in rows:
    print(f"{rid}\t{sec}\t{art[:80]}")
