#!/usr/bin/env bash
# PHASE 0 SPIKE runner — generates the scratch Prisma client, pushes the
# scratch SQLite schema, runs the spike, then cleans the scratch artifacts.
# The project's real schema/client/database are never touched.
set -euo pipefail
cd "$(dirname "$0")"

echo "[spike] generating scratch Prisma client…"
bunx prisma generate --schema spike.schema.prisma 2>&1 | tail -2

echo "[spike] pushing scratch SQLite schema…"
rm -f spike.db
bunx prisma db push --schema spike.schema.prisma --skip-generate 2>&1 | tail -3

echo "[spike] running the validation script…"
node spike.mjs
