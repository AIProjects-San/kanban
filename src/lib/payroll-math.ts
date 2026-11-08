// ---------------------------------------------------------------------------
// R7 — pure payroll math (docs/RECRUITMENT_MODULE_PLAN.md §5, milestone R7).
//
// Shared by the server actions and the payslip editor UI:
//   • PayslipLine — one MONTHLY money line on a payslip (key/label/amount).
//   • monthlyEarningsFromStructure — resolves the ANNUAL structure
//     components (lib/offer-math.ts) and divides by 12.
//   • payslipTotals — gross = Σ earnings, net = gross − Σ deductions.
//   • LOP (loss of pay) — pro-rated: gross × lopDays / days-in-period,
//     stored as the auto-managed "lop" deduction line.
// All amounts rounded to 2 decimals at every step (money never drifts).
// ---------------------------------------------------------------------------

import { computeOffer, type OfferComponent } from "@/lib/offer-math";

export interface PayslipLine {
  key: string;
  label: string;
  amount: number;
  /** PR-B02 (S6) — snapshot of the component's depends_on_payment_days.
   * Undefined or true = scales with paid days + docked by LOP; false =
   * window-exempt (flat). Stored sparsely: only false is written, so every
   * pre-S6 JSON line (and every default-true line) stays byte-identical. */
  dependsOnPaymentDays?: boolean;
}

export function round2(n: number): number {
  return Math.round((Number.isFinite(n) ? n : 0) * 100) / 100;
}

/** Days in a "YYYY-MM" period (the month's length). */
export function daysInPeriod(period: string): number {
  const [y, m] = period.split("-").map(Number);
  if (!y || !m || m < 1 || m > 12) return 30;
  return new Date(y, m, 0).getDate();
}

/** The monthly earnings lines for a structure: EARNING components resolved
 * annually (fixed or % of basic) then ÷ 12, rounded per line. Employer
 * contributions stay off the payslip (they are not employee earnings). */
export function monthlyEarningsFromStructure(components: OfferComponent[]): PayslipLine[] {
  const totals = computeOffer(components);
  return components
    .filter((c) => c.kind === "EARNING")
    .map((c) => ({
      key: c.key,
      label: c.label,
      amount: round2((totals.resolved[c.key] ?? 0) / 12),
      // S6 — snapshot the payment-days exemption sparsely (only false).
      ...(c.dependsOnPaymentDays === false ? { dependsOnPaymentDays: false } : {}),
    }));
}

/** PR-B06 (S5) — scale a full-month earning set to the paid window.
 * Pure: each line × paidDays / denominator, rounded per line (the snapshot
 * discipline keeps whatever numbers are stored — scaling happens once, at
 * run/slip creation, never on read). paidDays == denominator (or null)
 * returns the SAME numbers (non-clipped employees stay byte-identical);
 * a non-positive denominator guards the degenerate empty-calendar run. */
export function scaleEarningsToPaidDays(
  earnings: PayslipLine[],
  paidDays: number | null | undefined,
  denominator: number | null | undefined,
): PayslipLine[] {
  if (
    paidDays == null ||
    denominator == null ||
    !Number.isFinite(denominator) ||
    denominator <= 0 ||
    paidDays >= denominator
  ) {
    return earnings;
  }
  const fraction = paidDays / denominator;
  // PR-B02 (S6) — window-exempt lines (dependsOnPaymentDays === false) stay
  // flat: they pay the same whether the month was clipped or not.
  return earnings.map((l) =>
    l.dependsOnPaymentDays === false ? l : { ...l, amount: round2(l.amount * fraction) },
  );
}

/** PR-B02 (S6) — the loss-of-pay basis: Σ earnings that still depend on
 * payment days (exempt lines are not docked by LOP either — a flat
 * allowance cannot be reduced by absent days). Rounded like gross. */
export function lopBasisGross(earnings: PayslipLine[]): number {
  return round2(
    earnings.reduce(
      (sum, l) => (Number.isFinite(l.amount) && l.dependsOnPaymentDays !== false ? sum + l.amount : sum),
      0,
    ),
  );
}

export function lineSum(lines: PayslipLine[]): number {
  return round2(lines.reduce((sum, l) => sum + (Number.isFinite(l.amount) ? l.amount : 0), 0));
}

/** gross = Σ earnings; net = gross − Σ deductions (both rounded). */
export function payslipTotals(earnings: PayslipLine[], deductions: PayslipLine[]): { gross: number; net: number } {
  const gross = lineSum(earnings);
  return { gross, net: round2(gross - lineSum(deductions)) };
}

/** Pro-rated loss-of-pay amount: gross × days / periodDays.
 * `workingDays` (F1.1) is the run's holiday-aware denominator — when omitted
 * or non-positive (pre-F1.1 runs, empty calendar) the calendar length of the
 * month is used, preserving the historical behavior. */
export function computeLop(gross: number, lopDays: number, period: string, workingDays?: number): number {
  if (lopDays <= 0 || gross <= 0) return 0;
  const denom = workingDays && workingDays > 0 ? workingDays : daysInPeriod(period);
  return round2((gross * lopDays) / denom);
}

/** The auto-managed LOP deduction line key (replaced, never duplicated). */
export const LOP_LINE_KEY = "lop";

/** Replace (or remove) the LOP deduction line for the given inputs; manual
 * deduction lines are preserved untouched. `workingDays` (F1.1) overrides
 * the denominator — see computeLop. */
export function withLopLine(
  deductions: PayslipLine[],
  gross: number,
  lopDays: number,
  period: string,
  workingDays?: number,
): PayslipLine[] {
  const rest = deductions.filter((l) => l.key !== LOP_LINE_KEY);
  if (lopDays <= 0) return rest;
  const amount = computeLop(gross, lopDays, period, workingDays);
  if (amount <= 0) return rest;
  return [...rest, { key: LOP_LINE_KEY, label: `Loss of pay (${lopDays} day${lopDays === 1 ? "" : "s"})`, amount }];
}

/** Parse a PayslipLine[] JSON string defensively (schema stores TEXT). */
export function parsePayslipLines(json: string): PayslipLine[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (l): l is PayslipLine =>
        !!l && typeof l === "object" &&
        typeof (l as PayslipLine).key === "string" &&
        typeof (l as PayslipLine).label === "string" &&
        typeof (l as PayslipLine).amount === "number",
    );
  } catch {
    return [];
  }
}

/** The current month as a payroll period ("YYYY-MM") — the default value for
 * the new-run picker. */
export function currentPeriod(now: Date = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

/** True when `period` parses as a valid "YYYY-MM" month. */
export function isPayrollPeriod(period: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(period);
}
