// ---------------------------------------------------------------------------
// Phase 1C (G2) — chart of accounts + accounting period seed.
//
// The NZ payroll posting set: one liability account per statutory
// deduction, the net-pay clearing account, the salary expense accounts and
// cash at bank. isSystem rows are seed-owned (the editor refuses to delete
// them); 1000 stays deletable (a workspace may bank elsewhere).
//
// Accounting periods: monthly [first-of-month, last-of-month] windows over
// 2025-01 → 2027-12 — the demo data lives in 2026 and monthly periods
// cover monthly/weekly/daily cadence windows. Idempotent: accounts upsert
// by code, periods are created only when no period covers the month.
//
// Called from prisma/seed.ts (`npx prisma db seed`).
// ---------------------------------------------------------------------------

import { PrismaClient } from "@prisma/client";

interface AccountSeed {
  code: string;
  name: string;
  type: "ASSET" | "LIABILITY" | "EQUITY" | "INCOME" | "EXPENSE";
  isSystem: boolean;
}

export const SYSTEM_ACCOUNTS: AccountSeed[] = [
  { code: "1000", name: "Cash at Bank", type: "ASSET", isSystem: false },
  { code: "2100", name: "PAYE Payable", type: "LIABILITY", isSystem: true },
  { code: "2110", name: "ACC Payable", type: "LIABILITY", isSystem: true },
  { code: "2120", name: "KiwiSaver Employee Payable", type: "LIABILITY", isSystem: true },
  { code: "2130", name: "KiwiSaver Employer Payable", type: "LIABILITY", isSystem: true },
  { code: "2140", name: "ESCT Payable", type: "LIABILITY", isSystem: true },
  { code: "2150", name: "Student Loan Payable", type: "LIABILITY", isSystem: true },
  { code: "2200", name: "Net Pay Clearing", type: "LIABILITY", isSystem: true },
  { code: "4000", name: "Salaries & Wages", type: "EXPENSE", isSystem: true },
  { code: "4010", name: "Employer KiwiSaver Expense", type: "EXPENSE", isSystem: true },
  { code: "4020", name: "ACC Expense", type: "EXPENSE", isSystem: true },
];

/** Monthly accounting periods over [2025-01, 2027-12] inclusive. */
const PERIOD_YEARS = [2025, 2026, 2027];

export async function seedAccounting(db: PrismaClient): Promise<void> {
  console.log("📒 Phase 1C — seeding chart of accounts + accounting periods…");

  for (const a of SYSTEM_ACCOUNTS) {
    await db.ledgerAccount.upsert({
      where: { code: a.code },
      update: { name: a.name, type: a.type, isSystem: a.isSystem, isActive: true },
      create: { code: a.code, name: a.name, type: a.type, isSystem: a.isSystem },
    });
  }
  console.log(`  ✓ ${SYSTEM_ACCOUNTS.length} accounts (codes 1000–4020; system rows locked)`);

  let periods = 0;
  for (const year of PERIOD_YEARS) {
    for (let month = 0; month < 12; month++) {
      const start = new Date(Date.UTC(year, month, 1));
      const end = new Date(Date.UTC(year, month + 1, 0)); // last day of month
      const existing = await db.accountingPeriod.findFirst({
        where: { startDate: start, endDate: end },
        select: { id: true },
      });
      if (existing) continue;
      await db.accountingPeriod.create({ data: { startDate: start, endDate: end } });
      periods += 1;
    }
  }
  console.log(
    `  ✓ accounting periods: ${periods} created (monthly ${PERIOD_YEARS[0]}-01 → ${PERIOD_YEARS.at(-1)}-12, idempotent)`,
  );
}
