#!/usr/bin/env python3
"""Audit prisma migration.sql files for comma-joined DDL statements.

Flags any line that starts a new DDL keyword (ALTER/CREATE/DROP/...) while the
previous non-comment, non-empty line ends with a comma — the exact class of
bug that broke CI (`ALTER TABLE a ..., ALTER TABLE b ...;` is invalid SQL).
"""
import re
import sys
from pathlib import Path

DDL_KEYWORDS = re.compile(
    r"^\s*(ALTER\s+TABLE|CREATE\s+(TABLE|INDEX|UNIQUE|TYPE|EXTENSION|SCHEMA|FUNCTION|TRIGGER|VIEW)|"
    r"DROP\s+(TABLE|INDEX|CONSTRAINT|TYPE|VIEW|FUNCTION|TRIGGER)|UPDATE|INSERT\s+INTO|DELETE\s+FROM|"
    r"GRANT|REVOKE|COMMENT\s+ON|ALTER\s+INDEX|ANALYZE|VACUUM)\b",
    re.IGNORECASE,
)
COMMENT_OR_BLANK = re.compile(r"^\s*(--|$)")

issues = []
for path in sorted(Path("prisma/migrations").glob("*/migration.sql")):
    lines = path.read_text().splitlines()
    prev_code_line = None
    for i, line in enumerate(lines, start=1):
        if COMMENT_OR_BLANK.match(line):
            continue
        if prev_code_line is not None and prev_code_line.rstrip().endswith(","):
            if DDL_KEYWORDS.match(line):
                issues.append(f"{path}:{i}: statement after comma: {line.strip()[:90]}")
        prev_code_line = line

if issues:
    print("COMMA-JOIN ISSUES FOUND:")
    for issue in issues:
        print(f"  {issue}")
    sys.exit(1)
print("OK — no comma-joined DDL statements in any migration.sql")
