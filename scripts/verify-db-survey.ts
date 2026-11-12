// Survey the live DB for phase verification readiness.
// Run: bash scripts/run-with-env.sh bun scripts/verify-db-survey.ts
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

async function main() {
  const counts = {
    users: await db.user.count(),
    assignments: await db.salaryStructureAssignment.count(),
    structures: await db.salaryStructure.count(),
    ledgerAccounts: await db.ledgerAccount.count(),
    journalEntries: await db.journalEntry.count(),
    journalLines: await db.journalEntryLine.count(),
    accountingPeriods: await db.accountingPeriod.count(),
    taxProfiles: await db.employeeTaxProfile.count(),
    payslips: await db.payslip.count(),
  };
  console.log("TABLE COUNTS:", counts);

  const statTables = [
    "taxYear", "taxSlab", "statutoryRule", "statutorySecondaryRate",
    "statutoryAccLevy", "statutoryKiwiSaver", "statutoryEsctTier",
    "statutoryStudentLoan", "statutoryIetc",
  ] as const;
  for (const t of statTables) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const n = await (db as any)[t].count();
      console.log(`  statutory ${t}: ${n}`);
    } catch {
      console.log(`  statutory ${t}: (no such table/model)`);
    }
  }

  const runs = await db.payrollRun.findMany({
    orderBy: { period: "asc" },
    select: { period: true, status: true, startDate: true, endDate: true },
  });
  console.log("PAYROLL RUNS:");
  for (const r of runs) console.log(`  ${r.period}: ${r.status} (${r.startDate?.toISOString().slice(0, 10)} → ${r.endDate?.toISOString().slice(0, 10)})`);

  const jes = await db.journalEntry.findMany({
    select: { id: true, status: true, sourceType: true, sourceId: true, memo: true, reversalOfId: true, periodId: true },
    orderBy: { createdAt: "asc" },
  });
  console.log("JOURNAL ENTRIES:");
  for (const je of jes) console.log(`  ${je.id.slice(-8)} [${je.status}] ${je.sourceType} src=${je.sourceId?.slice(-8) ?? "-"} memo="${je.memo}" reversed=${je.reversalOfId ? "yes" : "no"}`);

  const periods = await db.accountingPeriod.findMany({
    orderBy: { startDate: "asc" },
    select: { startDate: true, endDate: true, isClosed: true },
  });
  console.log("ACCOUNTING PERIODS:");
  for (const p of periods) console.log(`  ${p.startDate.toISOString().slice(0, 10)} → ${p.endDate.toISOString().slice(0, 10)} closed=${p.isClosed}`);

  const accounts = await db.ledgerAccount.findMany({
    orderBy: { code: "asc" },
    select: { code: true, name: true, type: true, isActive: true, isSystem: true },
  });
  console.log(`LEDGER ACCOUNTS (${accounts.length}):`);
  for (const a of accounts) console.log(`  ${a.code} ${a.name} [${a.type}] active=${a.isActive} system=${a.isSystem}`);

  const assignments = await db.salaryStructureAssignment.findMany({
    orderBy: [{ employeeId: "asc" }, { fromDate: "asc" }],
    select: { employeeId: true, fromDate: true, toDate: true, base: true, variable: true, reason: true, createdById: true },
  });
  console.log(`ASSIGNMENTS (${assignments.length}):`);
  const users = await db.user.findMany({ select: { id: true, email: true } });
  const emailById = new Map(users.map((u) => [u.id, u.email]));
  for (const a of assignments) {
    console.log(
      `  ${emailById.get(a.employeeId) ?? a.employeeId.slice(-8)}: ${a.fromDate.toISOString().slice(0, 10)} → ${a.toDate?.toISOString().slice(0, 10) ?? "open"} base=${a.base} var=${a.variable} reason=${a.reason ?? "-"} by=${a.createdById.slice(-12)}`,
    );
  }
  await db.$disconnect();
}

main();
