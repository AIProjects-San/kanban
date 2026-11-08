// ---------------------------------------------------------------------------
// P2 (LV-09, F2.2) — the leave-encashment kernel (pure).
// docs/Fernly_HR_Payroll_Enhancement_Plan.md §7.2.1 payroll sweep, item 2.
//
// Encashment = selling leave days back for money. Three rules, all pure:
//
//   • planLeaveEncashment — the request-time validation matrix: the type
//     must be encashable, days move in quarter-day steps, a per-request
//     cap (maxEncashableDays), and the balance floor
//     (available − days ≥ nonEncashableDays — the days that can never be
//     sold). The SAME rule runs at approval time against the live LEDGER
//     projection, so a request submitted against a stale balance is
//     refused inside the transaction, exactly like a leave request.
//   • encashmentDailyRate — monthly gross ÷ the payout period's
//     holiday-aware working days (the F2.1 GROSS_OVER_WORKING_DAYS basis —
//     the same number the full-and-final statement uses, one rate per
//     workspace, documented).
//   • encashmentAmount — days × dailyRate, rounded at the end.
//
// No I/O, no clock, no db — the action layer owns rows and transactions.
// ---------------------------------------------------------------------------

import { round2 } from "@/lib/payroll-math";

/** The encashment knobs a leave policy resolves to (lib/leave-policy.ts). */
export interface EncashmentPolicy {
  encashable: boolean;
  maxEncashableDays: number;
  nonEncashableDays: number;
}

/** planLeaveEncashment's verdict: either the lawful days, or the refusal
 * reason the action surfaces verbatim. */
export type LeaveEncashmentPlan =
  | { ok: true; days: number }
  | { ok: false; reason: string };

/** Validate an encashment request against the policy + the CURRENT
 * available balance. Pure: the caller supplies the projection (the ledger
 * aggregate at request time, or re-read inside the approval transaction). */
export function planLeaveEncashment(
  policy: EncashmentPolicy,
  requestedDays: number,
  availableDays: number,
): LeaveEncashmentPlan {
  if (!policy.encashable) {
    return { ok: false, reason: "This leave type is not encashable." };
  }
  if (!Number.isFinite(requestedDays) || requestedDays <= 0) {
    return { ok: false, reason: "Encashment needs a positive number of days." };
  }
  if (Math.round(requestedDays * 4) !== requestedDays * 4) {
    return { ok: false, reason: "Encashment moves in quarter-day steps." };
  }
  if (policy.maxEncashableDays > 0 && requestedDays > policy.maxEncashableDays) {
    return {
      ok: false,
      reason: `At most ${policy.maxEncashableDays} day(s) can be encashed per request.`,
    };
  }
  const remaining = round2(availableDays - requestedDays);
  if (remaining < policy.nonEncashableDays) {
    return {
      ok: false,
      reason: policy.nonEncashableDays > 0
        ? `Only ${round2(Math.max(0, availableDays - policy.nonEncashableDays))} day(s) are encashable — ${policy.nonEncashableDays} day(s) must stay in the balance.`
        : `Only ${availableDays} day(s) available.`,
    };
  }
  return { ok: true, days: round2(requestedDays) };
}

/** The daily rate of an encashed day: the monthly gross the employee would
 * have been paid ÷ the payout period's holiday-aware working days. Pure —
 * both inputs are the caller's facts (structure gross, the run's
 * denormalized denominator). */
export function encashmentDailyRate(monthlyGross: number, periodWorkingDays: number): number {
  if (!Number.isFinite(monthlyGross) || monthlyGross < 0) return 0;
  if (!Number.isFinite(periodWorkingDays) || periodWorkingDays <= 0) return 0;
  return round2(monthlyGross / periodWorkingDays);
}

/** days × dailyRate (rounded once, at the end). */
export function encashmentAmount(days: number, dailyRate: number): number {
  if (!Number.isFinite(days) || !Number.isFinite(dailyRate)) return 0;
  return round2(Math.max(0, days) * Math.max(0, dailyRate));
}
