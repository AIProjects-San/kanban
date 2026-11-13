// The one structure→lines derivation every slip pricing shares.
//
// Run creation prices every paid employee through this pipeline; adding a
// joiner mid-run replays it for one employee; the arrears simulation
// replays it against the CURRENT structure. The order is the payslip's
// contract: scale earnings to paid days → structure flat deductions → the
// overtime line (priced from UNSCALED gross — overtime was worked on
// attended days) → the LOP line (basis excludes window-exempt lines) → the
// two-pass adjustment kernel (structure percent-of-net rows prepended
// before the period's adapter rows). The statutory pass and the rounding
// line are deliberately NOT here: statutory runs between this derivation
// and rounding with caller-specific failure policy (bulk-create skips a
// broken slip loudly; a single joiner blocks), and rounding wraps the
// FINAL net.
//
// Pure: no DB, no clock.

import {
  windowEarningsFromStructure,
  windowDeductionsFromStructure,
  scaleEarningsToPaidDays,
  withLopLine,
  lopBasisGross,
  lineSum,
  type PayslipLine,
} from "@/lib/payroll/payroll-math";
import {
  applyAdjustments,
  structureNetDeductionRows,
  type AdjustmentApplication,
  type PayAdjustmentRow,
} from "@/lib/payroll/pay-adjustment";
import { OVERTIME_LINE_KEY, overtimeLineLabel, planOvertimePayout } from "@/lib/payroll/overtime-bridge";
import type { OfferComponent } from "@/lib/offer-math";
import type { PayrollFrequency } from "@/lib/payroll/payroll-windows";

export interface SlipDerivationInput {
  components: OfferComponent[];
  frequency: PayrollFrequency;
  /** The window-start year — the annual ÷ windowsInYear resolution basis. */
  earningsYear: number;
  /** The run's holiday-aware working-day denominator. 0 is the pre-F1.1
   *  sentinel: the kernels fall back to calendar days, so callers pass the
   *  raw stored value. */
  workingDays: number;
  /** The slip's snapshotted paid days (null = full period). */
  paidDays: number | null;
  lopDays: number;
  /** The run's period key (the LOP line's proration period). */
  periodKey: string;
  overtime: {
    enabled: boolean;
    /** Minutes worked in the window (null/0 = no line). */
    minutes: number | null;
  };
  /** Due adapter rows to consume (the arrears replay passes none — consumed
   *  adjustments are facts of history, not of the structure). */
  adapterRows: PayAdjustmentRow[];
}

export type SlipDerivation = AdjustmentApplication & {
  /** Scaled earnings + the overtime line (when it pays). */
  earnings: PayslipLine[];
  /** The overtime payout the line was built from (null = no line) — the
   *  audit trail quotes it. */
  otPayout: ReturnType<typeof planOvertimePayout>;
};

export function deriveSlipLines(input: SlipDerivationInput): SlipDerivation {
  const windowEarnings = windowEarningsFromStructure(input.components, input.frequency, input.earningsYear);
  const earnings = scaleEarningsToPaidDays(windowEarnings, input.paidDays, input.workingDays);
  const structureDeductions = windowDeductionsFromStructure(input.components, input.frequency, input.earningsYear);
  const otPayout = planOvertimePayout({
    enabled: input.overtime.enabled,
    minutes: input.overtime.minutes,
    monthlyGross: lineSum(windowEarnings),
    workingDays: input.workingDays,
  });
  const earningsWithOt: PayslipLine[] = otPayout
    ? [...earnings, { key: OVERTIME_LINE_KEY, label: overtimeLineLabel(otPayout), amount: otPayout.amount }]
    : earnings;
  const baseDeductions = input.lopDays > 0
    ? withLopLine(structureDeductions, lopBasisGross(earnings), input.lopDays, input.periodKey, input.workingDays)
    : structureDeductions;
  return {
    ...applyAdjustments(
      { earnings: earningsWithOt, deductions: baseDeductions },
      [...structureNetDeductionRows(input.components), ...input.adapterRows],
      input.periodKey,
    ),
    otPayout,
  };
}
