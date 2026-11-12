// Prisma-convention seed entry (Phase 1A). The full demo seed lives in
// scripts/seed.js (SEED_DEMO=1 guard, demo org, payroll fixtures); this
// entry owns the STATUTORY bootstrap — the rate set + tax-year registry —
// so `prisma db seed` style flows and production bootstraps get the NZ
// statutory tables without the demo data.
//
// Run: bun prisma/seed.ts        (or: bun run db:seed:statutory)
import { seedNzStatutory } from "./seed/nz-statutory";

seedNzStatutory()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => process.exit(process.exitCode ?? 0));
