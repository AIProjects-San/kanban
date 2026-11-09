// ---------------------------------------------------------------------------
// P7 (PR-20/PR-21, F3.3) — the gratuity slab engine, pure computation
// (docs/Fernly_HR_Payroll_Enhancement_Plan.md §7.2.1 payroll sweep, item 7;
//  benchmark Gratuity + Gratuity Rule, workspace scope).
//
// The rule is DATA (GratuityRule + GratuitySlab rows, HR-editable); the math
// is pure — no I/O, no clock (both the join date and the last working day
// arrive as inputs, the statement's `asOf` never leaks in). The line lands
// on the LIVE full-and-final statement (lib/full-and-final.ts) and freezes
// with it at settle time — a settled statement never moves.
//
// THE ENGINE (the benchmark's "work life" method generalized):
//   completed service years 1..N each fall into exactly one slab band
//   [fromYears, toYears ?? ∞]; the year pays `fraction` months of the
//   FINAL AVERAGE EARNINGS (the average monthly gross of the last
//   `averagingMonths` LOCKED-run payslips, falling back to the active
//   structure's monthly gross when no payslip exists). A year covered by
//   no slab pays 0 — an uncovered band is a real rule choice, surfaced in
//   the statement note, never an error and never silently inflated.
//   The incomplete final year pays nothing (completed years only, the
//   honest reading of "per completed year of service").
//
// HONESTY RULES
//   • NON-STATUTORY, and it says so: every gratuity note carries the
//     disclaimer that this is the workspace's contractual rule, not a
//     Payment of Gratuity Act computation (ADR-014 boundary — we compute
//     the configured contract, we do not legislate).
//   • No hire date / no average earnings / zero completed years → a NOTE,
//     not a zero line: the statement shows what cannot be valued yet.
//   • The breakdown (which slab paid how many years) is returned with the
//     amount so the note can show its own work.
// ---------------------------------------------------------------------------

import { round2 } from "@/lib/payroll-math";

/** One years→fraction band (a GratuitySlab row, or an editor draft). */
export interface GratuitySlabInput {
  /** First completed-year this band covers (0 and 1 both cover year 1). */
  fromYears: number;
  /** Last covered year; null = open-ended. */
  toYears: number | null;
  /** Months of average earnings paid per covered year (15/26 ≈ 0.5769). */
  fraction: number;
}

/** The rule as the kernel consumes it (GratuityRule row + its slabs). */
export interface GratuityRuleInput {
  enabled: boolean;
  /** Earnings averaging window: 1–12 months of payslip history. */
  averagingMonths: number;
  slabs: GratuitySlabInput[];
}

/** The disclaimer every gratuity surface must render. */
export const GRATUITY_DISCLAIMER =
  "Gratuity here follows the rule this workspace configured — a contractual estimate, not a statutory Payment of Gratuity computation. Validate the final amount with counsel before paying.";

// ---------------------------------------------------------------------------
// Validation (the editor's guard — same shape as the other plan kernels)
// ---------------------------------------------------------------------------

const MAX_SLABS = 40;

/** Pure validation of an editor payload; sorted, defensive-normalized on
 * success so the slab walk never sees unsorted input. */
export function validateGratuityRuleInput(input: {
  enabled: boolean;
  averagingMonths: number;
  slabs: GratuitySlabInput[];
}): { ok: true; slabs: GratuitySlabInput[] } | { ok: false; reason: string } {
  if (!Number.isInteger(input.averagingMonths) || input.averagingMonths < 1 || input.averagingMonths > 12) {
    return { ok: false, reason: "The earnings averaging window must be 1–12 months." };
  }
  if (!Array.isArray(input.slabs) || input.slabs.length > MAX_SLABS) {
    return { ok: false, reason: `A rule needs at most ${MAX_SLABS} slabs.` };
  }
  for (const s of input.slabs) {
    if (!Number.isInteger(s.fromYears) || s.fromYears < 0 || s.fromYears > 80) {
      return { ok: false, reason: "Every slab needs a starting year between 0 and 80." };
    }
    if (s.toYears !== null && (!Number.isInteger(s.toYears) || s.toYears <= s.fromYears)) {
      return { ok: false, reason: "A slab's last year must be an integer greater than its first year (or empty for open-ended)." };
    }
    if (!Number.isFinite(s.fraction) || s.fraction < 0 || s.fraction > 12) {
      return { ok: false, reason: "A slab's fraction must be between 0 and 12 months of earnings per year." };
    }
  }
  const sorted = [...input.slabs].sort((a, b) => a.fromYears - b.fromYears);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    if (prev.toYears !== null && sorted[i].fromYears <= prev.toYears) {
      return { ok: false, reason: "Slabs must not overlap — sort them by starting year and leave gaps open." };
    }
  }
  return { ok: true, slabs: sorted };
}

// ---------------------------------------------------------------------------
// Service-years math (pure UTC — both dates arrive as yyyy-mm-dd strings)
// ---------------------------------------------------------------------------

export interface ServiceLength {
  /** Whole years completed at the last working day. */
  completedYears: number;
  /** Months beyond the completed years (0–11). */
  extraMonths: number;
  /** Total completed months (completedYears × 12 + extraMonths). */
  totalMonths: number;
}

/** Completed months of service from join to last-working-day, UTC. A day
 * only counts once the same day-of-month is reached (2024-02-05 →
 * 2026-11-04 = 32 months; 2026-11-05 = 33). Reversed dates yield 0. */
export function serviceLengthBetween(joinDate: string, lastWorkingDay: string): ServiceLength {
  const join = Date.parse(`${joinDate}T00:00:00.000Z`);
  const lwd = Date.parse(`${lastWorkingDay}T00:00:00.000Z`);
  if (!Number.isFinite(join) || !Number.isFinite(lwd) || lwd < join) {
    return { completedYears: 0, extraMonths: 0, totalMonths: 0 };
  }
  const j = new Date(join);
  const w = new Date(lwd);
  let months = (w.getUTCFullYear() - j.getUTCFullYear()) * 12 + (w.getUTCMonth() - j.getUTCMonth());
  if (w.getUTCDate() < j.getUTCDate()) months -= 1;
  if (months < 0) months = 0;
  return {
    completedYears: Math.floor(months / 12),
    extraMonths: months % 12,
    totalMonths: months,
  };
}

// ---------------------------------------------------------------------------
// The slab walk
// ---------------------------------------------------------------------------

/** Which band covers completed-year `y` (null = uncovered, pays 0). */
function slabFor(slabs: GratuitySlabInput[], y: number): GratuitySlabInput | null {
  for (const s of slabs) {
    if (y >= s.fromYears && (s.toYears === null || y <= s.toYears)) return s;
  }
  return null;
}

export interface GratuityBreakdownRow {
  /** The completed year (1-based service-year index). */
  year: number;
  fraction: number;
  amount: number;
}

export interface GratuityComputation {
  /** Σ per-year amounts, rounded once at the end. */
  amount: number;
  /** Completed years that paid (uncovered years are absent, not zeroed). */
  breakdown: GratuityBreakdownRow[];
  /** Years covered by no slab (visible skips, for the statement note). */
  uncoveredYears: number[];
}

/** Walk the slabs: each completed year pays its band's fraction × average
 * monthly earnings. Rounding happens once, on the total. */
export function computeGratuity(input: {
  service: ServiceLength;
  averageMonthlyEarnings: number;
  slabs: GratuitySlabInput[];
}): GratuityComputation {
  const breakdown: GratuityBreakdownRow[] = [];
  const uncoveredYears: number[] = [];
  for (let y = 1; y <= input.service.completedYears; y++) {
    const slab = slabFor(input.slabs, y);
    if (!slab || slab.fraction === 0) {
      if (slab?.fraction !== 0) uncoveredYears.push(y); // fraction-0 slabs are deliberate zeros, not gaps
      continue;
    }
    breakdown.push({ year: y, fraction: slab.fraction, amount: input.averageMonthlyEarnings * slab.fraction });
  }
  const amount = round2(breakdown.reduce((s, r) => s + r.amount, 0));
  return { amount, breakdown, uncoveredYears };
}

// ---------------------------------------------------------------------------
// Final average earnings
// ---------------------------------------------------------------------------

/** Average of the last-N monthly grosses (the caller slices the window);
 * null when there is nothing to average. Rounded once — the same
 * one-rounding discipline as the leave daily rate. */
export function finalAverageEarnings(samples: number[]): number | null {
  const usable = samples.filter((v) => Number.isFinite(v) && v > 0);
  if (usable.length === 0) return null;
  return round2(usable.reduce((s, v) => s + v, 0) / usable.length);
}

// ---------------------------------------------------------------------------
// The FnF note text (its own work shown next to the money)
// ---------------------------------------------------------------------------

/** The explanatory note under the gratuity line — the math, the basis, the
 * gaps, then the statutory disclaimer. Pure string building. */
export function gratuityNote(input: {
  service: ServiceLength;
  averagingMonths: number;
  averageMonthlyEarnings: number | null;
  earningsBasis: "PAYSLIPS" | "STRUCTURE";
  computation: GratuityComputation;
}): string {
  const parts: string[] = [];
  const { service, computation } = input;
  parts.push(
    `Gratuity: ${service.completedYears} completed year${service.completedYears === 1 ? "" : "s"} ${service.extraMonths} month${service.extraMonths === 1 ? "" : "s"} of service`,
  );
  if (input.averageMonthlyEarnings !== null) {
    const basis =
      input.earningsBasis === "PAYSLIPS"
        ? `the average gross of the last ${input.averagingMonths} payslip month${input.averagingMonths === 1 ? "" : "s"}`
        : "the active structure's monthly gross (no payslip history yet)";
    parts.push(`$${input.averageMonthlyEarnings.toLocaleString("en-NZ", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} (${basis})`);
  }
  if (computation.uncoveredYears.length > 0) {
    parts.push(
      `service year${computation.uncoveredYears.length === 1 ? "" : "s"} ${computation.uncoveredYears.join(", ")} covered by no slab (paid 0)`,
    );
  }
  return `${parts.join(" · ")}. ${GRATUITY_DISCLAIMER}`;
}
