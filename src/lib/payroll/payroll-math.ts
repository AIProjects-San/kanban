// ---------------------------------------------------------------------------
// R7 — pure payroll math (docs/RECRUITMENT_MODULE_PLAN.md §5, milestone R7).
//
// Shared by the server actions and the payslip editor UI:
//   • PayslipLine — one MONTHLY money line on a payslip (key/label/amount).
//   • monthlyEarningsFromStructure — resolves the ANNUAL structure
//     components (lib/hiring/offer-math.ts) and divides by 12.
//   • payslipTotals — gross = Σ earnings, net = gross − Σ deductions.
//   • LOP (loss of pay) — pro-rated: gross × lopDays / days-in-period,
//     stored as the auto-managed "lop" deduction line.
// All amounts rounded to 2 decimals at every step (money never drifts).
// ---------------------------------------------------------------------------

import { computeOffer, type OfferComponent } from "@/lib/hiring/offer-math";
import { windowsInYear, type PayrollFrequency } from "@/lib/payroll/payroll-windows";

export interface PayslipLine {
  key: string;
  label: string;
  amount: number;
  /** PR-B02 (S6) — snapshot of the component's depends_on_payment_days.
   * Undefined or true = scales with paid days + docked by LOP; false =
   * window-exempt (flat). Stored sparsely: only false is written, so every
   * pre-S6 JSON line (and every default-true line) stays byte-identical. */
  dependsOnPaymentDays?: boolean;
  /** PR-B03 (S8) — display-only info line (STATISTICAL components): never
   * counted into gross/net, never scaled, never docked. Sparse. */
  statistical?: boolean;
}

export { round2, toCents } from "@/lib/shared/money";
import { round2 } from "@/lib/shared/money";

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
  // Any year — windowsInYear("MONTHLY", ·) is 12 for every year, so the
  // delegate stays clock-free while the cadence callers pass the run's.
  return windowEarningsFromStructure(components, "MONTHLY", 2024);
}

/** P10 (PR-B05) — the per-window earnings lines for a structure on ANY
 * cadence: ANNUAL component amounts ÷ the cadence's windows in the window's
 * start year (Frappe parity — amounts are periodic per the structure's
 * frequency; MONTHLY is the historical ÷ 12, byte-identical). 53-week ISO
 * years genuinely carry 53 weekly windows, so weekly structures pay
 * slightly more in those years (the benchmark's own behavior). */
export function windowEarningsFromStructure(
  components: OfferComponent[],
  frequency: PayrollFrequency,
  year: number,
): PayslipLine[] {
  const totals = computeOffer(components);
  const divisor = windowsInYear(frequency, year);
  return components
    .filter((c) => c.kind === "EARNING" || c.kind === "STATISTICAL")
    .map((c) => ({
      key: c.key,
      label: c.label,
      amount: round2((totals.resolved[c.key] ?? 0) / divisor),
      // S6 — snapshot the payment-days exemption sparsely (only false).
      ...(c.dependsOnPaymentDays === false ? { dependsOnPaymentDays: false } : {}),
      // S8 — statistical lines ride the snapshot flagged, counted nowhere.
      ...(c.kind === "STATISTICAL" ? { statistical: true } : {}),
    }));
}

/** P23 (PR-02) — the per-window DEDUCTION lines for a structure: the
 * FIXED / PERCENT_OF_BASIC / PERCENT_OF_GROSS deduction components the
 * editor has always accepted but the run silently DROPPED (the real
 * PR-02 remainder): annual resolution (the same computeOffer pass) ÷
 * the cadence's windows in the year, FLAT per window — deductions do not
 * scale with paid days (absence already docks the day-scaled earnings
 * through the LOP line; docking the deduction too would pay absent days).
 * PERCENT_OF_NET deduction lines are excluded here — they resolve at
 * payroll time through the two-pass kernel (see structureNetDeductionRows
 * in lib/payroll/pay-adjustment.ts), sequential on the window's running net. */
export function windowDeductionsFromStructure(
  components: OfferComponent[],
  frequency: PayrollFrequency,
  year: number,
): PayslipLine[] {
  const totals = computeOffer(components);
  const divisor = windowsInYear(frequency, year);
  return components
    .filter((c) => c.kind === "DEDUCTION" && c.mode !== "PERCENT_OF_NET")
    .map((c) => ({
      key: c.key,
      label: c.label,
      amount: round2((totals.resolved[c.key] ?? 0) / divisor),
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
    l.dependsOnPaymentDays === false || l.statistical ? l : { ...l, amount: round2(l.amount * fraction) },
  );
}

/** PR-B02 (S6) — the loss-of-pay basis: Σ earnings that still depend on
 * payment days (exempt lines are not docked by LOP either — a flat
 * allowance cannot be reduced by absent days). Rounded like gross. */
export function lopBasisGross(earnings: PayslipLine[]): number {
  return round2(
    earnings.reduce(
      (sum, l) => (Number.isFinite(l.amount) && l.dependsOnPaymentDays !== false && !l.statistical ? sum + l.amount : sum),
      0,
    ),
  );
}

export function lineSum(lines: PayslipLine[]): number {
  // S8 — statistical (display-only) lines are never money.
  return round2(lines.reduce((sum, l) => (Number.isFinite(l.amount) && !l.statistical ? sum + l.amount : sum), 0));
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

/** Phase 2 (engine wiring) — the auto-managed statutory deduction line keys
 * (the NZ engine's employee-side lines; employer-side money lives only in
 * the Payslip.statutory snapshot). Like LOP and rounding they are replaced,
 * never duplicated, and never submitted by the editor: the server recomputes
 * them from the run's frozen rate set on every save while the run is OPEN. */
export const PAYE_LINE_KEY = "paye";
export const ACC_LEVY_LINE_KEY = "acc";
export const KIWISAVER_LINE_KEY = "ks";
export const STUDENT_LOAN_LINE_KEY = "sl";
export const STATUTORY_LINE_KEYS = [
  PAYE_LINE_KEY,
  ACC_LEVY_LINE_KEY,
  KIWISAVER_LINE_KEY,
  STUDENT_LOAN_LINE_KEY,
] as const;

/** True when the line is one of the auto-managed statutory lines. */
export function isStatutoryLineKey(key: string): boolean {
  return (STATUTORY_LINE_KEYS as readonly string[]).includes(key);
}

/** PR-B23 (S7) — the auto-managed rounding line key (the benchmark's
 * rounded-total row, as a visible line so net always equals Σ lines). */
export const ROUNDING_LINE_KEY = "rounding";

/** PR-B23 (S7) — the workspace rounding policy. ROUND_2DP (default) = the
 * historical discipline, no rounding line. ROUND_NET_NEAREST = the slip
 * carries an auto "Rounding" line (earning when it pays up, deduction when
 * it docks down) that brings NET to the nearest whole dollar. Pure. */
export type PayrollRoundingMode = "ROUND_2DP" | "ROUND_NET_NEAREST";

/** The adjustment that rounds net to the nearest integer:
 * nearest − net (positive → the slip pays up; negative → docks down). */
export function computeRoundingAdjustment(net: number, mode: PayrollRoundingMode): number {
  if (mode !== "ROUND_NET_NEAREST") return 0;
  return round2(Math.round(net) - net);
}

/** Place (or remove) the auto rounding line on a slip's line sets: the
 * adjustment rides EARNINGS when positive and DEDUCTIONS when negative, so
 * amount signs stay non-negative everywhere. Replaces, never duplicates. */
export function withRoundingLine(
  earnings: PayslipLine[],
  deductions: PayslipLine[],
  mode: PayrollRoundingMode,
): { earnings: PayslipLine[]; deductions: PayslipLine[] } {
  const cleanEarnings = earnings.filter((l) => l.key !== ROUNDING_LINE_KEY);
  const cleanDeductions = deductions.filter((l) => l.key !== ROUNDING_LINE_KEY);
  const net = round2(
    cleanEarnings.reduce((s, l) => (Number.isFinite(l.amount) && !l.statistical ? s + l.amount : s), 0) -
      cleanDeductions.reduce((s, l) => s + (Number.isFinite(l.amount) ? l.amount : 0), 0),
  );
  const adj = computeRoundingAdjustment(net, mode);
  if (adj === 0) return { earnings: cleanEarnings, deductions: cleanDeductions };
  if (adj > 0) {
    return {
      earnings: [...cleanEarnings, { key: ROUNDING_LINE_KEY, label: "Rounding", amount: adj }],
      deductions: cleanDeductions,
    };
  }
  return {
    earnings: cleanEarnings,
    deductions: [...cleanDeductions, { key: ROUNDING_LINE_KEY, label: "Rounding", amount: -adj }],
  };
}

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
/** LV-B10 (S10) — the "YYYY-MM" months a date range touches (inclusive),
 * in ascending order. Pure input of the salary-processed guard: unpaid leave
 * cannot overlap a month whose payroll run is already LOCKED. */
export function monthsInRange(start: Date, end: Date): string[] {
  const out: string[] = [];
  if (!(start <= end)) return out;
  const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  const last = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
  while (cursor <= last) {
    out.push(`${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, "0")}`);
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return out;
}

export function isPayrollPeriod(period: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(period);
}
