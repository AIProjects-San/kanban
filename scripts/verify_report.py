#!/usr/bin/env python3
"""Verify docs/Fernly_HR_Payroll_Enhancement_Plan.md: matrix counts, placeholders, headings."""
import re
from pathlib import Path

p = Path("/home/z/my-project/docs/Fernly_HR_Payroll_Enhancement_Plan.md")
text = p.read_text(encoding="utf-8")
lines = text.splitlines()

# 1. Matrix row counts (rows like | P1 | ... | **Partial** |)
status_re = re.compile(r"^\|\s*([A-Z]+\d+)\s*\|.*\|\s*\*\*(Parity|Partial|Missing|Out of scope)\*\*\s*\|\s*$")
counts = {}
rows = 0
bad_rows = []
for line in lines:
    m = status_re.match(line)
    if m:
        rows += 1
        counts[m.group(2)] = counts.get(m.group(2), 0) + 1
    elif re.match(r"^\|\s*[A-Z]+\d+\s*\|", line) and "|" in line[1:]:
        # a numbered feature row that failed the status pattern
        if not line.startswith("| #") and "---" not in line:
            bad_rows.append(line[:80])

print(f"Matrix rows counted: {rows}")
for k in ("Parity", "Partial", "Missing", "Out of scope"):
    print(f"  {k}: {counts.get(k, 0)}")
print(f"  Sum: {sum(counts.values())}")
if bad_rows:
    print("Rows with UNRECOGNIZED status cell:")
    for b in bad_rows:
        print("   ", b)

# 2. Cross-check vs the summary table in section 6.2
summary = re.findall(r"\|\s*(Parity|Partial|Missing|Out of scope \(deliberate\))\s*\|\s*(\d+)\s*\|", text)
print("\nSection 6.2 summary table says:", summary)

# 3. Placeholder scan
bad_patterns = ["XXX", "TODO", "TBD", "待补充", "【", "____", "undefined", "NaN", "Lorem"]
found = {pat: text.count(pat) for pat in bad_patterns if text.count(pat) > 0}
print("\nPlaceholder scan:", found if found else "clean")

# 4. Heading structure
print("\nHeadings:")
for line in lines:
    if re.match(r"^#{1,3} ", line):
        print("  ", line[:90])

# 5. Ensure claimed numbers appear
for token in ("9 at parity", "**77**", "158 HR/Payroll doctypes", "115 HR doctypes + 43 Payroll"):
    print(f"contains {token!r}:", token in text)
