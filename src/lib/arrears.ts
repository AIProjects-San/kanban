// ---------------------------------------------------------------------------
// P3 (PR-13/PR-B11, F3.1) — the arrears kernel (pure).
// docs/Fernly_HR_Payroll_Enhancement_Plan.md §7.2.1 payroll sweep, item 3.
//
// Arrears = the positive difference between what a LOCKED period's slip
// WOULD have paid under the employee's CURRENT active structure and what it
// actually paid. Toy-scale reverse-simulation, honestly labeled:
//
//   • simulateArrearsForSlip re-runs the exact run-creation pipeline for
//     one stored slip — monthly earnings from the CURRENT structure, scaled
//     to the slip's SNAPSHOTTED paidDays (S5), the auto LOP line rebuilt
//     from the slip's SNAPSHOTTED lopDays and the run's holiday-aware
//     denominator (F1.1/F1.4), the workspace rounding policy re-applied —
//     and compares nets. The stored facts are inputs: the simulation never
//     re-derives attendance or leave (those were creation-time snapshots;
//     re-deriving them against today's data would silently rewrite paid
//     history).
//   • Only POSITIVE deltas become money (the benchmark's discipline:
//     arrears correct underpayment; overpayment recovery is a separate,
//     deliberate correction flow — P4's LWP credits — never a silent dock).
//   • Manual edits in the stored slip ride along honestly: the comparison
//     baseline is the STORED net (what was actually paid), so a slip that
//     was hand-edited up compares against the edited number.
//
// No I/O, no clock, no db.
// ---------------------------------------------------------------------------

import {
  monthlyEarningsFromStructure,
  payslipTotals,
  scaleEarningsToPaidDays,
  lopBasisGross,
  withLopLine,
  withRoundingLine,
  round2,
  type PayslipLine,
} from "@/lib/payroll-math";
import { parseComponents, type OfferComponent } from "@/lib/offer-math";
import type { PayrollRoundingMode } from "@/lib/payroll-math";

/** The stored facts one slip contributes to the simulation. */
export interface ArrearsSlipFacts {
  payslipId: string;
  userId: string;
  /** The LOCKED run's period ("YYYY-MM"). */
  period: string;
  /** The run's holiday-aware working-day denominator (F1.1). */
  workingDays: number;
  /** The slip's snapshotted paid days (S5; null = pre-S5 full period). */
  paidDays: number | null;
  /** The slip's snapshotted LOP days (F1.4). */
  lopDays: number;
  /** What the slip actually paid (net, the comparison baseline). */
  storedNet: number;
}

/** One employee's arrears verdict. */
export interface ArrearsDelta {
  payslipId: string;
  userId: string;
  period: string;
  storedNet: number;
  simulatedNet: number;
  /** Positive = arrears owed (money emitted); ≤ 0 = nothing owed. */
  delta: number;
  /** False with a reason when no money is emitted (nothing owed / no
   * structure / degenerate simulation). */
  owed: boolean;
  reason: string;
}

/**
 * Re-simulate one slip under `components` (the CURRENT active structure's
 * OfferComponent[]) with the stored facts, under the CURRENT rounding
 * policy (arrears are new money in a future period — today's policy
 * applies; documented, never a retro rewrite).
 */
export function simulateArrearsForSlip(
  facts: ArrearsSlipFacts,
  components: OfferComponent[] | null,
  roundingMode: PayrollRoundingMode,
): ArrearsDelta {
  const base = {
    payslipId: facts.payslipId,
    userId: facts.userId,
    period: facts.period,
    storedNet: facts.storedNet,
    simulatedNet: facts.storedNet,
    delta: 0,
    owed: false,
    reason: "",
  };
  if (!components || components.length === 0) {
    return { ...base, reason: "no active salary structure" };
  }

  // The run-creation pipeline, replayed with today's structure:
  const earnings = scaleEarningsToPaidDays(
    monthlyEarningsFromStructure(components),
    facts.paidDays,
    facts.workingDays > 0 ? facts.workingDays : undefined,
  );
  const lopDeductions = facts.lopDays > 0
    ? withLopLine([], lopBasisGross(earnings), facts.lopDays, facts.period, facts.workingDays > 0 ? facts.workingDays : undefined)
    : [];
  const { earnings: finalEarnings, deductions } = withRoundingLine(earnings, lopDeductions, roundingMode);
  const { net: simulatedNet } = payslipTotals(finalEarnings, deductions);

  const delta = round2(simulatedNet - facts.storedNet);
  if (delta <= 0) {
    return { ...base, simulatedNet, delta, reason: delta === 0 ? "no difference" : "overpaid (recovery is a separate correction)" };
  }
  return { ...base, simulatedNet, delta, owed: true, reason: "underpaid under the current structure" };
}

/**
 * Re-simulate a whole LOCKED run. `structuresByUser` maps userId → the
 * CURRENT active structure's components (null = none). Pure: the caller
 * reads rows, this computes verdicts.
 */
export function simulateArrearsRun(
  slips: ArrearsSlipFacts[],
  structuresByUser: Map<string, OfferComponent[] | null>,
  roundingMode: PayrollRoundingMode,
): { deltas: ArrearsDelta[]; owed: ArrearsDelta[] } {
  const deltas = slips.map((s) =>
    simulateArrearsForSlip(s, structuresByUser.get(s.userId) ?? null, roundingMode),
  );
  return { deltas, owed: deltas.filter((d) => d.owed) };
}

/** The adjustment label for an arrears row (test-pinned). */
export function arrearsAdjustmentLabel(period: string, slipNo: string): string {
  return `Arrears — ${period} (${slipNo})`;
}

/** Parse a structure's components JSON for the simulation (defensive). */
export function arrearsComponents(structureComponentsJson: string): OfferComponent[] {
  return parseComponents(structureComponentsJson);
}

export type { PayslipLine };
