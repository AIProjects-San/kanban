// ---------------------------------------------------------------------------
// G3 — full loan management (docs plan §"loan management"): the pure
// amortization + lifecycle kernel every side imports (the actions, the
// FnF receivable, the tests).
//
// The lifecycle (mirrors the G6 employment-document discipline, ADR-019):
//   DRAFT → PENDING_APPROVAL → APPROVED → ACTIVE → CLOSED
//   (any pre-ACTIVE state → CANCELLED; PENDING_APPROVAL → REJECTED).
// Four-eyes: the approver must differ from the creator.
//
// The payroll rider (the salary-advance precedent, P39):
//   ACTIVATION writes the LoanSchedule rows + ONE DEDUCTION-side ONE_SHOT
//   PayAdjustment row per installment (sourceType LOAN_INSTALLMENT,
//   sourceId the schedule row, period the installment's due month). The
//   run consumes those rows generically inside its own creation
//   transaction — createPayrollRun itself needs no loan code. The loan
//   bookkeeping (schedule PAID flips + LoanRepayment rows + the
//   outstanding-balance walk + the CLOSED flip) is settleLoansForRun's
//   job, driven by the adapter rows' consumedRunId back-link (the
//   encashment PAID precedent).
//
// Money is Float by the codebase's money convention (PayAdjustment.amount
// and every payroll kernel are float + round2; the amortization is
// cent-exact by construction — the LAST installment absorbs the rounding
// remainder, the salary-advance rule).
// ---------------------------------------------------------------------------

import { addMonths, dayKey, parseDay } from "@/lib/hr/working-days";
import { round2 } from "@/lib/payroll/payroll-math";
import { parsePayrollPeriodKey } from "@/lib/payroll/payroll-windows";

// ---------------------------------------------------------------------------
// Status machine
// ---------------------------------------------------------------------------

export const LOAN_STATUSES = [
  "DRAFT",
  "PENDING_APPROVAL",
  "APPROVED",
  "ACTIVE",
  "CLOSED",
  "REJECTED",
  "CANCELLED",
] as const;
export type LoanStatus = (typeof LOAN_STATUSES)[number];

export const LOAN_STATUS_LABELS: Record<LoanStatus, string> = {
  DRAFT: "Draft",
  PENDING_APPROVAL: "Pending approval",
  APPROVED: "Approved",
  ACTIVE: "Active",
  CLOSED: "Closed (repaid)",
  REJECTED: "Rejected",
  CANCELLED: "Cancelled",
};

/** The one-line status badge tone (mirrors the G6 badge map). */
export const LOAN_STATUS_BADGE: Record<LoanStatus, string> = {
  DRAFT: "bg-muted text-muted-foreground",
  PENDING_APPROVAL: "bg-amber-500/10 text-amber-700",
  APPROVED: "bg-blue-500/10 text-blue-700",
  ACTIVE: "bg-emerald-500/10 text-emerald-700",
  CLOSED: "bg-sky-500/10 text-sky-700",
  REJECTED: "bg-destructive/10 text-destructive",
  CANCELLED: "bg-muted text-muted-foreground",
};

/** The legal forward graph. Pre-ACTIVE states may cancel; nothing moves
 *  out of the terminal trio (CLOSED / REJECTED / CANCELLED). */
export const LOAN_TRANSITIONS: Record<LoanStatus, LoanStatus[]> = {
  DRAFT: ["PENDING_APPROVAL", "CANCELLED"],
  PENDING_APPROVAL: ["APPROVED", "REJECTED", "CANCELLED"],
  APPROVED: ["ACTIVE", "CANCELLED"],
  ACTIVE: ["CLOSED"],
  CLOSED: [],
  REJECTED: [],
  CANCELLED: [],
};

export function canTransitionLoan(from: string, to: string): boolean {
  const edges = LOAN_TRANSITIONS[from as LoanStatus];
  return Array.isArray(edges) && edges.includes(to as LoanStatus);
}

/** Statuses a creator (or an admin) may still cancel from. */
export const CANCELABLE_LOAN_STATUSES: LoanStatus[] = ["DRAFT", "PENDING_APPROVAL", "APPROVED"];

export function isCancelableLoan(status: string): boolean {
  return CANCELABLE_LOAN_STATUSES.includes(status as LoanStatus);
}

// ---------------------------------------------------------------------------
// Schedule + repayment row states
// ---------------------------------------------------------------------------

export const LOAN_SCHEDULE_STATUSES = ["SCHEDULED", "PAID", "SKIPPED", "WRITTEN_OFF"] as const;
export type LoanScheduleStatus = (typeof LOAN_SCHEDULE_STATUSES)[number];

export const LOAN_SCHEDULE_STATUS_LABELS: Record<LoanScheduleStatus, string> = {
  SCHEDULED: "Scheduled",
  PAID: "Paid",
  SKIPPED: "Skipped",
  WRITTEN_OFF: "Written off",
};

export const LOAN_REPAYMENT_SOURCES = ["PAYROLL", "MANUAL", "FINAL_SETTLEMENT"] as const;
export type LoanRepaymentSource = (typeof LOAN_REPAYMENT_SOURCES)[number];

export const LOAN_REPAYMENT_SOURCE_LABELS: Record<LoanRepaymentSource, string> = {
  PAYROLL: "Payroll deduction",
  MANUAL: "Manual / early repayment",
  FINAL_SETTLEMENT: "Final settlement (FnF)",
};

export function isLoanRepaymentSource(value: string): value is LoanRepaymentSource {
  return (LOAN_REPAYMENT_SOURCES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Amortization
// ---------------------------------------------------------------------------

/** One installment of the amortization schedule. */
export interface LoanSchedulePlanRow {
  installmentNo: number;
  /** ISO day the installment falls due (startDate + n months, end-of-month
   *  clamped — Jan 31 + 1 → Feb 28/29). */
  dueDay: string;
  /** The "YYYY-MM" payroll period the due day falls in — the adapter row's
   *  target period (the run covering any of that month consumes it). */
  duePeriod: string;
  principalPortion: number;
  interestPortion: number;
  totalAmount: number;
  /** The reducing balance AFTER this installment (informational; the loan
   *  row's stored outstandingBalance is the runtime truth). */
  balanceAfter: number;
}

/**
 * The standard reducing-balance (annuity) schedule:
 *   EMI  = P · r · (1+r)^n / ((1+r)^n − 1),  r = annualRate / 12
 *   interest_i  = round2(balance · r)
 *   principal_i = round2(EMI − interest_i)
 * The LAST installment absorbs the rounding remainder so the principal
 * portions sum to the principal EXACTLY (never a stray cent — the
 * salary-advance rule) and the final row clears the balance to 0.
 *
 * Zero interest (rate 0) degrades to equal principal portions with zero
 * interest — the spec's rule, and the annuity formula's own limit.
 */
export function amortizeLoan(input: {
  principal: number;
  /** Annual nominal rate as a fraction (0.05 = 5% p.a.; 0 = interest-free). */
  annualRate: number;
  termMonths: number;
  /** ISO day the loan activates from (installment 1 due +1 month). */
  startDay: string;
}): LoanSchedulePlanRow[] {
  const n = Math.max(1, Math.floor(input.termMonths));
  const principal = round2(input.principal);
  if (!(principal > 0)) return [];
  const r = input.annualRate > 0 ? input.annualRate / 12 : 0;

  const rows: LoanSchedulePlanRow[] = [];
  let balance = principal;
  // The unrounded EMI; each row's portions round to cents, the last row
  // absorbs whatever the rounding left behind.
  const emi = r > 0
    ? (principal * r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1)
    : principal / n;

  for (let i = 1; i <= n; i++) {
    const dueDay = addMonths(input.startDay, i);
    let interestPortion = round2(balance * r);
    // Interest never exceeds the remaining balance on tiny tails (the
    // last cent of a near-zero balance cannot manufacture money).
    if (interestPortion > balance - 0.005 && i === n) interestPortion = round2(Math.max(0, balance));
    let principalPortion: number;
    if (i === n) {
      // Final row: clear the balance exactly and keep the EMI shape honest.
      principalPortion = round2(balance);
      if (r > 0) {
        // The EMI's last row = whatever principal is left + its interest;
        // if the rounded EMI cannot cover the remaining principal plus the
        // accrued interest, the interest takes the squeeze (never the
        // principal — the loan must close at exactly 0).
        const maxInterest = round2(Math.max(0, emi - principalPortion));
        interestPortion = Math.min(interestPortion, maxInterest);
      } else {
        interestPortion = 0;
      }
    } else {
      principalPortion = round2(emi - interestPortion);
      // Guard: on hostile rates the annuity split can invert (interest ≥
      // EMI) — clamp so every non-final row still retires SOME principal
      // and the final row closes (negative amortization is refused by
      // validation long before here; this is the belt).
      if (principalPortion <= 0) principalPortion = 0.01;
      if (principalPortion > balance) principalPortion = round2(balance);
    }
    balance = round2(balance - principalPortion);
    rows.push({
      installmentNo: i,
      dueDay,
      duePeriod: dueDay.slice(0, 7),
      principalPortion,
      interestPortion,
      totalAmount: round2(principalPortion + interestPortion),
      balanceAfter: balance,
    });
  }
  // Exactness guards (defensive; the construction above guarantees them).
  const sumPrincipal = round2(rows.reduce((s, x) => s + x.principalPortion, 0));
  if (sumPrincipal !== principal && rows.length > 0) {
    const drift = round2(principal - sumPrincipal);
    rows[rows.length - 1].principalPortion = round2(rows[rows.length - 1].principalPortion + drift);
    rows[rows.length - 1].totalAmount = round2(
      rows[rows.length - 1].principalPortion + rows[rows.length - 1].interestPortion,
    );
  }
  return rows;
}

/** True when the schedule plan's principal portions sum to the principal
 *  exactly and the final row clears the balance (the invariant tests pin). */
export function schedulePlanIsExact(
  rows: LoanSchedulePlanRow[],
  principal: number,
): boolean {
  if (rows.length === 0) return false;
  const sum = round2(rows.reduce((s, x) => s + x.principalPortion, 0));
  return sum === round2(principal) && rows[rows.length - 1].balanceAfter === 0;
}

// ---------------------------------------------------------------------------
// Due-ness + settlement planning
// ---------------------------------------------------------------------------

/** The schedule rows due inside a payroll period key ("2026-11", "2026-W45",
 *  …): the row's due day falls within the parsed window. */
export function installmentsDueInPeriod(
  rows: Array<{ dueDay: string; status: string }>,
  periodKey: string,
): Array<{ dueDay: string; status: string }> {
  const window = parsePayrollPeriodKey(periodKey);
  if (!window) return [];
  return rows.filter((row) => {
    const t = parseDay(row.dueDay).getTime();
    return t >= window.start.getTime() && t <= window.end.getTime();
  });
}

/** The early-repayment / final-settlement plan: pay the outstanding
 *  principal (required) plus an optional interest adjustment (the waived
 *  future interest), closing the loan and marking every remaining
 *  SCHEDULED installment paid. */
export function settlementPlan(input: {
  outstandingBalance: number;
  interestAdjustment: number;
}): { principal: number; interest: number; total: number } {
  const principal = round2(Math.max(0, input.outstandingBalance));
  const interest = round2(Math.max(0, input.interestAdjustment || 0));
  return { principal, interest, total: round2(principal + interest) };
}

// ---------------------------------------------------------------------------
// Validation twin (the pure guard for tests and non-zod callers)
// ---------------------------------------------------------------------------

export function isValidLoanInput(input: {
  principal: number;
  termMonths: number;
  annualRate: number;
  maxAmount: number | null;
  maxTermMonths: number | null;
}): string | null {
  if (!(input.principal > 0)) return "The principal must be positive.";
  if (input.maxAmount != null && input.principal > input.maxAmount) {
    return `The principal exceeds this loan type's maximum of $${input.maxAmount.toFixed(2)}.`;
  }
  if (!Number.isInteger(input.termMonths) || input.termMonths < 1 || input.termMonths > 360) {
    return "The term must be 1–360 months.";
  }
  if (input.maxTermMonths != null && input.termMonths > input.maxTermMonths) {
    return `The term exceeds this loan type's maximum of ${input.maxTermMonths} months.`;
  }
  if (!(input.annualRate >= 0) || input.annualRate > 1) {
    return "The annual interest rate must be between 0 and 1 (0.08 = 8% p.a.).";
  }
  // Negative amortization guard: the annuity must retire principal on
  // every row (a rate so high the EMI is interest-only or worse).
  const rows = amortizeLoan({
    principal: input.principal,
    annualRate: input.annualRate,
    termMonths: input.termMonths,
    startDay: "2026-01-01",
  });
  if (rows.length === 0) return "The amortization schedule could not be built.";
  if (rows.some((r) => r.principalPortion <= 0)) {
    return "That rate is too high for the term — installments would not retire principal. Lower the rate or extend the term.";
  }
  return null;
}

/** The FnF receivable facts for one active loan (the action assembles the
 *  live outstanding; this derives the display fields — the P39 advance
 *  pattern). */
export function fnfLoanReceivable(input: {
  principal: number;
  outstanding: number;
  typeName: string;
}): { outstanding: number; isReceivable: boolean } {
  const outstanding = round2(Math.max(0, input.outstanding));
  return { outstanding, isReceivable: outstanding > 0 };
}

/** The one-line summary the loan card shows (the advanceSummary twin). */
export function loanSummary(input: {
  principal: number;
  outstandingBalance: number;
  termMonths: number;
}): { outstanding: number; summary: string } {
  const outstanding = round2(Math.max(0, input.outstandingBalance));
  return {
    outstanding,
    summary: `$${outstanding.toFixed(2)} outstanding of $${input.principal.toFixed(2)} · ${input.termMonths} month${input.termMonths === 1 ? "" : "s"}`,
  };
}

/** Today as an ISO day (UTC) — the kernel's single "now" derivation so
 *  tests and callers agree on the day granularity. */
export function loanToday(now: Date = new Date()): string {
  return dayKey(now);
}
