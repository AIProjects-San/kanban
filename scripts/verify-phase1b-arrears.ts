// CHECKPOINT 1B.6 — re-run arrears detection for yuki's backdated revision
// (2026-10-15, base 78,000 → 84,000) against the live DB.
import { PrismaClient } from "@prisma/client";
import { detectArrears } from "../src/lib/payroll/detect-arrears";

const db = new PrismaClient();

async function main() {
  const yuki = await db.user.findUnique({ where: { email: "yuki@fernly.app" } });
  const revision = await db.salaryStructureAssignment.findFirst({
    where: { employeeId: yuki.id, reason: "REVISION" },
    orderBy: { fromDate: "desc" },
  });
  console.log("revision:", {
    fromDate: revision.fromDate.toISOString().slice(0, 10),
    base: Number(revision.base),
    id: revision.id,
  });
  const rows = await detectArrears(yuki.id, revision.id);
  console.log(`detected ${rows.length} arrears row(s):`);
  for (const r of rows) {
    console.log(
      `  ${r.periodKey} [${r.periodStart.toISOString().slice(0, 10)} → ${r.periodEnd.toISOString().slice(0, 10)}] paid ${r.paidBase} → due ${r.dueBase}: delta $${r.delta}`,
    );
  }
  await db.$disconnect();
}

main();
