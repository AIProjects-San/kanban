// ---------------------------------------------------------------------------
// Phase 1C (G2) — the chart-of-accounts access the posting engine needs.
//
//   statutoryAccountFor(category) — the system ACCOUNT CODE each statutory
//                                   deduction credits.
//   getSystemAccount(code)         — the account ROW lookup that THROWS
//                                   when a system row is missing (a posting
//                                   must never silently retarget).
//
// Pure code mapping + one db read; no clock, no writes.
// ---------------------------------------------------------------------------

import { db } from "@/lib/db";

/** The statutory liability + payroll expense chart (seed/accounting.ts). */
export const STATUTORY_ACCOUNT_CODES = {
  PAYE: "2100",
  ACC: "2110",
  KIWISAVER_EMPLOYEE: "2120",
  KIWISAVER_EMPLOYER: "2130",
  ESCT: "2140",
  STUDENT_LOAN: "2150",
} as const;

export const NET_PAY_CLEARING_CODE = "2200";
export const SALARIES_EXPENSE_CODE = "4000";
export const EMPLOYER_KIWISAVER_EXPENSE_CODE = "4010";
export const ACC_EXPENSE_CODE = "4020";

export type StatutoryAccountCategory = keyof typeof STATUTORY_ACCOUNT_CODES;

/** The system account CODE a statutory category credits (throws on an
 *  unknown category — the mapping is closed by design). */
export function statutoryAccountFor(category: string): string {
  const code = (STATUTORY_ACCOUNT_CODES as Record<string, string | undefined>)[category];
  if (!code) {
    throw new Error(`Unknown statutory account category: ${category}`);
  }
  return code;
}

/** Map a statutory deduction line KEY (the payslip JSON keys) to its
 *  category. */
export const STATUTORY_LINE_CATEGORY: Record<string, StatutoryAccountCategory> = {
  paye: "PAYE",
  acc: "ACC",
  ks: "KIWISAVER_EMPLOYEE",
  sl: "STUDENT_LOAN",
};

export interface LedgerAccountRow {
  id: string;
  code: string;
  name: string;
  type: string;
  isActive: boolean;
  isSystem: boolean;
}

/** Fetch a system account by code — THROWS when the row is missing or not
 *  system-owned (a posting must never silently retarget). */
export async function getSystemAccount(code: string): Promise<LedgerAccountRow> {
  const row = await db.ledgerAccount.findUnique({ where: { code } });
  if (!row || !row.isSystem) {
    throw new Error(`System account ${code} is missing from the chart of accounts — run the accounting seed.`);
  }
  return row;
}
