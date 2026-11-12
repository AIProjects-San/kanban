// Prisma-convention seed entry (Phase 1A). The full demo seed lives in
// scripts/seed.js (SEED_DEMO=1 guard, demo org, payroll fixtures); this
// entry owns the SYSTEM bootstrap — the NZ statutory rate set + tax-year
// registry (Phase 1A) and the general-ledger chart of accounts + posting
// periods (Phase 1C) — so `prisma db seed` style flows and production
// bootstraps get the system tables without the demo data.
//
// Run: bun prisma/seed.ts        (or: bun run db:seed:statutory)
import { seedNzStatutory } from "./seed/nz-statutory";
import { seedAccounting } from "./seed/accounting";
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

seedNzStatutory()
  .then(() => seedAccounting(db))
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect().then(() => process.exit(process.exitCode ?? 0)));
