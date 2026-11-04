#!/usr/bin/env python3
r"""Convert the persona assessment docx (via existing pandoc output) into a
clean repo-ready markdown edition at docs/Fernly_Persona_Acceptance_Assessment.md.

Cleans pandoc artifacts: cover HTML table, TOC field block, heading bold,
pandoc backslash escapes (keeps \| inside table cells), /tmp image refs.
"""
import re
import sys
import shutil
from pathlib import Path

SRC = Path("/tmp/persona-report.md")          # pandoc gfm output (already generated)
DST = Path("/home/z/my-project/docs/Fernly_Persona_Acceptance_Assessment.md")
ASSET_SRC = Path("/home/z/my-project/scripts/persona-report-assets")
ASSET_DST = Path("/home/z/my-project/docs/assets")

src = SRC.read_text(encoding="utf-8")

# --- 1. drop cover block + TOC field block: keep body from first real H1 -----
m = re.search(r"^# \*\*1\. Executive Summary\*\*$", src, re.M)
if not m:
    sys.exit("FATAL: could not locate first H1 in pandoc output")
body = src[m.start():]

# --- 2. unescape pandoc backslash escapes (leave \| alone: needed in tables) --
before = re.findall(r"\\([$<>#_\-\[\]!\"'()])", body)
body = re.sub(r"\\([$<>#_\-\[\]!\"'()])", r"\1", body)
print(f"unescaped {len(before)} backslash escapes: {sorted(set(before))}")

# --- 3. strip bold markers inside headings -----------------------------------
body = re.sub(r"^(#{1,4}) \*\*(.+?)\*\*\s*$", r"\1 \2", body, flags=re.M)

# --- 4. replace <img> tags with markdown refs to docs/assets -----------------
IMG1 = "1589fedbbb994648037c17a9a5bed6d5dbfbaae4.png"  # = chart-verdicts (md5 match)
IMG2 = "d4b1f37b30e61d182b16865f845f18f0b4ff6d74.png"  # = chart-coverage (md5 match)
n1 = body.count(IMG1)
n2 = body.count(IMG2)
if (n1, n2) != (1, 1):
    sys.exit(f"FATAL: unexpected image ref counts verdicts={n1} coverage={n2}")
body = re.sub(
    r'<img src="/tmp/persona-media/media/' + IMG1 + r'"[^>]*/>',
    "![Persona verdicts across the rated panel](assets/chart-verdicts.png)",
    body,
)
body = re.sub(
    r'<img src="/tmp/persona-media/media/' + IMG2 + r'"[^>]*/>',
    "![Assessed capability coverage versus the market baseline](assets/chart-coverage.png)",
    body,
)

# --- 5. build header + TOC with GitHub-compatible anchors --------------------
def gh_slug(text: str) -> str:
    """Mimic github-slugger: lowercase, drop punctuation, spaces -> hyphens.
    Hyphen itself survives; em/en dash, slash, punctuation are dropped."""
    t = text.strip().lower()
    t = re.sub(r'["\'’“”„.,:;/?!()\[\]{}<>@#$%^&*+=~`|\\_—–·]', "", t)
    return t.replace(" ", "-")

headings = re.findall(r"^(#{1,2}) (.+)$", body, re.M)
print(f"headings for TOC: {len(headings)} (H1={sum(1 for h,_ in headings if h=='#')})")

toc_lines = []
for level, title in headings:
    indent = "" if level == "#" else "  "
    toc_lines.append(f"{indent}- [{title}](#{gh_slug(title)})")

header = """# Fernly Persona Acceptance Assessment

> **Fernly Recruitment & HR Suite — honest verdicts from 10 personas at a
> 10-employee and a 50-employee company.**
>
> Buy-vs-competitor evaluation · Panel: BrightLeaf Studio (10) and Meridian
> Systems (50) · Assessment date: 5 November 2026 · Prepared for the product
> owner — internal.
>
> Markdown edition of the formatted report
> (`Fernly_Persona_Acceptance_Assessment.docx`, same folder); charts in
> [`assets/`](assets/). Fixes shipped during the audit are in commit `1d7f246`.

## Contents

""" + "\n".join(toc_lines) + "\n\n---\n\n"

out = header + body
DST.write_text(out, encoding="utf-8")
print(f"wrote {DST} ({len(out.splitlines())} lines, {len(out)} bytes)")

# --- 6. copy chart assets -----------------------------------------------------
ASSET_DST.mkdir(exist_ok=True)
for name in ("chart-verdicts.png", "chart-coverage.png"):
    shutil.copy2(ASSET_SRC / name, ASSET_DST / name)
    print(f"copied {name} -> {ASSET_DST / name}")

# --- 7. self-verification ------------------------------------------------------
errors = []
# 7a. every TOC link resolves against a real heading slug
slugs = {gh_slug(t) for _, t in headings}
for line in toc_lines:
    link = re.search(r"\]\(#(.+)\)$", line).group(1)
    if link not in slugs:
        errors.append(f"TOC anchor does not resolve: #{link}")
# 7b. images point at existing files, no tmp refs, no leftover escapes
if re.search(r"/tmp/", out):
    errors.append("leftover /tmp reference")
for bad in (r"\\\$", r"\\<", r"\\#", r"\\_"):
    if re.search(bad, out):
        errors.append(f"leftover escape {bad!r}")
for png in ("assets/chart-verdicts.png", "assets/chart-coverage.png"):
    if png not in out:
        errors.append(f"missing image ref {png}")
    if not (DST.parent / png).is_file():
        errors.append(f"image file not on disk: {png}")
# 7c. expected structure
n_h1 = len(re.findall(r"^# ", out, re.M))
n_tables = len(re.findall(r"^\|", out, re.M))
if n_h1 != 10:  # title + sections 1..9
    errors.append(f"expected 10 H1 lines (title + 9 sections), found {n_h1}")
print(f"H1={n_h1}, table lines={n_tables}")

if errors:
    print("VERIFICATION FAILURES:")
    for e in errors:
        print(" -", e)
    sys.exit(1)
print("ALL CHECKS PASSED")
