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

import { round2 } from "@/lib/payroll/payroll-math";

/** The encashment knobs a leave policy resolves to (lib/leave/leave-policy.ts). */
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

// ---------------------------------------------------------------------------
// P31 (LV-J02 / LV-09's remainder) — the auto-draft planner (pure).
//
// The benchmark's daily generate_leave_encashment job walks every employee
// and drafts a Leave Encashment for the balance they could sell. Fernly's
// translation plans the drafts through the SAME planLeaveEncashment rule
// the member-facing request validates with — a draft the manual path
// would refuse never lands:
//
//   • only ENCASHABLE types opt in (the policy knob, default off);
//   • days = available − nonEncashableDays (the floor stays forever),
//     capped by maxEncashableDays, floored to quarter-day steps, and
//     finally re-validated through planLeaveEncashment itself;
//   • the payout period is the NEXT month after the pass day (money lands
//     after review — the current month's run may already be locking);
//   • ONE LIVE DRAFT per (member, type, year): a PENDING or
//     APPROVED-unpaid row blocks the next (the approval will consume or
//     return the days before the balance re-plans);
//   • a REJECTED draft stands for the YEAR (the house discipline — HR's
//     no is not re-litigated by the next daily pass; a new year resets).
// ---------------------------------------------------------------------------

/** The candidate facts the writer gathers per (user, type, year) pair. */
export interface EncashmentAutoDraftCandidate {
  userId: string;
  leaveTypeId: string;
  leaveTypeName: string;
  /** The type's resolved encashment knobs (lib/leave/leave-policy.ts). */
  policy: EncashmentPolicy;
  /** The CURRENT ledger projection's available days for the pair. */
  availableDays: number;
  /** A PENDING or APPROVED (unpaid) encashment row exists for the pair. */
  hasLiveDraft: boolean;
  /** A REJECTED encashment row exists for the pair this year. */
  hasRejectedDraft: boolean;
}

/** The workspace switch gate (Workspace.autoLeaveEncashment, default off). */
export interface EncashmentAutoDraftSwitches {
  autoLeaveEncashment: boolean;
}

/** One planned draft: the row the writer creates, fully decided. */
export interface DueEncashmentAutoDraft {
  userId: string;
  leaveTypeId: string;
  leaveTypeName: string;
  /** Quarter-stepped days to encash (floored at 0.25). */
  days: number;
  /** "YYYY-MM" — the month AFTER the pass day. */
  payoutPeriod: string;
}

/** The next payout period after a day key ("2026-11-10" → "2026-12";
 * December rolls into next January). Pure date arithmetic on the key. */
export function nextPayoutPeriod(asOf: string): string {
  const [y, m] = asOf.split("-").map(Number);
  const year = Number.isFinite(y) ? y : 2026;
  const month = Number.isFinite(m) && m >= 1 && m <= 12 ? m : 1;
  return month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, "0")}`;
}

/** Floor to the quarter-day grid every leave fraction moves in. */
function quarterFloor(n: number): number {
  return Math.floor(n * 4) / 4;
}

/**
 * The pure rule: which candidates get an auto-draft today. The switch off
 * → nothing (never a single row); every other skip is named above. The
 * days ALWAYS re-validate through planLeaveEncashment — one rule, both
 * callers (a drifted projection or a pathological knob produces no
 * draft, not a refused row).
 */
export function dueEncashmentAutoDrafts(input: {
  asOf: string;
  candidates: EncashmentAutoDraftCandidate[];
  switches: EncashmentAutoDraftSwitches;
}): DueEncashmentAutoDraft[] {
  if (!input.switches.autoLeaveEncashment) return [];
  const payoutPeriod = nextPayoutPeriod(input.asOf);
  const drafts: DueEncashmentAutoDraft[] = [];
  for (const c of input.candidates) {
    if (!c.policy.encashable) continue;
    if (c.hasLiveDraft) continue;
    if (c.hasRejectedDraft) continue;
    const overFloor = c.availableDays - c.policy.nonEncashableDays;
    if (overFloor <= 0) continue;
    const capped =
      c.policy.maxEncashableDays > 0
        ? Math.min(overFloor, c.policy.maxEncashableDays)
        : overFloor;
    const days = quarterFloor(capped);
    if (days < 0.25) continue;
    // One rule, both callers: the draft must survive the SAME validation
    // a member request faces, or it never lands.
    const plan = planLeaveEncashment(c.policy, days, c.availableDays);
    if (!plan.ok) continue;
    drafts.push({
      userId: c.userId,
      leaveTypeId: c.leaveTypeId,
      leaveTypeName: c.leaveTypeName,
      days: plan.days,
      payoutPeriod,
    });
  }
  return drafts;
}
