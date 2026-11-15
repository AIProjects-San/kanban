// ---------------------------------------------------------------------------
// Phase 1B (G8) CHECKPOINT 1B.4 — dry-run the exact assignment resolution
// createPayrollRun now performs, against the live (seeded) database: every
// monthly-cadence assignment in force at a given window start, with the
// structure that would price its payslip.
//
// Run: bash scripts/run-with-env.sh bun scripts/verify-phase1b-resolution.ts [YYYY-MM-DD]
// ---------------------------------------------------------------------------
import { PrismaClient } from "@prisma/client";
import { assignmentsInForceWhere } from "../src/lib/payroll/resolve-assignment";

const db = new PrismaClient();
const windowStart = new Date(`${process.argv[2] ?? "2026-11-01"}T00:00:00.000Z`);

async function main() {
  const rows = await db.salaryStructureAssignment.findMany({
    where: { ...assignmentsInForceWhere(windowStart), structure: { frequency: "MONTHLY" } },
    include: { structure: true },
    orderBy: { fromDate: "asc" },
  });
  const users = await db.user.findMany({ select: { id: true, email: true } });
  const emailById = new Map(users.map((u) => [u.id, u.email]));
  console.log(`Assignments in force at ${windowStart.toISOString().slice(0, 10)} (monthly): ${rows.length}`);
  for (const a of rows) {
    const comps = JSON.parse(a.structure.components).map((c: { key: string; amount: number }) => `${c.key}=${c.amount}`).join(", ");
    console.log(
      `  ${emailById.get(a.employeeId)}: assignment.fromDate=${a.fromDate.toISOString().slice(0, 10)} base=${a.base} variable=${a.variable} -> structure ${a.structure.id.slice(-6)} [${comps}]`,
    );
  }
  await db.$disconnect();
}

main();
