// ---------------------------------------------------------------------------
// P39 (EM-16's advances half, EX-03 lite) — salary advances
// (docs/Fernly_HR_Payroll_Enhancement_Plan.md §7.2 P39). Pure so both
// sides import it: the issue/recovery actions and the FnF receivable.
//
// The lifecycle:
//   issue    → ONE SalaryAdvance row (OPEN) + N equal DEDUCTION-side
//              RECURRING PayAdjustment rows (sourceType SALARY_ADVANCE,
//              sourceId the advance's id — the P1 adapter carries the
//              recovery; the plan's own architecture).
//   recovery → each consuming run eats one installment; the run that
//              consumes the FINAL row flips the advance RECOVERED
//              (the lock transaction's existing PENDING→CONSUMED walk
//              gains the flip — provenance-linked, no new scheduler).
//
// The FnF receivable: an OPEN advance's outstanding = amount − the
// sum of its CONSUMED adjustment rows (what the paychecks have not yet
// returned). Loans proper stay the later un-decline epic.
// ---------------------------------------------------------------------------

import { round2 } from "@/lib/payroll-math";

export const SALARY_ADVANCE_STATUSES = ["OPEN", "RECOVERED"] as const;
export type SalaryAdvanceStatus = (typeof SALARY_ADVANCE_STATUSES)[number];

export const SALARY_ADVANCE_STATUS_LABELS: Record<SalaryAdvanceStatus, string> = {
  OPEN: "Open",
  RECOVERED: "Recovered",
};

/** The installment amount: equal split, each rounded to cents, the LAST
 *  installment absorbing the rounding remainder so the plan always sums
 *  to the advance exactly (never a stray cent lost or created). */
export function installmentPlan(
  amount: number,
  installments: number,
): number[] {
  const n = Math.max(1, Math.floor(installments));
  if (!(amount > 0)) return [];
  if (n === 1) return [round2(amount)];
  const even = Math.floor((amount / n) * 100) / 100;
  const plan = Array.from({ length: n }, () => even);
  plan[n - 1] = round2(amount - even * (n - 1));
  return plan;
}

/** An advance's outstanding at read time: the amount minus whatever its
 *  CONSUMED adjustment rows already returned. Pure — the action reads the
 *  rows and passes the sums. */
export function outstandingAdvance(
  advance: { amount: number; status: string },
  consumedTotal: number,
): number {
  if (advance.status === "RECOVERED") return 0;
  return round2(Math.max(0, advance.amount - consumedTotal));
}

/** The one-line status the advance card shows:
 *  "$600.00 outstanding of $1,200 · 2 of 4 installments repaid". */
export function advanceSummary(input: {
  amount: number;
  status: string;
  installments: number;
  consumedCount: number;
  consumedTotal: number;
}): { outstanding: number; summary: string } {
  const outstanding = outstandingAdvance(input, input.consumedTotal);
  if (input.status === "RECOVERED") {
    return { outstanding: 0, summary: `recovered in full (${input.installments} installment${input.installments === 1 ? "" : "s"})` };
  }
  const repaid = Math.min(input.consumedCount, input.installments);
  return {
    outstanding,
    summary: input.installments === 1
      ? `$${outstanding.toFixed(2)} outstanding`
      : `$${outstanding.toFixed(2)} outstanding · ${repaid} of ${input.installments} installments repaid`,
  };
}

/** Validation twin of the zod schema (the pure guard for tests and any
 *  non-zod caller): a sane advance has a positive amount, 1–24
 *  installments and a "YYYY-MM" start period. */
export function isValidAdvanceInput(input: {
  amount: number;
  installments: number;
  startPeriod: string;
}): boolean {
  if (!(input.amount > 0)) return false;
  if (!Number.isInteger(input.installments) || input.installments < 1 || input.installments > 24) return false;
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(input.startPeriod);
}

/** The FnF receivable facts for one advance row (the action assembles the
 *  consumed totals; this derives the display fields). */
export function fnfAdvanceReceivable(input: {
  amount: number;
  status: string;
  consumedTotal: number;
}): { outstanding: number; isReceivable: boolean } {
  const outstanding = outstandingAdvance(input, input.consumedTotal);
  return { outstanding, isReceivable: outstanding > 0 };
}
