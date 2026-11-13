// ---------------------------------------------------------------------------
// Phase 1B (G8) — one-off backfill: materialise an OPEN
// SalaryStructureAssignment for every employee holding an active
// SalaryStructure, so the effective-dated world starts with the same set of
// paid employees the legacy "active structure" read produced.
//
//   fromDate  = EmployeeTaxProfile.employmentStartDate
//               ?? EmployeeProfile.hireDate
//               ?? User.createdAt            (the task's fallback chain)
//   toDate    = null (open)
//   base      = the structure's ANNUAL basic anchor (computeOffer().basic)
//   variable  = annual EARNINGS total − base (allowances, bonuses, percents)
//   reason    = "HIRE", createdById = "system-backfill"
//
// Idempotent: employees who already have ANY assignment row are skipped, so
// re-running the script after new hires simply picks up the newcomers.
//
// Run: bash scripts/run-with-env.sh bun scripts/backfill-salary-assignments.ts
// ---------------------------------------------------------------------------

import { PrismaClient } from "@prisma/client";
import { computeOffer, parseComponents } from "../src/lib/hiring/offer-math";

const db = new PrismaClient();

async function main(): Promise<void> {
  console.log("📋 Phase 1B backfill — salary structure assignments…");

  const structures = await db.salaryStructure.findMany({
    where: { isActive: true },
    orderBy: { createdAt: "asc" },
  });
  if (structures.length === 0) {
    console.log("No active salary structures — nothing to backfill.");
    return;
  }

  // The employees that already have an assignment timeline (idempotency).
  const covered = new Set(
    (await db.salaryStructureAssignment.findMany({
      select: { employeeId: true },
      distinct: ["employeeId"],
    })).map((a) => a.employeeId),
  );

  // The employment-start fallback chain inputs, read once.
  const profiles = await db.employeeProfile.findMany({
    select: { userId: true, hireDate: true },
  });
  const hireByUser = new Map(profiles.map((p) => [p.userId, p.hireDate]));
  const taxProfiles = await db.employeeTaxProfile.findMany({
    select: { userId: true, employmentStartDate: true },
  });
  const startByUser = new Map(taxProfiles.map((p) => [p.userId, p.employmentStartDate]));
  const users = await db.user.findMany({
    select: { id: true, email: true, createdAt: true },
  });
  const userById = new Map(users.map((u) => [u.id, u]));

  let created = 0;
  let skipped = 0;
  const failures: string[] = [];

  for (const structure of structures) {
    const user = userById.get(structure.userId);
    if (!user) continue;
    if (covered.has(structure.userId)) {
      skipped += 1;
      continue;
    }

    // fromDate fallback chain: tax-profile employment start → HR hire date →
    // account creation (the last honest fact we hold).
    const fromDate =
      startByUser.get(structure.userId) ??
      hireByUser.get(structure.userId) ??
      user.createdAt;

    // The effective-dated salary facts from the structure's components.
    const components = parseComponents(structure.components);
    const totals = computeOffer(components);
    const base = Math.round(totals.basic * 100) / 100;
    const variable = Math.round(Math.max(0, totals.earnings - totals.basic) * 100) / 100;

    try {
      await db.salaryStructureAssignment.create({
        data: {
          employeeId: structure.userId,
          structureId: structure.id,
          fromDate,
          toDate: null,
          base,
          variable,
          reason: "HIRE",
          createdById: "system-backfill",
        },
      });
      covered.add(structure.userId);
      created += 1;
      console.log(
        `  ✓ ${user.email}: from ${fromDate.toISOString().slice(0, 10)} — base $${base.toLocaleString("en-NZ")} + variable $${variable.toLocaleString("en-NZ")} (annual)`,
      );
    } catch (e) {
      // The only realistic collision is @@unique(employeeId, fromDate) when
      // two active structures share one derived start date — surfaced, never
      // silently merged.
      failures.push(`${user.email}: ${e instanceof Error ? e.message : "unknown error"}`);
    }
  }

  console.log(
    `Done: ${created} assignment(s) created, ${skipped} skipped (already assigned), ${failures.length} failed.`,
  );
  for (const f of failures) console.log(`  ✗ ${f}`);
  if (failures.length > 0) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
