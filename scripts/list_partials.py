#!/usr/bin/env python3
"""List all Partial rows in the parity matrix with ID + short gap note."""
import re

SRC = "docs/Fernly_HRMS_Feature_Parity_Matrix.md"

def main() -> int:
    section = ""
    rows = []
    for line in open(SRC, encoding="utf-8"):
        m = re.match(r"^#{2,3}\s+(.*)$", line)
        if m:
            section = m.group(1).strip()
            continue
        if line.startswith("|"):
            cells = [c.strip() for c in line.strip().strip("|").split("|")]
            if len(cells) < 4:
                continue
            status = cells[3].replace("*", "").strip() if len(cells) > 3 else ""
            if status.startswith("Partial") and cells[0] not in ("ID", "---", ":---"):
                rows.append((section, cells[0], cells[1]))
    print(f"TOTAL Partial rows: {len(rows)}\n")
    cur = ""
    for sec, rid, name in rows:
        if sec != cur:
            cur = sec
            print(f"\n== {sec} ==")
        print(f"  {rid:14s} {name}")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
