// ---------------------------------------------------------------------------
// P1 (PR-12/PR-B10, F2.3) — the PayAdjustment kernel (pure).
// docs/Fernly_HR_Payroll_Enhancement_Plan.md §7.2.1 payroll sweep.
//
// The universal one-off/recurring adjustment adapter (the benchmark's
// Additional Salary): every special payment flow funnels into ONE row and
// the run covering its period resolves the row into payslip lines through
// applyAdjustments — the ONE two-pass ordering kernel:
//
//   Pass 1 (gross-based): FIXED lines first, then PERCENT_OF_GROSS lines.
//     Earnings are resolved before deductions, so a percent-of-gross
//     deduction sees the gross INCLUDING the adjustment earnings of the
//     same slip (documented order — no iteration).
//   Pass 2 (net-based): PERCENT_OF_NET deductions sequentially, each
//     computed on the net remaining after the lines before it (no
//     fixed-point iteration, per the F2.3 spec note).
//
// PERCENT_OF_NET is a DEDUCTION-only mode (the benchmark's net-based rows
// are deductions; an earning on "net" has no stable meaning) — earning
// rows with that mode are skipped with a reason, never silently dropped.
//
// Line keys: a row with a componentCode lands under that key (so catalog
// components merge and OVERWRITE can find the base line); rows without one
// get `adj:<id>` — two hand-made rows never collide unless they share a
// code, in which case they merge (amounts sum, first label wins).
//
// No I/O, no clock, no db — the action layer owns rows and transactions.
// ---------------------------------------------------------------------------

import { round2, lineSum, type PayslipLine } from "@/lib/payroll-math";
import { parsePayrollPeriodKey } from "@/lib/payroll-windows";
import type { OfferComponent } from "@/lib/offer-math";

export type AdjustmentSide = "EARNING" | "DEDUCTION";
export type AdjustmentRecurrence = "ONE_SHOT" | "RECURRING" | "OVERWRITE";
export type AdjustmentCalcMode = "FIXED" | "PERCENT_OF_GROSS" | "PERCENT_OF_NET";
export type AdjustmentStatus = "PENDING" | "CONSUMED" | "SKIPPED";

/** Provenance vocabulary — the special flows that write adapter rows.
 * MANUAL/INCENTIVE are created by hand (payroll:manage); the rest are
 * written by their owning feature (P2 encashment, P3 arrears, …). */
export const ADJUSTMENT_SOURCE_TYPES = [
  "MANUAL",
  "INCENTIVE",
  "ENCASHMENT",
  "ARREARS",
  "LWP_CREDIT",
  "RETENTION_BONUS",
  "BENEFIT_PAYOUT",
  "WITHHOLDING_RELEASE",
] as const;
export type AdjustmentSourceType = (typeof ADJUSTMENT_SOURCE_TYPES)[number];

export const ADJUSTMENT_SIDES: AdjustmentSide[] = ["EARNING", "DEDUCTION"];
export const ADJUSTMENT_RECURRENCES: AdjustmentRecurrence[] = ["ONE_SHOT", "RECURRING", "OVERWRITE"];
export const ADJUSTMENT_CALC_MODES: AdjustmentCalcMode[] = ["FIXED", "PERCENT_OF_GROSS", "PERCENT_OF_NET"];

/** The DB row shape the kernel consumes (camelCase columns verbatim). */
export interface PayAdjustmentRow {
  id: string;
  userId: string;
  sourceType: string;
  sourceId: string;
  componentCode: string;
  label: string;
  side: string;
  recurrence: string;
  calcMode: string;
  percent: number | null;
  amount: number;
  period: string;
  endPeriod: string | null;
  lastConsumedPeriod: string;
  status: string;
  skipReason: string;
  note: string;
}

/** A skip recorded by the kernel — the row refuses to become money and
 * the reason is persisted (skipReason) instead of vanishing. */
export interface AdjustmentSkip {
  id: string;
  reason: string;
}

/** The consumption outcome the action layer persists inside the run's
 * transaction: consumed rows flip CONSUMED (or watermark a RECURRING
 * intermediate period), skipped rows flip SKIPPED with the reason. */
export interface AdjustmentApplication {
  earnings: PayslipLine[];
  deductions: PayslipLine[];
  consumed: Array<{ id: string; final: boolean }>;
  skipped: AdjustmentSkip[];
}

/** Is the row due in `period`? Window-aware since P10 (mixed cadences):
 * comparisons run on the parsed window START dates, never on the raw key
 * strings (lexicographic order breaks chronology across cadences — see
 * lib/payroll-windows.ts). For the monthly keys that predate P10 the
 * behavior is byte-identical.
 *
 * • ONE_SHOT / OVERWRITE: due when the row's window and the run's window
 *   OVERLAP in time — the benchmark's Additional Salary date-overlap
 *   selection (a monthly-targeted one-shot pays in the first run covering
 *   any of its days, a weekly-targeted one in the covering monthly run;
 *   consumption is once, so the first overlapping run carries the money).
 * • RECURRING: due when the run's window starts at/after the row's start
 *   and, with an endPeriod, at/before the end's start — so a monthly
 *   recurring row genuinely fires in every weekly run whose window starts
 *   inside its span (the benchmark's own cross-frequency repetition).
 * Only PENDING rows are ever due (the action layer filters; this predicate
 * is the pure half of that contract). */
export function isDueInPeriod(row: Pick<PayAdjustmentRow, "recurrence" | "period" | "endPeriod">, target: string): boolean {
  const targetStart = parsePayrollPeriodKey(target)?.start ?? null;
  const rowWindow = parsePayrollPeriodKey(row.period);
  if (!targetStart || !rowWindow) return false;

  if (row.recurrence === "RECURRING") {
    if (targetStart.getTime() < rowWindow.start.getTime()) return false;
    if (row.endPeriod == null) return true;
    const endStart = parsePayrollPeriodKey(row.endPeriod)?.start ?? null;
    return endStart != null && targetStart.getTime() <= endStart.getTime();
  }

  // ONE_SHOT / OVERWRITE — the row's window and the run's window overlap
  // in time (the benchmark's Additional Salary date-overlap selection:
  // from_date <= run end AND to_date >= run start). Mutual
  // start-containment and plain overlap are equivalent for closed windows;
  // the overlap form says what it means.
  const targetEnd = parsePayrollPeriodKey(target)?.end ?? null;
  if (!targetEnd) return false;
  return rowWindow.start.getTime() <= targetEnd.getTime() &&
    targetStart.getTime() <= rowWindow.end.getTime();
}

/** Validate one row's shape at CREATION time (the action layer refuses
 * malformed rows before they ever reach a run — the kernel never sees
 * them, so applyAdjustments only guards the residual cases). */
export function validateAdjustmentInput(input: {
  side: string;
  recurrence: string;
  calcMode: string;
  percent: number | null;
  amount: number;
  period: string;
  endPeriod: string | null;
  label: string;
  componentCode: string;
}): string | null {
  if (!ADJUSTMENT_SIDES.includes(input.side as AdjustmentSide)) return "side must be EARNING or DEDUCTION";
  if (!ADJUSTMENT_RECURRENCES.includes(input.recurrence as AdjustmentRecurrence)) {
    return "recurrence must be ONE_SHOT, RECURRING or OVERWRITE";
  }
  if (!ADJUSTMENT_CALC_MODES.includes(input.calcMode as AdjustmentCalcMode)) {
    return "calcMode must be FIXED, PERCENT_OF_GROSS or PERCENT_OF_NET";
  }
  if (input.calcMode === "PERCENT_OF_GROSS" || input.calcMode === "PERCENT_OF_NET") {
    if (input.percent == null || !Number.isFinite(input.percent) || input.percent <= 0 || input.percent > 100) {
      return "percent modes need a percent between 0 and 100";
    }
    if (input.calcMode === "PERCENT_OF_NET" && input.side !== "DEDUCTION") {
      return "percent-of-net is a deduction-only mode (no stable earning basis)";
    }
  }
  if (input.calcMode === "FIXED") {
    if (!Number.isFinite(input.amount) || input.amount < 0) return "fixed adjustments need a non-negative amount";
  }
  if (input.recurrence === "RECURRING" && input.endPeriod != null) {
    const start = parsePayrollPeriodKey(input.period)?.start ?? null;
    const end = parsePayrollPeriodKey(input.endPeriod)?.start ?? null;
    if (start == null || end == null || end.getTime() < start.getTime()) {
      return "endPeriod cannot be before the first period";
    }
  }
  if (!parsePayrollPeriodKey(input.period)) {
    return "period must be a payroll period key (2026-11, 2026-11-A, 2026-W45, 2026-F23, 2026-11-09, 2026-Q4 or 2026)";
  }
  if (!input.label.trim() && !input.componentCode.trim()) {
    return "a label or a catalog component code is required";
  }
  return null;
}

/** The line key a row lands under: its catalog code, else `adj:<id>`
 * (hand-made rows never collide; shared codes merge by design). */
export function adjustmentLineKey(row: Pick<PayAdjustmentRow, "id" | "componentCode">): string {
  return row.componentCode.trim() || `adj:${row.id}`;
}

/** P23 (PR-02/PR-03) — the structure's PERCENT_OF_NET deduction lines as
 * adapter-shaped rows so the SAME two-pass kernel resolves them (one kernel
 * serves adapter + catalog): the run PREPENDS these to its due list, so
 * pass 2 processes the structure's own percent-of-net lines FIRST (the
 * package's deductions see the pay before the period's special payments),
 * sequentially on the running net computed from the docked base (scaled
 * earnings + structure flat deductions + the LOP line).
 *
 * Synthetic rows carry `struct:`-prefixed ids — they are never persisted,
 * never consumed, never skipped into SKIPPED rows; the caller filters the
 * prefix from the kernel's consumed/skipped outcomes (a mismatching id is
 * equally harmless — the id lookups simply miss). */
export function structureNetDeductionRows(components: OfferComponent[]): PayAdjustmentRow[] {
  return components
    .filter((c) => c.kind === "DEDUCTION" && c.mode === "PERCENT_OF_NET")
    .map((c) => ({
      id: `struct:${c.key}`,
      userId: "",
      sourceType: "MANUAL",
      sourceId: "",
      componentCode: c.key,
      label: c.label,
      side: "DEDUCTION",
      recurrence: "ONE_SHOT",
      calcMode: "PERCENT_OF_NET",
      percent: Number.isFinite(c.amount) ? c.amount : null,
      amount: 0,
      period: "",
      endPeriod: null,
      lastConsumedPeriod: "",
      status: "PENDING",
      skipReason: "",
      note: "",
    }));
}

/**
 * Resolve the due adjustment rows onto one payslip's base lines for the
 * run covering `period`.
 *
 * `base` is the slip AFTER the standard computation (structure earnings
 * scaled to the payment window, the auto LOP deduction line applied) —
 * adjustments land on top of the docked pay, then the S7 rounding line
 * wraps the final net (the action layer's order).
 *
 * Pure: base arrays are never mutated; every returned line is a fresh
 * object. Statistical lines ride untouched (S8 discipline).
 */
export function applyAdjustments(
  base: { earnings: PayslipLine[]; deductions: PayslipLine[] },
  rows: PayAdjustmentRow[],
  period: string,
): AdjustmentApplication {
  const earnings: PayslipLine[] = base.earnings.map((l) => ({ ...l }));
  const deductions: PayslipLine[] = base.deductions.map((l) => ({ ...l }));
  const consumed: Array<{ id: string; final: boolean }> = [];
  const skipped: AdjustmentSkip[] = [];

  // ---------- Pass 1: FIXED + PERCENT_OF_GROSS -----------------------------
  // Earnings first so gross-based deductions see the raised gross.
  const grossBasis = () => lineSum(earnings);

  const pass1: PayAdjustmentRow[] = rows.filter(
    (r) => r.calcMode === "FIXED" || r.calcMode === "PERCENT_OF_GROSS",
  );
  const sortedPass1 = [
    ...pass1.filter((r) => r.side === "EARNING"),
    ...pass1.filter((r) => r.side === "DEDUCTION"),
  ];

  for (const row of sortedPass1) {
    // Residual guards (creation-time validation catches these first; a
    // foreign writer bypassing it still gets a visible skip, not a NaN).
    if (row.calcMode === "PERCENT_OF_GROSS" && (row.percent == null || row.percent <= 0 || row.percent > 100)) {
      skipped.push({ id: row.id, reason: "invalid percent" });
      continue;
    }
    if (row.calcMode === "FIXED" && (!Number.isFinite(row.amount) || row.amount < 0)) {
      skipped.push({ id: row.id, reason: "invalid amount" });
      continue;
    }
    const amount =
      row.calcMode === "FIXED" ? round2(row.amount) : round2((grossBasis() * (row.percent as number)) / 100);

    if (row.recurrence === "OVERWRITE") {
      // Replace the same-key line's amount on its side — the benchmark's
      // overwrite semantics (one period, one line).
      const target = (row.side === "EARNING" ? earnings : deductions).find(
        (l) => l.key === adjustmentLineKey(row) && !l.statistical,
      );
      if (!target) {
        skipped.push({ id: row.id, reason: "no matching line to overwrite" });
        continue;
      }
      target.amount = amount;
      consumed.push({ id: row.id, final: isFinalConsumption(row, period) });
      continue;
    }

    // ONE_SHOT / RECURRING: merge by key (shared codes sum; hand-made
    // rows are unique by id-key).
    const key = adjustmentLineKey(row);
    const side = row.side === "DEDUCTION" ? deductions : earnings;
    const existing = side.find((l) => l.key === key && !l.statistical);
    if (existing) {
      existing.amount = round2(existing.amount + amount);
    } else {
      side.push({ key, label: row.label.trim() || row.componentCode.trim() || key, amount });
    }
    consumed.push({ id: row.id, final: isFinalConsumption(row, period) });
  }

  // ---------- Pass 2: PERCENT_OF_NET deductions, sequential ----------------
  let runningNet = round2(grossBasis() - lineSum(deductions));
  const pass2 = rows.filter((r) => r.calcMode === "PERCENT_OF_NET");
  for (const row of pass2) {
    if (row.side !== "DEDUCTION") {
      skipped.push({ id: row.id, reason: "percent-of-net is deduction-only" });
      continue;
    }
    if (row.percent == null || row.percent <= 0 || row.percent > 100) {
      skipped.push({ id: row.id, reason: "invalid percent" });
      continue;
    }
    const amount = round2((runningNet * row.percent) / 100);
    const key = adjustmentLineKey(row);
    const existing = deductions.find((l) => l.key === key && !l.statistical);
    if (existing) {
      existing.amount = round2(existing.amount + amount);
    } else {
      deductions.push({ key, label: row.label.trim() || row.componentCode.trim() || key, amount });
    }
    runningNet = round2(runningNet - amount);
    consumed.push({ id: row.id, final: isFinalConsumption(row, period) });
  }

  return { earnings, deductions, consumed, skipped };
}

/** A RECURRING row's final consumption is the run covering its endPeriod
 * (null end = open-ended, never final — every consumption is an
 * intermediate watermark). ONE_SHOT and OVERWRITE rows are final on their
 * single period. `period` is the consuming run's period key; the comparison
 * runs on parsed window starts (P10 — cadence-safe, monthly-identical). */
function isFinalConsumption(
  row: Pick<PayAdjustmentRow, "recurrence" | "endPeriod">,
  period: string,
): boolean {
  if (row.recurrence !== "RECURRING") return true;
  if (row.endPeriod == null) return false;
  const endStart = parsePayrollPeriodKey(row.endPeriod)?.start ?? null;
  const runStart = parsePayrollPeriodKey(period)?.start ?? null;
  return endStart != null && runStart != null && endStart.getTime() <= runStart.getTime();
}
