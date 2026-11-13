# scripts/

Operational, verification, and seeding scripts for Fernly. Nothing here is
imported by the app — these are developer/CI entry points only.

## Environment precedence (`run-with-env.sh`)

Every `db:*`, `dev`, `build`, and `start` command in `package.json` execs
through [`run-with-env.sh`](./run-with-env.sh), which loads the project
`.env` before running the command.

**A `DATABASE_URL` already set in the environment WINS over `.env`.** The
wrapper captures any preset value before sourcing `.env` and restores it
afterwards, so:

```bash
# Runs against /tmp/copy.db — .env CANNOT repoint it at the production db:
DATABASE_URL=file:/tmp/copy.db bash scripts/run-with-env.sh bun scripts/verify-trial-balance.ts

# Runs against whatever .env declares (the normal dev/CI path):
bash scripts/run-with-env.sh bun scripts/verify-trial-balance.ts
```

This is the safe pattern for auditing a **throwaway copy** of the database:
copy the db file, point `DATABASE_URL` at the copy, and no script can write
to production by accident. (Before this guard, sourcing `.env` silently
overrode the preset — the cause of the duplicate-reversal-JE incident after
Phase 1C. An empty/unset preset still lets `.env` decide, and all *other*
`.env` variables load normally either way.)

The wrapper is also the single place where the Prisma datasource provider is
resolved from the effective `DATABASE_URL` (ADR-008, `docs/DECISIONS.md`):
`file:` URLs get a generated SQLite variant schema; `postgres://` URLs use
the canonical committed schema. The provider resolution follows the
*effective* URL, so it honours a preset exactly like the command itself.

## Type checking

`scripts/**/*.ts` is covered by the root `tsconfig.json`, so a plain
`npx tsc --noEmit` type-checks the scripts alongside `src/`. (They used to
sit outside every tsconfig — a stray unresolvable import in
`verify-phase1c-close.ts` crashed `bun` at runtime while `tsc` stayed green,
because the file was never type-checked. The include fix makes that class of
error a compile-time error.)

## Common scripts

| Script | Purpose |
| --- | --- |
| `run-with-env.sh` | `.env` loader + Prisma provider resolution wrapper (see above) |
| `launch-dev-persistent.sh` / `start-dev-persistent.sh` | Start the dev server detached (survives sandbox recycling) |
| `seed.js` | Demo seed: users, assignments, statutory tables, chart of accounts |
| `backfill-salary-assignments.ts` | Materialise `SalaryStructureAssignment` timelines from legacy structures |
| `post-run-to-gl.ts` | Post a LOCKED payroll run to the general ledger (idempotent) |
| `verify-db-survey.ts` | DB census: users, assignments, periods, journal entries |
| `verify-arrears-math.ts` | Re-derive effective-dated salary allocation per run window |
| `verify-trial-balance.ts` | Trial balance + period reconciliation to the cent |
| `verify-phase1c-close.ts` | Phase 1C close gate (periods, GL, statutory lines) |
| `seed-phase2-demo.ts` | Phase 2 demo data: employer filing profile + an engine-priced, GL-posted 2026-09 run for the filing UI |
| `verify-phase-2-live.ts` | Phase 2 LIVE gate on a throwaway db copy: EI generation, the 8-check reconciliation, lifecycle, ED, EIA2, overdue |
| `make-ei-golden.ts` | Regenerates the committed EI golden fixture from the IRD worked example |

Verification harnesses for the nine-section protocol live in `.verify-tmp/`
(not tracked as production tooling; scratch, deleted after the run).
