/* eslint-disable no-console */
// Phase 1A gap-closure — CHECKPOINT 4 row counts (STEP 4 provenance).
// Physical tables per migration 20261201000000_nz_statutory_payroll:
// StatutoryRateSet (model StatutoryRule) and StatutoryPayeTier (model
// TaxSlab) — the Phase 1A conformance commit renamed the MODELS and kept
// the tables via @@map, so both table names and both model names resolve
// to the SAME two physical tables.
// Run: bash scripts/run-with-env.sh bun scripts/checkpoint4-row-counts.ts
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

async function main() {
  const rateSets = await db.$queryRawUnsafe<unknown[]>(
    `SELECT 'StatutoryRateSet (= model StatutoryRule)' AS tbl, COUNT(*) AS n FROM "StatutoryRateSet"`,
  );
  const payeTiers = await db.$queryRawUnsafe<unknown[]>(
    `SELECT 'StatutoryPayeTier (= model TaxSlab)' AS tbl, COUNT(*) AS n FROM "StatutoryPayeTier"`,
  );
  const secondary = await db.$queryRawUnsafe<unknown[]>(
    `SELECT 'StatutorySecondaryRate' AS tbl, COUNT(*) AS n FROM "StatutorySecondaryRate"`,
  );
  const others = await db.$queryRawUnsafe<unknown[]>(
    `SELECT 'StatutoryAccLevy' AS tbl, COUNT(*) AS n FROM "StatutoryAccLevy"
     UNION ALL SELECT 'StatutoryIetc', COUNT(*) FROM "StatutoryIetc"
     UNION ALL SELECT 'StatutoryKiwiSaver', COUNT(*) FROM "StatutoryKiwiSaver"
     UNION ALL SELECT 'StatutoryEsctTier', COUNT(*) FROM "StatutoryEsctTier"
     UNION ALL SELECT 'StatutoryStudentLoan', COUNT(*) FROM "StatutoryStudentLoan"`,
  );
  for (const row of [...rateSets, ...payeTiers, ...secondary, ...others]) {
    const o = row as Record<string, unknown>;
    console.log(`  ${o.tbl}: ${o.n}`);
  }
  // Show the seeded secondary rows (the STEP 1 combined rates).
  const rows = await db.$queryRawUnsafe<Array<{ code: string; rate: unknown; accInclusive: unknown }>>(
    `SELECT code, rate, accInclusive FROM "StatutorySecondaryRate" ORDER BY code`,
  );
  console.log("  Seeded secondary rows:");
  for (const r of rows) {
    console.log(`    ${r.code}: rate=${r.rate} accInclusive=${r.accInclusive}`);
  }
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => db.$disconnect());
