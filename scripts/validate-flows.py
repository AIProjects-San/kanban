#!/usr/bin/env python3
"""Phase 4 validation for docs/flows (7-point checklist).
Checks: file completeness (9 sections), link resolution, README/disk parity,
placeholder leftovers, internal-term leaks, error-quote authenticity (fuzzy).
"""
import os, re, glob, subprocess, sys

ROOT = "/home/z/my-project"
FLOWS = os.path.join(ROOT, "docs", "flows")

SECTIONS = [
    "## Who can use this",
    "## Where to find it",
    "## When to use it",
    "## Before you start",
    "## Steps",
    "## What you'll see",
    "## Common problems",
    "## What happens behind the scenes",
    "## Related flows",
]

# Internal terms that must never appear in end-user docs
LEAK_PATTERNS = [
    (r"src/(components|server-actions|lib|app|config)/", "source path"),
    (r"\b[\w-]+\.tsx?\b", "code file name"),
    (r"\b(hr|payroll|hiring|attendance|role|statutory|audit):(manage|view|admin)\b", "permission string"),
    (r"\b(bun|npm|yarn|pnpm|node|prisma)\s+(run|db|seed|migrate|install)", "dev command"),
    (r"\bexport (async )?function\b", "code keyword"),
    (r"\bADR-\d+|\bP\d+\s*\(|QA-\d+|EM-\d+|PR-\w\d+|L-P\d+", "internal ticket id"),
    (r"z\.ai|TODO|TBD|FIXME|待补充|【", "placeholder"),
]

errors, warnings = [], []

files = sorted(glob.glob(os.path.join(FLOWS, "**", "*.md"), recursive=True))
rel_files = [os.path.relpath(f, FLOWS) for f in files]

# ---- 1. Completeness: nine sections in every flow file (not README) ----
for f, rf in zip(files, rel_files):
    if rf == "README.md":
        continue
    text = open(f).read()
    pos = -1
    for sec in SECTIONS:
        p = text.find(sec)
        if p == -1:
            errors.append(f"[sections] {rf}: missing '{sec}'")
        elif p < pos:
            errors.append(f"[sections] {rf}: '{sec}' out of order")
        else:
            pos = p
    if len(text.strip().splitlines()) < 40:
        warnings.append(f"[thin] {rf}: only {len(text.strip().splitlines())} lines")

# ---- 2. Link resolution ----
link_re = re.compile(r"\[[^\]]*\]\(([^)#\s]+\.md)(#[^)\s]*)?\)")
all_links = {}
for f, rf in zip(files, rel_files):
    text = open(f).read()
    for m in link_re.finditer(text):
        target = m.group(1)
        dest = os.path.normpath(os.path.join(os.path.dirname(f), target))
        dest_rel = os.path.relpath(dest, FLOWS)
        if dest_rel not in rel_files:
            errors.append(f"[links] {rf}: broken link '{target}'")
        all_links.setdefault(rf, []).append(dest_rel)

# ---- 3. README/disk parity ----
readme = open(os.path.join(FLOWS, "README.md")).read()
readme_links = {os.path.normpath(m.group(1)) for m in link_re.finditer(readme)}
disk = set(r for r in rel_files if r != "README.md")
missing_in_readme = disk - readme_links
extra_in_readme = readme_links - disk
for x in sorted(missing_in_readme):
    errors.append(f"[index] file not indexed in README: {x}")
for x in sorted(extra_in_readme):
    errors.append(f"[index] README links to missing file: {x}")

# ---- 4. Placeholder / internal-term leak scan ----
for f, rf in zip(files, rel_files):
    text = open(f).read()
    for lineno, line in enumerate(text.splitlines(), 1):
        for pat, label in LEAK_PATTERNS:
            if re.search(pat, line):
                errors.append(f"[leak:{label}] {rf}:{lineno}: {line.strip()[:110]}")

# ---- 5. Error-quote authenticity (fuzzy: longest literal fragments) ----
# Collect blockquote lines that look like messages (skip pure UI-label quotes)
WHITELIST = "Infrastructure ready, adapter not configured"  # user-mandated note
def fragments(line):
    """Split a quoted message into verbatim skeleton fragments.

    Mask interpolated values first: "quoted values", <placeholders>, {vars},
    numbers, dates, currency — then keep contiguous word runs.
    """
    s = re.sub(r"^>\s*", "", line).strip().strip('"')
    if WHITELIST in s:
        return []  # mandated status note, not a code message
    s = re.sub(r'"[^"]*"', "\x00", s)      # quoted interpolations
    s = re.sub(r"<[^>]*>", "\x00", s)      # <placeholder>
    s = re.sub(r"\{[^}]*\}", "\x00", s)    # {var}
    s = re.sub(r"“[^”]*…”?", "\x00", s)    # “elided…”
    s = re.sub(r"…", "\x00", s)            # ellipsis
    s = re.sub(r"\b\d[\d,.:/–-]*\b", "\x00", s)  # numbers/dates/money
    parts = [p.strip(" .,:;!—-\"'()") for p in s.split("\x00")]
    return [p for p in parts if len(p.split()) >= 4 and len(p) >= 18]

checked = misses = 0
miss_list = []
for f, rf in zip(files, rel_files):
    for line in open(f):
        if line.startswith(">"):
            for frag in fragments(line):
                checked += 1
                # search each skeleton (up to 10 words) in src/ + e2e/
                probe = " ".join(frag.split()[:10])
                probe = probe.replace("'", "'")
                r = subprocess.run(
                    ["rg", "-F", "--no-messages", "-l", probe, "src", "e2e", "scripts/seed.js"],
                    cwd=ROOT, capture_output=True, text=True)
                if r.returncode != 0:
                    misses += 1
                    miss_list.append(f"{rf}: «{frag[:90]}»")
print(f"[authenticity] {checked} message fragments checked, {misses} not found in code")
for m in miss_list:
    warnings.append(f"[authenticity] {m}")

# ---- Report ----
print(f"\n{'='*60}\nFILES: {len(files)} (52 flows + README expected)")
print(f"ERRORS: {len(errors)}")
for e in errors:
    print("  " + e)
print(f"WARNINGS: {len(warnings)}")
for w in warnings:
    print("  " + w)
sys.exit(1 if errors else 0)
