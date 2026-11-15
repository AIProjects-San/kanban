#!/usr/bin/env python3
"""Extract every matrix row (ID, status, family) handling escaped pipes.

Outputs the full Partial inventory with the Fernly-surface cell (which names
what's missing / remaining) so it can drive the implementation backlog.
"""
import re

DOC = "/home/z/my-project/docs/Fernly_HRMS_Feature_Parity_Matrix.md"

with open(DOC, encoding="utf-8") as f:
    raw = f.read().splitlines()

def split_cells(line):
    # split on unescaped pipes only
    parts = []
    cur = []
    for ch in line:
        if ch == "|":
            if cur and cur[-1] == "\\":
                cur.pop()  # escaped pipe: keep literal | in the cell
                cur.append("|")
            else:
                parts.append("".join(cur))
                cur = []
        else:
            cur.append(ch)
    parts.append("".join(cur))
    if parts and parts[0].strip() == "":
        parts = parts[1:]
    if parts and parts[-1].strip() == "":
        parts = parts[:-1]
    return parts

def tables():
    buf = []
    for line in raw:
        if line.lstrip().startswith("|"):
            buf.append(line)
        else:
            if buf:
                yield buf
            buf = []
    if buf:
        yield buf

rows = []
for tbl in tables():
    header = split_cells(tbl[0].strip())
    header = [c.strip() for c in header]
    if "Status" not in header:
        continue
    status_idx = header.index("Status")
    for line in tbl[2:]:
        cells = [c.strip() for c in split_cells(line.strip())]
        if len(cells) <= status_idx:
            continue
        rid = cells[0]
        status = cells[status_idx]
        if not rid or rid in ("ID", "---", "—", "**Partial**", "**Parity**", "**Missing**", "**Out of scope**", "**Beyond benchmark**"):
            continue
        fam = cells[-1] if len(cells) > status_idx + 1 else ""
        rows.append((rid, status, fam, line))

def base_status(s):
    s = s.replace("**", "")
    s = re.sub(r"\s*\([^)]*\)", "", s)
    return s.strip()

from collections import Counter
c = Counter(base_status(r[1]) for r in rows)
print("STATUS CENSUS (parsed rows: %d):" % len(rows))
for k, v in c.most_common():
    print(f"  {k}: {v}")

partials = [r for r in rows if base_status(r[1]) == "Partial"]
print(f"\n===== PARTIAL ROWS: {len(partials)} =====")
for rid, status, fam, line in partials:
    print(f"{rid}\t[{status.strip('*')}]")

# also dump full detail to a file for planning
with open("/home/z/my-project/scripts/partial-rows.txt", "w", encoding="utf-8") as out:
    for rid, status, fam, line in partials:
        cells = [c.strip() for c in split_cells(line.strip())]
        out.write(f"### {rid} | status: {status} | family: {fam}\n")
        for h, cell in zip(["ID", "artifact", "features", "fernly", "status", "family"], cells):
            out.write(f"  [{h}] {cell}\n")
        out.write("\n")
print("\nfull detail -> scripts/partial-rows.txt")
