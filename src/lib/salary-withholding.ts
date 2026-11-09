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

/** "" | WITHHELD | RELEASED — the literal union the payslip column stores. */
export type WithholdStatus = "" | "WITHHELD" | "RELEASED";

/** A window as the kernel consumes it (a SalaryWithholding row, or an
 * ACTIVE-row subset: both boundaries are period strings "YYYY-MM"). */
export interface WithholdingWindow {
  fromPeriod: string;
  untilPeriod: string | null;
}

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export function isPeriodHeld(window: WithholdingWindow, period: string): boolean {
  if (!PERIOD_RE.test(period)) return false;
  if (window.fromPeriod > period) return false;
  if (window.untilPeriod !== null && window.untilPeriod < period) return false;
  return true;
}

/** Two windows overlap when any period can satisfy both. */
export function windowsOverlap(a: WithholdingWindow, b: WithholdingWindow): boolean {
  const aEnd = a.untilPeriod ?? "9999-12";
  const bEnd = b.untilPeriod ?? "9999-12";
  const aStart = a.fromPeriod;
  const bStart = b.fromPeriod;
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
