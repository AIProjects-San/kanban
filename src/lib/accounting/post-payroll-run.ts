// ---------------------------------------------------------------------------
// Phase 1C (G2, step 4) — the payroll posting engine.
//
// postPayrollRun(runId): one BALANCED, POSTED journal entry per LOCKED
// payroll run, idempotent on (sourceType PAYROLL_RUN, sourceId runId).
// The entry, per payslip:
//
//   DR  4000 / component expense account   Σ earning lines (the gross)
//   CR  2100/2110/2120/2150                the statutory lines actually
//                                           withheld (paye/acc/ks/sl)
//   DR  4010                                employer KiwiSaver (gross)
//   CR  2130 + CR 2140                      employer KiwiSaver net + ESCT
//   CR  2200                                net pay clearing
//   CR  component liability ?? 4000         every OTHER deduction line —
//                                           mapped liabilities settle what
//                                           they owe; unmapped lines and
//                                           the LOP/rounding artifacts
//                                           credit the expense (money that
//                                           was never incurred / never
//                                           leaves the company reduces the
//                                           salary expense, which is what
//                                           makes the entry balance).
//
// Order of guards: run exists → run LOCKED → covering period resolves and
// is OPEN (a closed period refuses every posting, including re-posts —
// corrections go through a REVERSAL entry in an open period) → idempotency
// return → line build → balance assert (throws before anything is written)
// → create.
//
// The task's reference pseudocode is adapted here: Fernly payslips carry
// their lines as JSON (earnings/deductions arrays + the statutory
// snapshot), not as a PayslipLine DB table, and the entry MUST also carry
// the employer-side legs and the non-statutory deduction legs or the
// balance assert could never hold on real NZ data (employer KiwiSaver and
// LOP exist on every seeded run).
// ---------------------------------------------------------------------------

import { db } from "@/lib/infra/db";
import { parsePayslipLines, isStatutoryLineKey, round2 } from "@/lib/payroll/payroll-math";
import {
  getSystemAccount,
  STATUTORY_ACCOUNT_CODES,
  STATUTORY_LINE_CATEGORY,
  NET_PAY_CLEARING_CODE,
  SALARIES_EXPENSE_CODE,
  EMPLOYER_KIWISAVER_EXPENSE_CODE,
} from "./accounts";

/** The minimal payslip projection the engine reads. */
export interface PostingPayslip {
  userId: string;
  slipNo: string;
  earnings: string;
  deductions: string;
  net: number;
  employerKiwiSaverGross: { toNumber(): number } | null;
  employerEsct: { toNumber(): number } | null;
  employerKiwiSaverNet: { toNumber(): number } | null;
}

export interface PostingRun {
  id: string;
  period: string;
  status: string;
  startDate: Date | null;
  endDate: Date | null;
  payslips: PostingPayslip[];
}

/** One journal line to create (exactly one of debit/credit non-zero). */
export interface JeLineInput {
  accountId: string;
  debit?: number;
  credit?: number;
  employeeId?: string;
  description?: string;
}

/** Prisma-Decimal | number | null → number (test rows carry either). */
function toNum(v: { toNumber(): number } | number | null | undefined): number {
  if (v == null) return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  return v.toNumber();
}

export interface BuildLinesContext {
  salariesExpenseId: string;
  netPayClearingId: string;
  employerKsExpenseId: string;
  statutoryAccountIds: Record<string, string>;
  componentExpenseById: Map<string, string>;
  componentLiabilityById: Map<string, string>;
}

/** Build the journal lines for a payslip set (pure — the unit-tested core).
 *
 *  Deduction/statutory classification rides the LINE KEYS: the statutory
 *  keys (paye/acc/ks/sl) map through STATUTORY_LINE_CATEGORY; every other
 *  deduction maps through the catalog's liabilityAccountId or falls back
 *  to the salaries expense account (the expense-reduction leg). */
export function buildPayrollJournalLines(
  payslips: PostingPayslip[],
  ctx: BuildLinesContext,
): JeLineInput[] {
  const lines: JeLineInput[] = [];
  for (const slip of payslips) {
    const earnings = parsePayslipLines(slip.earnings);
    const deductions = parsePayslipLines(slip.deductions);

    for (const line of earnings) {
      if (line.statistical) continue; // display-only, never money
      lines.push({
        accountId: ctx.componentExpenseById.get(line.key) ?? ctx.salariesExpenseId,
        debit: line.amount,
        employeeId: slip.userId,
        description: line.label,
      });
    }

    for (const line of deductions) {
      const category = isStatutoryLineKey(line.key)
        ? STATUTORY_LINE_CATEGORY[line.key]
        : undefined;
      if (category) {
        lines.push({
          accountId: ctx.statutoryAccountIds[category],
          credit: line.amount,
          employeeId: slip.userId,
          description: line.label,
        });
      } else {
        lines.push({
          accountId: ctx.componentLiabilityById.get(line.key) ?? ctx.salariesExpenseId,
          credit: line.amount,
          employeeId: slip.userId,
          description: line.label,
        });
      }
    }

    // Employer-side KiwiSaver: gross expense, payable net of ESCT.
    const erGross = toNum(slip.employerKiwiSaverGross);
    const erEsct = toNum(slip.employerEsct);
    const erNet = toNum(slip.employerKiwiSaverNet);
    if (erGross > 0) {
      lines.push({
        accountId: ctx.employerKsExpenseId,
        debit: erGross,
        employeeId: slip.userId,
        description: "Employer KiwiSaver",
      });
    }
    if (erNet > 0) {
      lines.push({
        accountId: ctx.statutoryAccountIds.KIWISAVER_EMPLOYER,
        credit: erNet,
        employeeId: slip.userId,
        description: "Employer KiwiSaver",
      });
    }
    if (erEsct > 0) {
      lines.push({
        accountId: ctx.statutoryAccountIds.ESCT,
        credit: erEsct,
        employeeId: slip.userId,
        description: "ESCT",
      });
    }

    // Net pay clearing — the amount owed to the employee.
    lines.push({
      accountId: ctx.netPayClearingId,
      credit: slip.net,
      employeeId: slip.userId,
      description: `Net pay ${slip.slipNo}`,
    });
  }
  return lines;
}

/** Σ debits − Σ credits for a line set (the balance assertion). */
export function journalBalance(lines: JeLineInput[]): { debit: number; credit: number } {
  let debit = 0;
  let credit = 0;
  for (const l of lines) {
    debit += l.debit ?? 0;
    credit += l.credit ?? 0;
  }
  return { debit: round2(debit), credit: round2(credit) };
}

/** The posting result shape (the created or idempotently-returned entry). */
export interface PostedJournalEntry {
  id: string;
  date: Date;
  memo: string | null;
  status: string;
  sourceType: string;
  sourceId: string | null;
  lines: Array<{ debit: { toNumber(): number }; credit: { toNumber(): number } }>;
}

/** Post one LOCKED payroll run to the general ledger. Idempotent: a
 *  POSTED entry for the run (that is not itself a reversal) is returned,
 *  never duplicated. Throws — before any write — when the run is not
 *  LOCKED, no open accounting period covers its window, or the built
 *  entry is out of balance. */
export async function postPayrollRun(
  runId: string,
  opts?: { postedById?: string },
): Promise<PostedJournalEntry> {
  const run = await db.payrollRun.findUnique({
    where: { id: runId },
    include: {
      payslips: {
        select: {
          userId: true, slipNo: true, earnings: true, deductions: true, net: true,
          employerKiwiSaverGross: true, employerEsct: true, employerKiwiSaverNet: true,
        },
      },
    },
  });
  if (!run) throw new Error(`PayrollRun ${runId} not found`);
  if (run.status !== "LOCKED") throw new Error("Run must be LOCKED before posting");

  // The covering period FIRST: a closed period refuses every posting —
  // including a re-post of an already-posted run (corrections go through a
  // reversal entry in an open period, never through re-posting).
  if (!run.startDate || !run.endDate) {
    throw new Error("Run window dates are missing — pre-P10 rows cannot post");
  }
  const period = await db.accountingPeriod.findFirst({
    where: {
      startDate: { lte: run.startDate },
      endDate: { gte: run.endDate },
    },
  });
  if (!period) throw new Error("No accounting period covers this run");
  if (period.isClosed) throw new Error("Accounting period is closed");

  // Idempotency: the run's POSTED entry (a reversal entry never counts).
  // include lines — the contract (PostedJournalEntry.lines) must hold on
  // this path too, not just on the create path (post-run-to-gl iterates
  // them to print the Dr/Cr proof).
  const existing = await db.journalEntry.findFirst({
    where: { sourceType: "PAYROLL_RUN", sourceId: runId, status: "POSTED", reversalOfId: null },
    include: { lines: true },
  });
  if (existing) return existing as unknown as PostedJournalEntry;

  // The chart lookups (one read each; throws when a system row is gone).
  // Keyed by CATEGORY so both the employee-side line keys and the
  // employer-side legs resolve through one map.
  const [salariesExpense, netPayClearing, employerKsExpense, ...statutoryRows] = await Promise.all([
    getSystemAccount(SALARIES_EXPENSE_CODE),
    getSystemAccount(NET_PAY_CLEARING_CODE),
    getSystemAccount(EMPLOYER_KIWISAVER_EXPENSE_CODE),
    ...Object.values(STATUTORY_ACCOUNT_CODES).map((code) => getSystemAccount(code)),
  ]);
  const statutoryCategories = Object.keys(STATUTORY_ACCOUNT_CODES);
  const statutoryAccountIds: Record<string, string> = {};
  statutoryRows.forEach((row, i) => {
    statutoryAccountIds[statutoryCategories[i]] = row.id;
  });

  // The component→account map (catalog codes are the payslip line keys).
  const components = await db.salaryComponent.findMany({
    select: { code: true, expenseAccountId: true, liabilityAccountId: true },
  });
  const componentExpenseById = new Map<string, string>();
  const componentLiabilityById = new Map<string, string>();
  for (const c of components) {
    if (c.expenseAccountId) componentExpenseById.set(c.code, c.expenseAccountId);
    if (c.liabilityAccountId) componentLiabilityById.set(c.code, c.liabilityAccountId);
  }

  const lines = buildPayrollJournalLines(run.payslips, {
    salariesExpenseId: salariesExpense.id,
    netPayClearingId: netPayClearing.id,
    employerKsExpenseId: employerKsExpense.id,
    statutoryAccountIds,
    componentExpenseById,
    componentLiabilityById,
  });

  // The balance assertion — BEFORE anything is written.
  const { debit, credit } = journalBalance(lines);
  if (Math.abs(debit - credit) > 0.01) {
    throw new Error(`Payroll JE out of balance: Dr ${debit} vs Cr ${credit}`);
  }

  const created = await db.journalEntry.create({
    data: {
      date: run.endDate,
      memo: `Payroll run ${run.id} (${run.period})`,
      periodId: period.id,
      sourceType: "PAYROLL_RUN",
      sourceId: run.id,
      status: "POSTED",
      postedAt: new Date(),
      postedById: opts?.postedById ?? null,
      lines: {
        create: lines.map((l) => ({
          accountId: l.accountId,
          debit: l.debit ?? 0,
          credit: l.credit ?? 0,
          employeeId: l.employeeId ?? null,
          description: l.description ?? null,
        })),
      },
    },
    include: { lines: true },
  });
  return created as unknown as PostedJournalEntry;
}
