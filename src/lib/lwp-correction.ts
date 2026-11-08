// ---------------------------------------------------------------------------
// P4 (PR-14/PR-B12, F3.1) — the LWP-correction kernel (pure).
// docs/Fernly_HR_Payroll_Enhancement_Plan.md §7.2.1 payroll sweep, item 4.
//
// Reversing N LOP days of a PAID slip refunds exactly what those days
// docked: the stored slip's own LOP line is the truth of what was docked
// per day (whatever edits happened before the lock), so
//
//   perDay = storedLopAmount / storedLopDays
//   credit = N × perDay
//
// and the reversal cap is Σ(reversed days) ≤ stored lopDays — enforced
// from the adapter rows' sourceDays data, never note-parsing.
//
// No I/O, no clock, no db.
// ---------------------------------------------------------------------------

import { round2 } from "@/lib/payroll-math";

export interface LwpCorrectionPlan {
  ok: true;
  days: number;
  perDay: number;
  credit: number;
}

export interface LwpCorrectionRefusal {
  ok: false;
  reason: string;
}

/** Validate + price one LWP reversal against a stored paid slip's facts.
 * `alreadyReversedDays` = Σ sourceDays of the slip's existing LWP_CREDIT
 * adapter rows. */
export function planLwpCorrection(input: {
  storedLopDays: number;
  storedLopAmount: number;
  requestedDays: number;
  alreadyReversedDays: number;
}): LwpCorrectionPlan | LwpCorrectionRefusal {
  const { storedLopDays, storedLopAmount, requestedDays, alreadyReversedDays } = input;
  if (!Number.isFinite(storedLopDays) || storedLopDays <= 0) {
    return { ok: false, reason: "This slip docked no loss-of-pay days — nothing to reverse." };
  }
  if (!Number.isFinite(storedLopAmount) || storedLopAmount <= 0) {
    return { ok: false, reason: "The slip's stored LOP line carries no amount — the per-day dock cannot be priced." };
  }
  if (!Number.isFinite(requestedDays) || requestedDays <= 0) {
    return { ok: false, reason: "Reversal needs a positive number of days." };
  }
  if (Math.round(requestedDays * 4) !== requestedDays * 4) {
    return { ok: false, reason: "Reversals move in quarter-day steps." };
  }
  const remaining = round2(storedLopDays - alreadyReversedDays);
  if (requestedDays > remaining) {
    return {
      ok: false,
      reason: `Only ${remaining} day(s) are still reversible (${alreadyReversedDays > 0 ? `${alreadyReversedDays} already reversed of ` : ""}${storedLopDays} docked).`,
    };
  }
  const perDay = round2(storedLopAmount / storedLopDays);
  const credit = round2(requestedDays * perDay);
  if (credit <= 0) {
    return { ok: false, reason: "The computed credit is zero — check the slip's stored LOP line." };
  }
  return { ok: true, days: round2(requestedDays), perDay, credit };
}

/** The adjustment label for an LWP credit row (test-pinned). */
export function lwpCreditLabel(period: string, slipNo: string, days: number): string {
  return `LWP correction — ${period} (${slipNo}, ${days}d)`;
}
