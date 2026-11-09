#!/usr/bin/env python3
"""Drift check: prisma/migrations replay result vs prisma/schema.prisma.

The migrations (replayed on PGlite in scripts/pg-replay/replay.ts →
schema-dump.json) must produce exactly the schema that `prisma db push`
derives from schema.prisma — otherwise CI's e2e job migrates a database that
does not match what the Prisma client / seed expects (P10xx "column does not
exist" failures at runtime).

Hard failures (exit 1): missing/extra tables or columns, type mismatches,
nullability mismatches, missing unique constraints (upsert targets).
Warnings: DB-default presence differences (Prisma supplies @default values
client-side, so a missing DB default is harmless).
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCHEMA = (ROOT / "prisma" / "schema.prisma").read_text()
DUMP = json.loads((ROOT / "scripts" / "pg-replay" / "schema-dump.json").read_text())

PRISMA_TO_PG = {
    "String": "text",
    "Int": "integer",
    "Float": "double precision",
    "Boolean": "boolean",
    "DateTime": "timestamp without time zone",
    "Json": "jsonb",
}

# ---------------------------------------------------------------- parse schema
models: dict[str, dict] = {}
cur = None
for raw in SCHEMA.splitlines():
    line = raw.split("//")[0].rstrip()
    if not line.strip():
        continue
    m = re.match(r"^model\s+(\w+)\s*\{", line)
    if m:
        cur = {"name": m.group(1), "fields": [], "uniques": [], "pk": None}
        models[m.group(1)] = cur
        continue
    if cur is None:
        continue
    if line.strip().startswith("}"):
        cur = None
        continue
    if line.strip().startswith("@@"):
        stripped = line.strip()
        mu = re.match(r"@@unique\(\[([^\]]+)\]", stripped)
        if mu:
            cur["uniques"].append([c.strip() for c in mu.group(1).split(",")])
        mi = re.match(r"@@id\(\[([^\]]+)\]", stripped)
        if mi:
            cur["pk"] = [c.strip() for c in mi.group(1).split(",")]
        continue
    fm = re.match(r"^\s*(\w+)\s+([\w.?]+)(.*)$", line)
    if not fm:
        continue
    fname, ftype, rest = fm.groups()
    cur["fields"].append({
        "name": fname,
        "type": ftype,
        "nullable": ftype.endswith("?"),
        "unique": "@unique" in rest,
        "default": "@default" in rest,
    })

# ------------------------------------------------------------------ normalize
def expected_columns(model):
    out = {}
    for f in model["fields"]:
        base = f["type"].rstrip("?")
        if base not in PRISMA_TO_PG:
            continue  # relation field (type is a model name) — no DB column
        out[f["name"]] = (PRISMA_TO_PG[base], f["nullable"])
    return out


def expected_uniques(model):
    cols = []
    for f in model["fields"]:
        if f["unique"] and f["type"].rstrip("?") in PRISMA_TO_PG:
            cols.append([f["name"]])
    cols.extend(model["uniques"])
    return cols


pg_tables = set(DUMP["tables"]) - {"_prisma_migrations"}
pg_columns: dict[str, dict[str, tuple[str, bool, bool]]] = {}
for c in DUMP["columns"]:
    dtype = c["udt_name"] if c["data_type"] == "USER-DEFINED" else c["data_type"]
    pg_columns.setdefault(c["table_name"], {})[c["column_name"]] = (
        dtype, c["is_nullable"] == "YES", c["column_default"] is not None)

pg_uniques: dict[str, set] = {}
for u in DUMP["uniques"]:
    if u["indexname"].endswith("_pkey"):
        continue
    pg_uniques.setdefault(u["tablename"], set()).add(frozenset(u["columns"].split(",")))

failures, warnings = [], []
exp_tables = set(models)
for t in sorted(exp_tables - pg_tables):
    failures.append(f"table {t}: in schema.prisma but MISSING from migrations replay")
for t in sorted(pg_tables - exp_tables):
    failures.append(f"table {t}: created by migrations but NOT in schema.prisma")

for name, model in sorted(models.items()):
    exp = expected_columns(model)
    got = pg_columns.get(name, {})
    for col, (etype, enull) in sorted(exp.items()):
        if col not in got:
            failures.append(f"{name}.{col}: in schema.prisma but MISSING from migrations replay")
            continue
        gtype, gnull, gdef = got[col]
        if gtype != etype:
            failures.append(f"{name}.{col}: type mismatch — schema.prisma {etype} vs migrations {gtype}")
        if gnull != enull:
            failures.append(f"{name}.{col}: nullability mismatch — schema.prisma nullable={enull} vs migrations nullable={gnull}")
        if gdef and not any(f["name"] == col and f["default"] for f in model["fields"]):
            warnings.append(f"{name}.{col}: migrations add a DB default not declared in schema.prisma (harmless)")
        if not gdef and any(f["name"] == col and f["default"] for f in model["fields"]):
            warnings.append(f"{name}.{col}: schema.prisma @default not mirrored as a DB default (harmless — client-side default)")
    for col in sorted(set(got) - set(exp)):
        failures.append(f"{name}.{col}: created by migrations but NOT in schema.prisma")

for name, model in sorted(models.items()):
    exp_u = {frozenset(u) for u in expected_uniques(model)}
    got_u = pg_uniques.get(name, set())
    for u in sorted(exp_u - got_u, key=lambda s: sorted(s)):
        failures.append(f"{name}: unique constraint on {sorted(u)} MISSING from migrations replay (upsert target)")
    for u in sorted(got_u - exp_u, key=lambda s: sorted(s)):
        warnings.append(f"{name}: extra unique constraint on {sorted(u)} in migrations (stricter than schema)")

print(f"models: {len(models)} | tables in replay: {len(pg_tables)} | pg unique constraints: {sum(len(v) for v in pg_uniques.values())}")
if failures:
    print(f"\nDRIFT FAILURES ({len(failures)}):")
    for f in failures:
        print(f"  FAIL {f}")
    sys.exit(1)
print(f"\nNo drift — migrations replay produces the schema.prisma schema exactly.")
for w in warnings:
    print(f"  warn {w}")
