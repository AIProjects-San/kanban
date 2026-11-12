// ---------------------------------------------------------------------------
// Phase 1D (step 2) — payroll ↔ GL reconciliation.
//
// For a given payroll run:
//   • Σ payslip netPay  vs  Σ JE credits on 2200 Net Pay Clearing
//   • per statutory category, Σ payslip statutory deduction lines
//     (paye/acc/ks/sl)  vs  Σ JE credits on 2100/2110/2120/2150
//   • employer side: Σ employerKiwiSaverGross/Net/ESCT  vs  Σ JE legs on
//     4010 / 2130 / 2140
//   • gross vs the salary-expense debits (4000 net of the non-statutory
//     deduction credits)
// Every assertion must hold to the cent. The ORIGINAL entry
// (reversalOfId null) is the run's posting — a reversal negates it but
// never rewrites it.
//
// Run: bash scripts/run-with-env.sh bun scripts/verify-payroll-gl-reconciliation.ts <period>
// ---------------------------------------------------------------------------

import { PrismaClient } from "@prisma/client";
import { parsePayslipLines, isStatutoryLineKey } from "../src/lib/payroll-math";

const db = new PrismaClient();

const round2 = (n: number) => Math.round(n * 100) / 100;

async function main() {
  const period = process.argv[2] ?? "2026-12";
  const run = await db.payrollRun.findUnique({
    where: { period },
    include: {
      payslips: {
        select: {
          userId: true, slipNo: true, earnings: true, deductions: true, net: true,
          employerKiwiSaverGross: true, employerEsct: true, employerKiwiSaverNet: true,
        },
      },
    },
  });
  if (!run) throw new Error(`no run ${period}`);
  if (run.status !== "LOCKED") throw new Error(`run ${period} is ${run.status}, not LOCKED`);

  const je = await db.journalEntry.findFirst({
    where: { sourceType: "PAYROLL_RUN", sourceId: run.id, reversalOfId: null },
    include: { lines: { include: { account: true } } },
  });
  if (!je) throw new Error(`no journal entry for run ${period}`);

  // ---- Payslip side ---------------------------------------------------------
  let netTotal = 0;
  let grossTotal = 0;
  let otherDeductions = 0;
  const statByCategory: Record<string, number> = { paye: 0, acc: 0, ks: 0, sl: 0 };
  let erGross = 0;
  let erNet = 0;
  let erEsct = 0;
  for (const slip of run.payslips) {
    netTotal += slip.net;
    const earnings = parsePayslipLines(slip.earnings);
    grossTotal += earnings.reduce((s, l) => (l.statistical ? s : s + l.amount), 0);
    for (const l of parsePayslipLines(slip.deductions)) {
      if (isStatutoryLineKey(l.key)) statByCategory[l.key] = (statByCategory[l.key] ?? 0) + l.amount;
      else otherDeductions += l.amount;
    }
    erGross += slip.employerKiwiSaverGross?.toNumber() ?? 0;
    erNet += slip.employerKiwiSaverNet?.toNumber() ?? 0;
    erEsct += slip.employerEsct?.toNumber() ?? 0;
  }

  // ---- GL side ---------------------------------------------------------------
  const creditOn = (code: string) =>
    round2(je.lines.filter((l) => l.account.code === code).reduce((s, l) => s + l.credit.toNumber(), 0));
  const debitOn = (code: string) =>
    round2(je.lines.filter((l) => l.account.code === code).reduce((s, l) => s + l.debit.toNumber(), 0));

  const checks: Array<{ label: string; payslip: number; gl: number }> = [
    { label: "Net pay           vs CR 2200 Net Pay Clearing", payslip: round2(netTotal), gl: creditOn("2200") },
    { label: "PAYE withheld     vs CR 2100 PAYE Payable", payslip: round2(statByCategory.paye), gl: creditOn("2100") },
    { label: "ACC levy          vs CR 2110 ACC Payable", payslip: round2(statByCategory.acc), gl: creditOn("2110") },
    { label: "KiwiSaver empl.   vs CR 2120 KS Employee Payable", payslip: round2(statByCategory.ks), gl: creditOn("2120") },
    { label: "Student loan      vs CR 2150 Student Loan Payable", payslip: round2(statByCategory.sl), gl: creditOn("2150") },
    { label: "Employer KS gross vs DR 4010 Employer KS Expense", payslip: round2(erGross), gl: debitOn("4010") },
    { label: "Employer KS net   vs CR 2130 KS Employer Payable", payslip: round2(erNet), gl: creditOn("2130") },
    { label: "ESCT              vs CR 2140 ESCT Payable", payslip: round2(erEsct), gl: creditOn("2140") },
    {
      label: "Gross − other ded.vs DR 4000 Salaries & Wages (net)",
      payslip: round2(grossTotal - otherDeductions),
      gl: round2(debitOn("4000") - creditOn("4000")),
    },
  ];

  let dr = 0;
  let cr = 0;
  for (const l of je.lines) {
    dr += l.debit.toNumber();
    cr += l.credit.toNumber();
  }

  console.log(`Payroll ↔ GL reconciliation — run ${period} (${run.payslips.length} payslips, JE ${je.id} [${je.status}], ${je.lines.length} lines)`);
  let failures = 0;
  for (const c of checks) {
    const ok = Math.abs(c.payslip - c.gl) < 0.005;
    if (!ok) failures += 1;
    console.log(
      `  ${ok ? "✓" : "✗"} ${c.label}: payslip ${c.payslip.toFixed(2)} vs GL ${c.gl.toFixed(2)}`,
    );
  }
  const balanced = Math.abs(dr - cr) < 0.005;
  if (!balanced) failures += 1;
  console.log(
    `  ${balanced ? "✓" : "✗"} JE balance: Dr ${round2(dr).toFixed(2)} = Cr ${round2(cr).toFixed(2)}`,
  );
  console.log(failures === 0 ? "RECONCILED — every assertion holds." : `${failures} ASSERTION(S) FAILED.`);
  if (failures > 0) process.exitCode = 1;
  await db.$disconnect();
}

main();
