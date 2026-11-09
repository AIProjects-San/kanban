// ---------------------------------------------------------------------------
// P8 (PR-19/PR-B13, F3.3) — salary withholding, pure computation
// (docs/Fernly_HR_Payroll_Enhancement_Plan.md §7.2.1 payroll sweep, item 8;
//  benchmark Salary Withholding, workspace scope — the lite state machine).
//
// THE STATE MACHINE (all states visible, never silent):
//   SalaryWithholding row:  ACTIVE ──release──▶ RELEASED (terminal; a new
//                           hold is a new row)
//   Payslip.withholdStatus: "" (normal, paid with its run) | WITHHELD (net
//                           held — computed and frozen but NOT disbursed;
//                           YTD/self-service exclude it) | RELEASED (the
//                           held net was paid via a WITHHELD_RELEASE
//                           adjustment in a later period — the money counts
//                           exactly once, there).
//
// Slips are stamped WITHHELD at CREATION (run creation / addPayslip) when
// an ACTIVE window covers the run's period — never retroactively: a hold
// only affects periods whose slips do not exist yet (the fromPeriod run
// being LOCKED is refused at creation). The release reads the stored nets
// (frozen money — an OPEN-run slip edited later re-freezes whatever its
// net is at release time) and plans one adapter row per held slip.
//
// HONESTY RULES
//   • Overlapping ACTIVE windows for one employee are refused (one hold at
//     a time; the error names both windows).
//   • Zero-net held slips release nothing and are listed as no-pay skips —
//     visible, not silently dropped.
//   • The release plan shows its own work: per-slip amounts, the total, and
//     the release period every row lands in.
// ---------------------------------------------------------------------------

import { parsePayrollPeriodKey } from "@/lib/payroll-windows";

/** "" | WITHHELD | RELEASED — the literal union the payslip column stores. */
export type WithholdStatus = "" | "WITHHELD" | "RELEASED";

/** A window as the kernel consumes it (a SalaryWithholding row, or an
 * ACTIVE-row subset: boundaries are period keys — monthly "YYYY-MM" by
 * the modal, any P10 cadence key by the run side). */
export interface WithholdingWindow {
  fromPeriod: string;
  untilPeriod: string | null;
}

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** P10 — the period key's window start, or null when unparseable. The
 * hold boundaries themselves stay monthly (the modal is a month picker);
 * the RUN side can be any cadence, so comparisons must be window-based:
 * a hold from 2026-11 must also stamp the weekly 2026-W45 slip, which the
 * old string compare silently missed ('W' > '1'). */
function keyStartMs(key: string | null): number | null {
  if (key == null) return null;
  return parsePayrollPeriodKey(key)?.start.getTime() ?? null;
}

/** Is `period` (any cadence key) covered by the hold window? Held when the
 * run's window starts at/after the hold's from-window start and, with an
 * until, at/before the until-window END — the hold covers the WHOLE until
 * period ("until 2026-12" holds all of December, exactly what the monthly
 * string rule meant; a weekly December run and the 2026-12-B half are
 * therefore held too). Monthly keys behave exactly as the pre-P10 string
 * compare. */
export function isPeriodHeld(window: WithholdingWindow, period: string): boolean {
  const runStart = keyStartMs(period);
  const fromStart = keyStartMs(window.fromPeriod);
  if (runStart == null || fromStart == null) return false;
  if (runStart < fromStart) return false;
  if (window.untilPeriod !== null) {
    const untilEnd = parsePayrollPeriodKey(window.untilPeriod)?.end.getTime() ?? null;
    if (untilEnd == null || runStart > untilEnd) return false;
  }
  return true;
}

/** Two windows overlap when any period can satisfy both (from-start vs
 * until-END comparison; open-ended ends compare as +∞). */
export function windowsOverlap(a: WithholdingWindow, b: WithholdingWindow): boolean {
  const aStart = keyStartMs(a.fromPeriod);
  const bStart = keyStartMs(b.fromPeriod);
  if (aStart == null || bStart == null) return false;
  const aEnd = a.untilPeriod == null ? Number.POSITIVE_INFINITY : parsePayrollPeriodKey(a.untilPeriod)?.end.getTime() ?? null;
  const bEnd = b.untilPeriod == null ? Number.POSITIVE_INFINITY : parsePayrollPeriodKey(b.untilPeriod)?.end.getTime() ?? null;
  if (aEnd == null || bEnd == null) return false;
  return aStart <= bEnd && bStart <= aEnd;
}

/** Pure validation of a hold-window draft. */
export function validateWithholdingWindow(input: {
  fromPeriod: string;
  untilPeriod: string | null;
}): { ok: true } | { ok: false; reason: string } {
  if (!PERIOD_RE.test(input.fromPeriod)) {
    return { ok: false, reason: "Pick a valid hold-from month (YYYY-MM)." };
  }
  if (input.untilPeriod !== null && !PERIOD_RE.test(input.untilPeriod)) {
    return { ok: false, reason: "Pick a valid hold-until month (YYYY-MM), or leave it open-ended." };
  }
  if (input.untilPeriod !== null && input.untilPeriod < input.fromPeriod) {
    return { ok: false, reason: "The hold-until month cannot be before the hold-from month." };
  }
  return { ok: true };
}

/** One held payslip as the release planner sees it (stored facts only). */
export interface HeldSlipInput {
  id: string;
  slipNo: string;
  period: string;
  /** The frozen stored net (what was held). */
  net: number;
}

export interface ReleasePlanRow {
  payslipId: string;
  slipNo: string;
  period: string;
  amount: number;
}

export interface WithholdingReleasePlan {
  /** Per-slip adapter rows (money-bearing slips only). */
  rows: ReleasePlanRow[];
  /** Σ row amounts, rounded once. */
  total: number;
  /** Held slips that pay nothing (net 0) — visible, never dropped. */
  zeroNetSlips: Array<{ slipNo: string; period: string }>;
}

/** Plan the release: one WITHHELD_RELEASE row per held slip, each carrying
 * its own frozen net into the chosen release period. */
export function planWithholdingRelease(input: {
  slips: HeldSlipInput[];
  releasePeriod: string;
}): WithholdingReleasePlan {
  if (!PERIOD_RE.test(input.releasePeriod)) {
    throw new Error("Invalid release period"); // guarded by the schema layer
  }
  const rows: ReleasePlanRow[] = [];
  const zeroNetSlips: Array<{ slipNo: string; period: string }> = [];
  for (const s of input.slips) {
    if (!Number.isFinite(s.net) || s.net === 0) {
      zeroNetSlips.push({ slipNo: s.slipNo, period: s.period });
      continue;
    }
    rows.push({
      payslipId: s.id,
      slipNo: s.slipNo,
      period: s.period,
      amount: Math.round(s.net * 100) / 100,
    });
  }
  const total = Math.round(rows.reduce((sum, r) => sum + r.amount, 0) * 100) / 100;
  return { rows, total, zeroNetSlips };
}

/** The adapter row label for one released slip (its own provenance line). */
export function withholdingReleaseLabel(slipNo: string, period: string): string {
  return `Withheld salary release — ${slipNo} (${period})`;
}
