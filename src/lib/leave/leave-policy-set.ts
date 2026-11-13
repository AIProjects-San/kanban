// P28 (LV-02, LV-03) — leave policy sets + bulk assignment, pure core
// (docs/Fernly_HR_Payroll_Enhancement_Plan.md §7.2.2 P28; benchmark:
// frappe/hrms `Leave Policy` + `Leave Policy Detail` (child) and `Leave
// Policy Assignment`).
//
// Pure and dependency-free (only date arithmetic + the leave-period and
// leave-policy kernels) so BOTH sides import it:
//   • server actions — the set CRUD validation, the assignment window
//     targeting and the bulk tool's per-employee rules
//     (src/server-actions/leave-policy-sets.ts);
//   • the engine — the entitlement override resolution that turns an
//     assignment into the numbers every materializer consumes
//     (src/server-actions/hr-shared.ts wires it; the shape lives here so
//     the rule is test-pinned in lib/leave/__tests__/leave-policy-set.test.ts);
//   • the UI — the bucket candidates the assign modal offers.
//
// THE ONE DESIGN DECISION everything else follows from: a policy SET is the
// benchmark's multi-type allocation template — one row per leave type
// carrying that type's ANNUAL ALLOCATION (the benchmark's Leave Policy
// Detail shape: leave_type + annual_allocation, nothing more). Every other
// knob (strategy, cadence, notice, consecutive, carry, encashment…) stays
// on the per-type LeavePolicy row — workspace-level rules, exactly as the
// benchmark keeps them on the Leave Type. An ASSIGNMENT then says: "for
// ledger bucket B, employee E's entitlement per type comes from set S".
// The engine reads it as a row-level annualDays override on the type's own
// policy row (policyRowWithAnnualDays) — every strategy (lump sum, earned
// accrual rate, after-service deposit), the true-up math and the null-cap
// resolution (accrualCap null → annualDays) flow through the SAME F2.4
// kernel with the overridden number, byte-identically in shape.
//
// THE DEFAULT IS NO ROWS: with no sets and no assignments every
// materializer resolves exactly the pre-P28 policy (the override is
// undefined → the row passes through untouched). The migration is
// additive; the existing suites pin the zero-change world.
//
// DOJ PRO-RATA (LV-03) rides F2.4's own rule (proRateAnnualDays in
// lib/leave/leave-policy.ts — the ANNUAL_LUMP_SUM + PERIOD_START formula): an
// assigned employee hired INSIDE the target window gets the set's days
// pro-rated by the calendar days remaining, per the TYPE's prorateForJoiners
// knob and accrualRounding — one formula, both callers, no new switches.

import {
  daysBetween,
  proRateAnnualDays,
  resolveLeavePolicy,
  type LeavePolicyRow,
  type ResolvedLeavePolicy,
} from "@/lib/leave/leave-policy";
import { windowForBucket, type LeavePeriodInput } from "@/lib/leave/leave-period";

// ---------------------------------------------------------------------------
// DTO shapes (the actions map DB rows to these; the UI consumes them)
// ---------------------------------------------------------------------------

export interface LeavePolicySetItemT {
  id: string;
  leaveTypeId: string;
  /** The type's display name at list time (joined in the action). */
  typeName: string;
  /** The set's annual allocation for the type (working days). */
  annualDays: number;
}

export interface LeavePolicySetT {
  id: string;
  name: string;
  description: string;
  active: boolean;
  items: LeavePolicySetItemT[];
  /** How many assignments reference the set (freezes item edits). */
  assignmentCount: number;
}

export interface LeavePolicyAssignmentT {
  id: string;
  userId: string;
  userName: string;
  setId: string;
  setName: string;
  /** The ledger bucket the assignment governs. */
  bucketYear: number;
  /** The named period's name when the bucket maps to one, else null. */
  periodName: string | null;
  assignedAt: string;
  assignedByName: string;
  /** True when any ledger row exists on the assignment's (user, item-type,
   * bucket) pairs — the delete guard's flag, shown as a badge. */
  granted: boolean;
}

// ---------------------------------------------------------------------------
// Set validation (pure; the action adds the DB guards on top)
// ---------------------------------------------------------------------------

export interface PolicySetValidation {
  ok: boolean;
  /** The human-readable refusal (empty when ok). */
  reason: string;
}

/**
 * Validate a set payload. Rules:
 *   • name trimmed, non-empty, ≤ 80 chars (the LeavePeriod convention);
 *   • description ≤ 200 chars;
 *   • 1..40 items (a set wider than every leave type is a mistake —
 *     the workspace carries a handful);
 *   • annualDays finite, 0..365 (the benchmark's own annual_allocation
 *     sanity bound; 0 = "tracked but unpaid-by-allocation", the same
 *     honest zero the type policy allows);
 *   • no duplicate leave types (the unique index's friendly twin).
 */
export function validatePolicySet(candidate: {
  name: string;
  description?: string | null;
  items: ReadonlyArray<{ leaveTypeId: string; annualDays: number }>;
}): PolicySetValidation {
  const name = candidate.name.trim();
  if (name.length === 0 || name.length > 80) {
    return { ok: false, reason: "Policy set name must be 1–80 characters." };
  }
  const description = (candidate.description ?? "").trim();
  if (description.length > 200) {
    return { ok: false, reason: "Policy set description must be at most 200 characters." };
  }
  if (candidate.items.length === 0) {
    return { ok: false, reason: "A policy set needs at least one leave type with an allocation." };
  }
  if (candidate.items.length > 40) {
    return { ok: false, reason: `A policy set may carry at most 40 leave types (this one has ${candidate.items.length}).` };
  }
  const seen = new Set<string>();
  for (const item of candidate.items) {
    if (typeof item.leaveTypeId !== "string" || item.leaveTypeId.trim().length === 0) {
      return { ok: false, reason: "Every set row needs a leave type." };
    }
    if (seen.has(item.leaveTypeId)) {
      return { ok: false, reason: "The same leave type appears twice in this set — one allocation per type." };
    }
    seen.add(item.leaveTypeId);
    if (!Number.isFinite(item.annualDays) || item.annualDays < 0 || item.annualDays > 365) {
      return {
        ok: false,
        reason: `Annual allocation must be 0–365 days (got ${item.annualDays}).`,
      };
    }
  }
  return { ok: true, reason: "" };
}

// ---------------------------------------------------------------------------
// Assignment window targeting (LV-03: assignment per employee × window)
// ---------------------------------------------------------------------------

/**
 * Resolve the window an assignment's bucket maps to, with the P27 tri-state
 * as the grant semantics:
 *   • a named period starts in the bucket → its window (grants land inside
 *     it; its start/end drive every boundary);
 *   • NO periods at all → the implicit calendar window (undefined arg — the
 *     pre-P27 materialization, byte-identical);
 *   • periods exist but none starts in the bucket → REFUSED: with a
 *     non-empty period master the engine grants nothing implicit, so an
 *     assignment targeting an uncovered bucket would be a document the
 *     engine can never honor (create the period first).
 */
export function assignmentWindowFor(
  periods: ReadonlyArray<LeavePeriodInput>,
  bucketYear: number,
): { ok: true; windowArg: { start: string; end: string } | undefined } | { ok: false; reason: string } {
  const window = windowForBucket(periods, bucketYear);
  if (window.periodId !== null) {
    return { ok: true, windowArg: { start: window.start, end: window.end } };
  }
  if (periods.length > 0) {
    return {
      ok: false,
      reason: `No named allocation window starts in ${bucketYear} — with named periods active, an assignment must target a window the master defines. Create the ${bucketYear} period first.`,
    };
  }
  return { ok: true, windowArg: undefined };
}

/** One picker option for the assign modal's target bucket. */
export interface BucketCandidate {
  bucketYear: number;
  label: string;
  named: boolean;
}

/**
 * The buckets an assignment may target, ascending:
 *   • with named periods: every OPEN period's bucket (endDate ≥ today —
 *     the running window included; mid-window assignment is the bulk
 *     tool's mid-year reorg case);
 *   • with no periods: the implicit calendar years of this year and the
 *     next two (HR assigns next year's policy ahead of the window).
 * Deduped by bucket (one window per start year — P27's own law).
 */
export function assignmentBucketCandidates(
  periods: ReadonlyArray<LeavePeriodInput>,
  today: string,
): BucketCandidate[] {
  const open = periods
    .filter((p) => p.endDate >= today)
    .map((p) => ({
      bucketYear: Number(p.startDate.slice(0, 4)),
      label: `${p.name} (${p.startDate} → ${p.endDate})`,
      named: true,
    }));
  if (open.length > 0 || periods.length > 0) {
    const seen = new Set<number>();
    return open.filter((c) => {
      if (seen.has(c.bucketYear)) return false;
      seen.add(c.bucketYear);
      return true;
    });
  }
  const currentYear = Number(today.slice(0, 4));
  return [0, 1, 2].map((offset) => ({
    bucketYear: currentYear + offset,
    label: `Calendar year ${currentYear + offset} (Jan → Dec)`,
    named: false,
  }));
}

// ---------------------------------------------------------------------------
// The entitlement override (the engine's one new input)
// ---------------------------------------------------------------------------

/**
 * Apply a set item's annual allocation to a policy ROW — the pre-resolution
 * shape, so every downstream default sees the override as the row's own
 * number: a null accrualCap resolves to the SET's days (the standing cap
 * follows the entitlement), the EARNED per-period share divides the set's
 * days, the lump strategies grant the set's days. `undefined` (no
 * assignment / the type is not in the set) passes the row through
 * byte-identically.
 *
 * A null ROW with an override is the type-without-a-policy case: the set
 * item is a policy-lite (annualDays + the resolve defaults for everything
 * else — MANUAL, floor-quarter, holidays excluded).
 */
export function policyRowWithAnnualDays(
  row: LeavePolicyRow | null | undefined,
  annualDays: number | undefined,
): LeavePolicyRow | null {
  if (annualDays === undefined) return row ?? null;
  if (row) return { ...row, annualDays };
  // The defaults MUST mirror resolveLeavePolicy's own fallbacks exactly.
  return { annualDays, maxCarryOver: 0, minNoticeDays: 1, maxConsecutiveDays: 15 };
}

/**
 * The MANUAL materialization's grant size under an assignment (LV-03's
 * DOJ pro-rata riding F2.4's rule): the set's days for a pre-window hire,
 * pro-rated by the calendar days remaining in the window for a mid-window
 * joiner — only when the TYPE's prorateForJoiners knob is on (the same
 * switch ANNUAL_LUMP_SUM reads) and rounded per the policy's own
 * accrualRounding. An employee hired after the window ends was never
 * entitled to it (0 — the ANNUAL_LUMP_SUM rule).
 *
 * Strategy types ignore this helper entirely: dueGrantOps already
 * pro-rates/accrues the OVERRIDDEN number on its own schedule.
 */
export function assignedManualGrantDays(
  policy: ResolvedLeavePolicy,
  hireDate: string | null,
  windowStart: string,
  windowEnd: string,
): number {
  if (!policy.prorateForJoiners || !hireDate) return policy.annualDays;
  if (hireDate <= windowStart) return policy.annualDays;
  if (hireDate > windowEnd) return 0;
  return Math.max(0, proRateAnnualDays(policy.annualDays, hireDate, windowStart, windowEnd, policy.accrualRounding));
}

/** The override's preview shape for UI/tests: how many days one item grants
 * for one employee under one window — MANUAL pro-rated per the rule above,
 * strategy types answered by the caller (the schedule, not a number). */
export function assignedManualPreview(
  policyRow: LeavePolicyRow | null | undefined,
  annualDays: number,
  hireDate: string | null,
  window: { start: string; end: string } | undefined,
): number {
  const policy = resolveLeavePolicy(policyRowWithAnnualDays(policyRow, annualDays));
  if (policy.allocationStrategy !== "MANUAL") return annualDays;
  if (!window) return policy.annualDays;
  return assignedManualGrantDays(policy, hireDate, window.start, window.end);
}

/** Days from the window's start to the hire date (the pro-rata trigger),
 * for the UI's "joins mid-window" hint. */
export function joinsMidWindow(hireDate: string | null, window: { start: string; end: string } | undefined): boolean {
  if (!hireDate || !window) return false;
  return hireDate > window.start && hireDate <= window.end;
}

// Re-exported for the action/UI convenience (one import site).
export { daysBetween };
