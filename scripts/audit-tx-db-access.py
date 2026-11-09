#!/usr/bin/env python3
"""Find global-db usage INSIDE Prisma interactive transaction callbacks.

Inside `db.$transaction(async (tx) => ... )`, every database call must go
through `tx`. A call on the global `db` (or a helper that uses the global
client, like logAudit) opens a SECOND connection: on SQLite the two
connections deadlock over the single writer lock (the observed 5011ms
"Transaction already closed" failure in lockPayrollRun); on Postgres it
escapes the transaction's atomicity.

Comments and string/template literals are stripped before scanning, and the
transaction extent is tracked by PARENTHESES from `$transaction(` to its
matching close — robust against both braced callbacks and implicit-return
arrow callbacks.
"""
import re
import sys
from pathlib import Path


def strip_strings_and_comments(text: str) -> str:
    out = []
    i, n = 0, len(text)
    state = "code"  # code | line | block | squote | dquote | template
    while i < n:
        c = text[i]
        nxt = text[i + 1] if i + 1 < n else ""
        if state == "code":
            if c == "/" and nxt == "/":
                state = "line"; i += 2; continue
            if c == "/" and nxt == "*":
                state = "block"; i += 2; continue
            if c == "'":
                state = "squote"; i += 1; out.append(" "); continue
            if c == '"':
                state = "dquote"; i += 1; out.append(" "); continue
            if c == "`":
                state = "template"; i += 1; out.append(" "); continue
            out.append(c); i += 1
        elif state == "line":
            if c == "\n":
                state = "code"; out.append("\n")
            i += 1
        elif state == "block":
            if c == "*" and nxt == "/":
                state = "code"; i += 2; continue
            if c == "\n":
                out.append("\n")
            i += 1
        elif state in ("squote", "dquote"):
            if c == "\\":
                i += 2; continue
            if (state == "squote" and c == "'") or (state == "dquote" and c == '"'):
                state = "code"; out.append(" ")
            i += 1
        elif state == "template":
            if c == "\\":
                i += 2; continue
            if c == "`":
                state = "code"; out.append(" ")
            out.append(" " if c != "\n" else "\n")
            i += 1
    return "".join(out)


GLOBAL_DB_CALL = re.compile(
    r"await (db\.|logAudit\(|createNotification\(|queueOutboxMail\(\s*db\b|sendOutboxMail\()"
)
TX_OPEN = re.compile(r"\$transaction\(")

issues = []
for path in sorted(Path("src/server-actions").glob("*.ts")):
    raw = path.read_text()
    clean = strip_strings_and_comments(raw)
    clean_lines = clean.splitlines()
    raw_lines = raw.splitlines()
    in_tx = False
    depth = 0
    tx_line = 0
    for i, line in enumerate(clean_lines, 1):
        if not in_tx:
            m = TX_OPEN.search(line)
            if m:
                in_tx = True
                tx_line = i
                # count parens after the match on this line
                depth = line[m.end():].count("(") - line[m.end():].count(")")
            continue
        if in_tx:
            if GLOBAL_DB_CALL.search(line):
                issues.append(f"{path.name}:{i} [tx@{tx_line}]: {raw_lines[i-1].strip()[:90]}")
            depth += line.count("(") - line.count(")")
            if depth <= 0:
                in_tx = False

if issues:
    print("GLOBAL-DB CALLS INSIDE TRANSACTIONS:")
    for issue in issues:
        print(f"  {issue}")
    sys.exit(1)
print("OK — no global-db calls inside transaction callbacks")
