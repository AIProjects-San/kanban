// ---------------------------------------------------------------------------
// P12 (PR-B20 / RJ-B14) — the CTC solver: the compensation engine's inverse.
// docs/Fernly_HR_Payroll_Enhancement_Plan.md §7.2.1 payroll sweep.
//
// computeOffer (lib/offer-math.ts) derives the CTC from a component set;
// solveBaseForCtc inverts it: given a TARGET annual CTC, solve the basic
// amount that hits it, holding every other component (fixed amounts and
// percent-of-basic rates) constant. The benchmark's CTC calculator:
//
//   CTC(B) = C0 + B × P
//     C0 = Σ fixed contributions to CTC (earnings + employer, basic EXCLUDED
//          — it is the variable; deductions/statistics never count into CTC)
//     P  = Σ percent rates that scale with the basic (in fractions,
//          basic itself included as 1)
//   →  B = (target − C0) / P
//
// Honesty rules (Fernly's solver refuses to lie):
//   • No basic anchor → unsolvable, with the reason.
//   • Target below the fixed components' cost (B ≤ 0) → unsolvable.
//   • No percent-of-basic component AND a non-basic CTC driver → the CTC
//     does not respond to the basic, so no target can be hit.
//   • Rounding residue is REPORTED, never hidden: the solved base rounds to
//     `roundTo` (default whole currency units) and the result carries the
//     recomputed achieved CTC + delta (achieved − target).
//
// Pure: no I/O, no clock, no db — the modals call it live.
// ---------------------------------------------------------------------------

import { basicKeyOf, computeOffer, type OfferComponent, type OfferTotals } from "@/lib/offer-math";

import { round2 } from "@/lib/payroll/payroll-math";

export interface CtcSolveInput {
  components: OfferComponent[];
  /** The target ANNUAL cost to company. */
  targetCtc: number;
  /** Granularity the solved basic rounds to (default 1 = whole currency
   * units; 100 rounds to hundreds, 1000 to thousands). */
  roundTo?: number;
}

export interface CtcSolveResult {
  ok: boolean;
  /** The refusal reason when !ok (visible, never silent). */
  reason: string;
  /** The basic component's key that was flexed (null when none). */
  baseKey: string | null;
  /** The solved (rounded) basic amount — the value to write back. */
  base: number;
  /** The full recomputed totals with the solved base (the ctc_breakup). */
  totals: OfferTotals | null;
  /** The CTC the solved components actually produce. */
  achievedCtc: number;
  /** achieved − target (the rounding residue, reported). */
  delta: number;
}

/**
 * Solve the basic amount that hits a target annual CTC. Pure; the caller
 * writes the returned base into its basic component (or shows the reason).
 */
export function solveBaseForCtc(input: CtcSolveInput): CtcSolveResult {
  const { components, targetCtc } = input;
  const roundTo = input.roundTo != null && Number.isFinite(input.roundTo) && input.roundTo > 0
    ? input.roundTo
    : 1;
  const target = Number(targetCtc);

  const fail = (reason: string): CtcSolveResult => ({
    ok: false,
    reason,
    baseKey: null,
    base: 0,
    totals: null,
    achievedCtc: 0,
    delta: 0,
  });

  if (!Number.isFinite(target) || target <= 0) {
    return fail("Enter a positive target CTC.");
  }

  const baseKey = basicKeyOf(components);
  if (!baseKey) {
    return fail("No basic component to flex — add a fixed earning (e.g. Basic Salary) first.");
  }

  // P23 — percent-of-gross EARNING/EMPLOYER lines make the CTC non-linear
  // in the basic (a rate on Σ earnings — the basic itself included — is a
  // geometric series, not C0 + B×P). The solver refuses to lie: the refusal
  // names the discipline; percent-of-NET lines are deductions and never
  // count into CTC, so they stay harmless here.
  const nonLinear = components.some(
    (c) =>
      (c.kind === "EARNING" || c.kind === "EMPLOYER_CONTRIBUTION") &&
      c.mode === "PERCENT_OF_GROSS",
  );
  if (nonLinear) {
    return fail(
      "Percent-of-gross earnings make the CTC non-linear in the basic — remove them (or solve by hand) before solving.",
    );
  }

  // C0 + B×P decomposition over the CTC-contributing components (earnings +
  // employer contributions; deductions and statistical lines never count).
  let fixed = 0;
  let rate = 0; // in fractions, the basic itself contributes 1
  for (const c of components) {
    if (c.key === baseKey) {
      rate += 1;
      continue;
    }
    const counts = c.kind === "EARNING" || c.kind === "EMPLOYER_CONTRIBUTION";
    if (!counts) continue;
    if (c.mode === "PERCENT_OF_BASIC") {
      rate += Math.max(0, Number.isFinite(c.amount) ? c.amount : 0) / 100;
    } else {
      fixed += Math.max(0, Number.isFinite(c.amount) ? c.amount : 0);
    }
  }

  if (rate <= 0) {
    // Unreachable in practice (the basic contributes 1 to the rate), kept
    // for totality.
    return fail("The CTC does not respond to the basic — percent-of-basic components only.");
  }

  const solved = (target - fixed) / rate;
  if (solved <= 0) {
    return fail(
      `Target ${formatWhole(target)} is below the fixed components' cost (${formatWhole(fixed)}) — raise the target or remove fixed lines.`,
    );
  }

  // Round to the granularity, recompute honestly, report the residue.
  const base = Math.round(solved / roundTo) * roundTo;
  const withSolvedBase = components.map((c) => (c.key === baseKey ? { ...c, amount: base } : c));
  const totals = computeOffer(withSolvedBase);
  const achievedCtc = totals.ctc;
  return {
    ok: true,
    reason: "",
    baseKey,
    base,
    totals,
    achievedCtc,
    delta: round2(achievedCtc - target),
  };
}

function formatWhole(n: number): string {
  return `$${Math.round(n).toLocaleString("en-NZ")}`;
}
