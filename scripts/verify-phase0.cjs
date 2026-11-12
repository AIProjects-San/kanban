/* eslint-disable @typescript-eslint/no-require-imports */
// Phase 0 verification: read back every new table + the SUPER_ADMIN wiring.
const { PrismaClient, Prisma } = require("@prisma/client");
const db = new PrismaClient();

async function main() {
  const sets = await db.statutoryRule.findMany({
    include: {
      payeTiers: { orderBy: { fromAnnual: "asc" } },
      secondaryRates: { orderBy: { code: "asc" } },
      accLevy: true,
      ietc: true,
      kiwiSaver: true,
      esctTiers: { orderBy: { fromAnnual: "asc" } },
      studentLoan: true,
    },
  });
  for (const s of sets) {
    console.log(`SET ${s.label} current=${s.isCurrent} [${s.effectiveFrom.toISOString().slice(0, 10)}, ${s.effectiveTo?.toISOString().slice(0, 10)})`);
    console.log("  PAYE:", s.payeTiers.map((t) => `${t.fromAnnual}-${t.toAnnual ?? "∞"}@${(t.rate * 100).toFixed(1)}%`).join(" · "));
    console.log("  SEC :", s.secondaryRates.map((r) => `${r.code}=${(r.rate * 100).toFixed(1)}%`).join(" · "));
    console.log(`  ACC : ${(s.accLevy.rate * 100).toFixed(2)}% cap $${s.accLevy.maxEarnings} max $${s.accLevy.maxLevy}`);
    console.log(`  IETC: $${s.ietc.annualAmount} [${s.ietc.lowerBound}-${s.ietc.abateFrom}] abate ${(s.ietc.abateRate * 100).toFixed(0)}c to ${s.ietc.upperBound}`);
    console.log(`  KS  : default ${(s.kiwiSaver.defaultEmployeeRate * 100).toFixed(1)}% employer ${(s.kiwiSaver.employerRate * 100).toFixed(1)}% allowed ${JSON.stringify(s.kiwiSaver.allowedEmployeeRates)}`);
    console.log("  ESCT:", s.esctTiers.map((t) => `${t.fromAnnual}-${t.toAnnual ?? "∞"}@${(t.rate * 100).toFixed(1)}%`).join(" · "));
    console.log(`  SL  : ${(s.studentLoan.rate * 100).toFixed(0)}% over $${s.studentLoan.annualThreshold} (monthly $${(s.studentLoan.annualThreshold / 12).toFixed(2)})`);
  }

  const profiles = await db.employeeTaxProfile.findMany({ orderBy: { taxCode: "asc" } });
  console.log(`\nTAX PROFILES (${profiles.length}):`);
  for (const p of profiles) {
    const u = await db.user.findUnique({ where: { id: p.userId }, select: { email: true } });
    console.log(`  ${u.email.padEnd(22)} code=${p.taxCode.padEnd(6)} casual=${p.isCasual ? "Y" : "n"} KS=${p.kiwiSaverStatus}/${p.kiwiSaverEmployeeRate ?? "default"} STC=${p.taxCodeSpecialRate ?? "-"}/${p.stcAccTreatment}/${p.stcStudentLoanRate ?? "-"} ird=${p.irdNumber}`);
  }

  const superAdmin = await db.user.findFirst({ where: { role: "SUPER_ADMIN" }, select: { email: true, name: true } });
  console.log(`\nSUPER_ADMIN user: ${superAdmin ? `${superAdmin.name} <${superAdmin.email}>` : "MISSING!"}`);
  const dbRole = await db.role.findUnique({ where: { key: "SUPER_ADMIN" }, include: { permissions: { include: { permission: true } } } });
  console.log(`DB Role mirror: ${dbRole ? `${dbRole.label} (${dbRole.permissions.length} perms incl. statutory:manage=${dbRole.permissions.some((rp) => rp.permission.key === "statutory:manage")})` : "MISSING!"}`);
  const dbPerm = await db.permission.findUnique({ where: { key: "statutory:manage" } });
  console.log(`DB Permission row: ${dbPerm ? `"${dbPerm.label}" group=${dbPerm.group}` : "MISSING!"}`);

  const runs = await db.payrollRun.count();
  const legacyRuns = await db.payrollRun.count({ where: { rateSetId: "" } });
  console.log(`\nPayrollRuns: ${runs} (all with rateSetId="" legacy default: ${legacyRuns})`);
  const slipWithNull = await db.payslip.count({ where: { statutory: { equals: Prisma.DbNull } } });
  console.log(`Payslips with statutory=NULL (legacy): ${slipWithNull}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => db.$disconnect());
