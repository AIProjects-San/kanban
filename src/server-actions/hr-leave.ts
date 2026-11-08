"use server";

// ---------------------------------------------------------------------------
// HR Module — leave management server actions (docs/HR_MODULE_PLAN.md §4).
//
// RBAC:
//   leave:request — any signed-in user (self-service Leave view)
//   hr:view       — HR console read access (queue) — Admin, Manager, HR
//   hr:admin      — leave type + policy management — Admin, HR
//
// Decision rights are CHAIN-scoped, not permission-scoped: only the
// requester's manager (User.managerId) or an ADMIN may approve/reject.
// Balance invariant: LeaveBalance.used changes ONLY inside approve/cancel,
// transactionally, and always by exactly the request's `days`.
// ---------------------------------------------------------------------------

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { logError } from "@/lib/observability";
import { requirePermission, AuthorizationError } from "./auth-guard";
import { hasPermission } from "@/lib/rbac";
import { LEAVE_STATUS_LABELS } from "@/lib/config";
import type { LeaveStatus, LeaveRequestT, LeaveTypeT, LeaveBalanceT, HolidayT, LeaveAllocationStrategy, LeaveAccrualFrequency, LeaveAllocateOnDay, LeaveAccrualRounding, LeaveGrantOn } from "@/lib/types";
import {
  createLeaveRequestSchema,
  decideLeaveRequestSchema,
  cancelLeaveRequestSchema,
  leaveTypeSchema,
  updateLeaveTypeSchema,
  parseOrThrow,
  adjustLeaveBalanceSchema,
} from "@/lib/validation";
import { logAudit } from "./shared";
import { toResult, isUniqueConstraintError } from "./result";
import type { ActionResult } from "@/lib/action-result";
import { workingDaysBetween } from "@/lib/working-days";
import {
  checkLeaveRequestAgainstBalance,
  checkServiceEligibility,
  advanceHint,
  resolveLeavePolicy,
  type LeavePolicyRow,
} from "@/lib/leave-policy";
import { planLeaveAdjustment } from "@/lib/leave-ledger";
import {
  parseDay,
  daysBetween,
  todayUTC,
  getApproverIdsFor,
  assertLeaveDecider,
  getOrCreateBalance,
  getOrCreateBalancesBatch,
  findOverlappingActiveRequest,
  getHolidayLookup,
  getHolidayRows,
  ledgerProjectionFor,
  materializeLeaveBalanceTx,
  deriveOnLeaveAttendance,
  removeDerivedOnLeaveAttendance,
} from "./hr-shared";

// ---------------------------------------------------------------------------
// Read — my self-service data (balances + history + selectable types)
// ---------------------------------------------------------------------------

export async function getMyLeaveData(): Promise<
  ActionResult<{
    balances: LeaveBalanceT[];
    requests: LeaveRequestT[];
    types: LeaveTypeT[];
    year: number;
    canManage: boolean;
    holidays: HolidayT[];
  }>
> {
  return toResult(async () => {
    const auth = await requirePermission("leave:request");
    const year = todayUTC().getUTCFullYear();

    const [types, requests, holidays] = await Promise.all([
      db.leaveType.findMany({
        where: { active: true },
        orderBy: { name: "asc" },
        include: { policy: true },
      }),
      db.leaveRequest.findMany({
        where: { userId: auth.userId },
        orderBy: { createdAt: "desc" },
        // PR-21 — hard cap. A personal history beyond a few hundred requests
        // is a paginated-list concern, not a self-service view concern.
        take: 200,
      }),
      // F1.1 — the live request preview needs the calendar around "now":
      // past entries for the history list, future entries for new requests.
      // One bounded read (±1 year) instead of the whole table.
      getHolidayRows(
        new Date(Date.UTC(year - 1, 0, 1)),
        new Date(Date.UTC(year + 1, 11, 31)),
      ),
    ]);

    // PR-19 — balances for every active type in ONE batched read (+ a rare
    // lazy materialize write for missing rows). The previous per-type loop
    // ran 3 queries per leave type — a genuine N+1 with a write on the read
    // path — on every Leave-view load. F2.4: the policy ROW rides along so
    // materialization is strategy-aware.
    const balancesByType = await getOrCreateBalancesBatch(
      auth.userId,
      types.map((t) => ({ id: t.id, policy: t.policy })),
      year,
    );
    const balances: LeaveBalanceT[] = types.map((t) => {
      const b = balancesByType.get(t.id) ?? { entitled: t.policy?.annualDays ?? 0, carriedOver: 0, used: 0 };
      return {
        leaveTypeId: t.id,
        typeName: t.name,
        typeColor: t.color,
        year,
        entitled: b.entitled,
        carriedOver: b.carriedOver,
        used: b.used,
        available: b.entitled + b.carriedOver - b.used,
      };
    });

    const typeById = new Map(types.map((t) => [t.id, t]));
    // Decided rows render "<name>: <note>" — only DECIDERS' names are
    // needed. (QA-21: this loader used to also resolve the pending
    // approver ids of every PENDING request and fold their names into the
    // map below — but the map is only ever read with decidedById, which is
    // null while PENDING. The pending approver names were never rendered;
    // the resolution walks were dead queries on every Leave-view load.)
    const deciderIds = [...new Set(
      requests.map((r) => r.decidedById).filter(Boolean) as string[],
    )];
    const deciders = deciderIds.length
      ? await db.user.findMany({ where: { id: { in: deciderIds } }, select: { id: true, name: true } })
      : [];
    const deciderNames = new Map(deciders.map((d) => [d.id, d.name]));

    return {
      balances,
      requests: requests.map((r) => ({
        id: r.id,
        leaveTypeId: r.leaveTypeId,
        typeName: typeById.get(r.leaveTypeId)?.name ?? "Leave",
        typeColor: typeById.get(r.leaveTypeId)?.color ?? "#8b5cf6",
        userId: r.userId,
        userName: auth.name,
        startDate: r.startDate.toISOString().slice(0, 10),
        endDate: r.endDate.toISOString().slice(0, 10),
        days: r.days,
        reason: r.reason,
        status: r.status as LeaveStatus,
        decidedById: r.decidedById,
        decidedBy: r.decidedById ? deciderNames.get(r.decidedById) ?? null : null,
        decidedAt: r.decidedAt ? r.decidedAt.toISOString() : null,
        decisionNote: r.decisionNote,
        createdAt: r.createdAt.toISOString(),
      })),
      types: types.map((t) => ({
        id: t.id,
        name: t.name,
        code: t.code,
        requiresDoc: t.requiresDoc,
        paid: t.paid,
        color: t.color,
        active: t.active,
        policy: t.policy ? policyDto(t.policy) : null,
      })),
      year,
      canManage: hasPermission(auth.role as never, "hr:view"),
      holidays,
    };
  });
}

// ---------------------------------------------------------------------------
// Read — HR console queue (hr:view). MANAGER sees their subtree's requests;
// ADMIN/HR see the whole workspace.
// ---------------------------------------------------------------------------

export async function getLeaveQueue(): Promise<
  ActionResult<{ requests: LeaveRequestT[]; canAdmin: boolean; canManageAttendance: boolean; types: LeaveTypeT[] }>
> {
  return toResult(async () => {
    const auth = await requirePermission("hr:view");
    const canAdmin = hasPermission(auth.role as never, "hr:admin");
    // F1.3 — the Attendance tab's gate. Same ADMIN+HR audience as canAdmin
    // today, but its OWN permission so a DB ceiling can diverge them.
    const canManageAttendance = hasPermission(auth.role as never, "attendance:manage");

    let visibleUserIds: string[] | null = null;
    if (auth.role === "MANAGER") {
      // The manager's subtree — they can only decide for their reports, so
      // the queue must not leak other teams' leave reasons to them.
      const { getSubtreeUserIds } = await import("@/lib/hierarchy");
      const subtree = await getSubtreeUserIds(auth.userId);
      visibleUserIds = [...subtree];
    }

    const requests = await db.leaveRequest.findMany({
      where: visibleUserIds ? { userId: { in: visibleUserIds } } : {},
      orderBy: [{ status: "asc" }, { createdAt: "desc" }],
      // PR-21 — hard cap; the queue view renders one screen of cards, and a
      // multi-year workspace archive is a paginated/reporting concern.
      take: 500,
    });

    const types = await db.leaveType.findMany({ orderBy: { name: "asc" }, include: { policy: true } });
    const typeById = new Map(types.map((t) => [t.id, t]));

    const userIds = [...new Set(requests.map((r) => r.userId))];
    const deciderIds = [...new Set(requests.map((r) => r.decidedById).filter(Boolean) as string[])];
    const people = userIds.length || deciderIds.length
      ? await db.user.findMany({
          where: { id: { in: [...userIds, ...deciderIds] } },
          select: { id: true, name: true },
        })
      : [];
    const names = new Map(people.map((p) => [p.id, p.name]));

    return {
      requests: requests.map((r) => ({
        id: r.id,
        leaveTypeId: r.leaveTypeId,
        typeName: typeById.get(r.leaveTypeId)?.name ?? "Leave",
        typeColor: typeById.get(r.leaveTypeId)?.color ?? "#8b5cf6",
        userId: r.userId,
        userName: names.get(r.userId) ?? "(former user)",
        startDate: r.startDate.toISOString().slice(0, 10),
        endDate: r.endDate.toISOString().slice(0, 10),
        days: r.days,
        reason: r.reason,
        status: r.status as LeaveStatus,
        decidedById: r.decidedById,
        decidedBy: r.decidedById ? names.get(r.decidedById) ?? null : null,
        decidedAt: r.decidedAt ? r.decidedAt.toISOString() : null,
        decisionNote: r.decisionNote,
        createdAt: r.createdAt.toISOString(),
      })),
      canAdmin,
      canManageAttendance,
      types: types.map((t) => ({
        id: t.id,
        name: t.name,
        code: t.code,
        requiresDoc: t.requiresDoc,
        paid: t.paid,
        color: t.color,
        active: t.active,
        policy: t.policy ? policyDto(t.policy) : null,
      })),
    };
  });
}

/** F2.4 — the policy DTO: every strategy knob the UI renders, straight
 * from the row (post-migration columns are never null). */
function policyDto(p: NonNullable<LeavePolicyRow> & Record<string, unknown>): NonNullable<LeaveTypeT["policy"]> {
  return {
    annualDays: p.annualDays,
    maxCarryOver: p.maxCarryOver,
    minNoticeDays: p.minNoticeDays,
    maxConsecutiveDays: p.maxConsecutiveDays,
    allocationStrategy: (p.allocationStrategy ?? "MANUAL") as LeaveAllocationStrategy,
    accrualFrequency: (p.accrualFrequency ?? "MONTHLY") as LeaveAccrualFrequency,
    allocateOnDay: (p.allocateOnDay ?? "FIRST") as LeaveAllocateOnDay,
    accrualRounding: (p.accrualRounding ?? "FLOOR_QUARTER") as LeaveAccrualRounding,
    accrualCap: p.accrualCap ?? null,
    grantOn: (p.grantOn ?? "PERIOD_START") as LeaveGrantOn,
    prorateForJoiners: p.prorateForJoiners ?? true,
    minServiceMonths: p.minServiceMonths ?? 0,
    accrueDuringProbation: p.accrueDuringProbation ?? true,
    allowNegative: p.allowNegative ?? false,
    negativeFloor: p.negativeFloor ?? 0,
    carryExpiresAfterMonths: p.carryExpiresAfterMonths ?? null,
    countHolidaysInLeave: p.countHolidaysInLeave ?? false,
  };
}

// ---------------------------------------------------------------------------
// Create request
// ---------------------------------------------------------------------------

export async function createLeaveRequest(input: {
  leaveTypeId: string;
  startDate: string;
  endDate: string;
  reason?: string;
}): Promise<ActionResult<{ id: string; days: number }>> {
  return toResult(async () => {
    const auth = await requirePermission("leave:request");
    const data = parseOrThrow(createLeaveRequestSchema, input);

    const type = await db.leaveType.findUnique({
      where: { id: data.leaveTypeId },
      include: { policy: true },
    });
    if (!type || !type.active) throw new AuthorizationError("Unknown or inactive leave type.");

    // F2.1 — offboarding finality: an EXITED employee cannot request leave
    // (the benchmark's active-employee check, at the one gate Fernly has).
    // "" (not tracked) and every other status stay requestable — only the
    // recorded exit ends the arc.
    const requesterProfile = await db.employeeProfile.findUnique({
      where: { userId: auth.userId },
      select: { employmentStatus: true },
    });
    if (requesterProfile?.employmentStatus === "EXITED") {
      throw new AuthorizationError(
        "Your employment is recorded as exited — leave requests are closed. Contact HR if this is wrong.",
      );
    }

    const start = parseDay(data.startDate);
    const end = parseDay(data.endDate);
    if (daysBetween(start, end) < 0) {
      throw new AuthorizationError("The end date must be on or after the start date.");
    }
    // F1.1 — holiday-aware count: weekends never count, holiday-calendar
    // entries on weekdays are excluded (half-days count 0.5). Denormalized
    // onto the request below and never re-derived.
    // F-R4 — the notice window needs the same holiday awareness, so a NEAR
    // start (within the notice window below) widens this one read to include
    // today→start; a far start keeps the read scoped to the request's own
    // range (the read contract the F1.1 tests pin).
    const today = todayUTC();
    const noticeFrom = new Date(today.getTime() + 86_400_000);
    const gap = daysBetween(today, start);
    // 3N+1 calendar days always contain at least N working days — beyond
    // this window the calendar gap alone guarantees the notice minimum, so
    // the precise (holiday-aware) count is unnecessary.
    const noticeWindow =
      type.policy && type.policy.minNoticeDays > 0 ? type.policy.minNoticeDays * 3 + 1 : 0;
    const nearStart = gap >= 1 && gap <= noticeWindow;
    const holidays = await getHolidayLookup(nearStart ? noticeFrom : start, end);
    // F2.4 — include-holiday mode (LV-B05): when the type counts holidays
    // as leave days, only HALF-day entries stay in the counting lookup (a
    // full holiday consumes a whole leave day, a half-day holiday half of
    // one). The default (false) is the F1.1 holiday-aware count unchanged —
    // and the notice window above always keeps the precise holiday-aware
    // count (notice is about working days of warning, not consumption).
    const resolvedPolicy = resolveLeavePolicy(type.policy);
    const countingHolidays = resolvedPolicy.countHolidaysInLeave
      ? new Map([...holidays].filter(([, v]) => v.isHalfDay))
      : holidays;
    const days = workingDaysBetween(start, end, countingHolidays);
    if (days <= 0) {
      throw new AuthorizationError("That range contains no working days (Mon–Fri, holidays excluded).");
    }

    // Policy guard rails — each check rejects with a specific message so the
    // UI can tell the member exactly which rail they hit.
    const policy = type.policy;
    if (policy) {
      // F-R4 — notice counts WORKING days (Mon–Fri, holiday-aware), as the
      // LeavePolicy.minNoticeDays contract has always promised: working days
      // in (today, start] — today itself is the day the request is filed,
      // not a day of notice. Far starts skip the precise count (the calendar
      // gap already exceeds the window above); past/today starts read as a
      // non-positive gap and fail exactly as they always have.
      const notice = nearStart
        ? workingDaysBetween(noticeFrom, start, holidays)
        : gap;
      if (notice < policy.minNoticeDays) {
        throw new AuthorizationError(
          `${type.name} requires at least ${policy.minNoticeDays} working day(s) of notice — the start date is too soon.`,
        );
      }
      if (days > policy.maxConsecutiveDays) {
        throw new AuthorizationError(
          `${type.name} allows at most ${policy.maxConsecutiveDays} consecutive days — this request spans ${days}.`,
        );
      }
    }

    // Overlap — no two active (PENDING/APPROVED) requests may intersect.
    if (await findOverlappingActiveRequest(auth.userId, start, end)) {
      throw new AuthorizationError("You already have a pending or approved request overlapping those dates.");
    }

    // F2.4 — LV-B07 service gate (minServiceMonths > 0): no leave of this
    // type before N months of service. A user with no hire date on record
    // passes (unknown ≠ ineligible — the rule refuses to fabricate).
    if (resolvedPolicy.minServiceMonths > 0) {
      const profile = await db.employeeProfile.findUnique({
        where: { userId: auth.userId },
        select: { hireDate: true, employmentStatus: true, probationEndsAt: true },
      });
      const facts = profile
        ? {
            hireDate: profile.hireDate ? profile.hireDate.toISOString().slice(0, 10) : null,
            employmentStatus: profile.employmentStatus,
            probationEndsAt: profile.probationEndsAt ? profile.probationEndsAt.toISOString().slice(0, 10) : null,
          }
        : null;
      const eligibility = checkServiceEligibility(resolvedPolicy, facts, data.startDate);
      if (!eligibility.ok) {
        throw new AuthorizationError(
          `${type.name} requires ${resolvedPolicy.minServiceMonths} month(s) of service before it can be taken — ` +
            `you have ${eligibility.monthsOfService ?? 0} so far.`,
        );
      }
    }

    // Balance — insufficient balance rejects at submission (scoping
    // decision). F2.4: floor-aware — with allowNegative the member may
    // spend into an advance down to −negativeFloor days.
    const year = start.getUTCFullYear();
    const balance = await getOrCreateBalance(auth.userId, type.id, year, type.policy);
    const available = balance.entitled + balance.carriedOver - balance.used;
    const guard = checkLeaveRequestAgainstBalance(resolvedPolicy, days, available);
    if (!guard.ok) {
      throw new AuthorizationError(
        `Insufficient balance: ${days} day(s) requested, ${available} available for ${type.name}${advanceHint(resolvedPolicy)}.`,
      );
    }

    const created = await db.leaveRequest.create({
      data: {
        leaveTypeId: type.id,
        userId: auth.userId,
        startDate: start,
        endDate: end,
        days,
        reason: data.reason ?? "",
        status: "PENDING",
      },
    });

    // Notify the approver (best-effort — never blocks the request).
    try {
      const approverIds = await getApproverIdsFor(auth.userId);
      if (approverIds.length) {
        await db.notification.createMany({
          data: approverIds.map((id) => ({
            recipientUserId: id,
            type: "INFO",
            title: "Leave request awaiting your approval",
            message: `${auth.name} requested ${days} day(s) of ${type.name} (${data.startDate} → ${data.endDate}).`,
          })),
        });
      }
    } catch (err) {
      // Notification failures must not break the request.
      logError("[hr-leave] notification createMany failed:", err);
    }

    await logAudit({
      actor: auth,
      action: "leave.requested",
      entityType: "LEAVE_REQUEST",
      entityId: created.id,
      entityLabel: `${type.name} ${data.startDate} → ${data.endDate}`,
      detail: `${auth.name} requested ${days} day(s) of ${type.name} (${data.startDate} → ${data.endDate}).`,
    });
    revalidatePath("/");
    return { id: created.id, days };
  });
}

// ---------------------------------------------------------------------------
// Decide (approve / reject) — manager-chain or ADMIN only
// ---------------------------------------------------------------------------

export async function decideLeaveRequest(input: {
  requestId: string;
  decision: "APPROVE" | "REJECT";
  note?: string;
}): Promise<ActionResult<void>> {
  return toResult(async () => {
    const auth = await requirePermission("hr:view");
    const data = parseOrThrow(decideLeaveRequestSchema, input);

    const request = await db.leaveRequest.findUnique({ where: { id: data.requestId } });
    if (!request) throw new AuthorizationError("Leave request not found.");
    if (request.status !== "PENDING") {
      throw new AuthorizationError(`This request is already ${LEAVE_STATUS_LABELS[request.status as LeaveStatus] ?? request.status}.`);
    }
    await assertLeaveDecider(auth, request.userId);

    const newStatus: LeaveStatus = data.decision === "APPROVE" ? "APPROVED" : "REJECTED";
    const type = await db.leaveType.findUnique({
      where: { id: request.leaveTypeId },
      select: { name: true, policy: true },
    });
    const requester = await db.user.findUnique({ where: { id: request.userId }, select: { name: true } });

    if (data.decision === "APPROVE") {
      // F1.2 — `used` changes here and in cancel, transactionally, through
      // an append-only CONSUME ledger row (never a cache mutation on its
      // own): the LeaveLedgerEntry is the source of truth, and the
      // LeaveBalance cache is re-synced from the ledger projection inside
      // the same transaction.
      //
      // QA-1 (overdraft guard): the balance is re-validated at approval
      // time, INSIDE the transaction, against the LEDGER aggregate — not the
      // cache this write is about to update. At submission each of two
      // non-overlapping requests can individually pass the check, so the
      // second approval must refuse (not blindly debit) once the first one
      // has consumed the remaining days.
      //
      // QA-16: the PENDING precheck above runs BEFORE this write. Two tabs
      // (or two deciders) can both pass it; without a status guard in the
      // WHERE clause both "win" and the balance is debited TWICE (or an
      // approve/reject interleave leaves a REJECTED row with debited days).
      // The guarded updateMany flips the row atomically; a zero count means
      // someone else won the race — abort BEFORE any ledger write, with a
      // message the UI can show as a normal (retryable) failure.
      const year = request.startDate.getUTCFullYear();
      await db.$transaction(async (tx) => {
        const flipped = await tx.leaveRequest.updateMany({
          where: { id: request.id, status: "PENDING" },
          data: {
            status: newStatus,
            decidedById: auth.userId,
            decidedAt: new Date(),
            decisionNote: data.note ?? "",
          },
        });
        if (flipped.count === 0) {
          throw new AuthorizationError(
            "This request is no longer pending — it was just decided or cancelled elsewhere. Refresh and try again.",
          );
        }
        // F1.2 — materialize the balance row + its GRANT ledger row when
        // missing (check-then-create: a unique-trio race aborts the
        // transaction loudly — the decider retries — instead of the old
        // try/catch-re-read, which silently swallowed into a Postgres
        // aborted-transaction state; a materialized row without its ledger
        // explanation can never exist).
        await materializeLeaveBalanceTx(
          tx, request.userId, request.leaveTypeId, year,
        );

        // QA-1: the guard reads the LEDGER projection (one groupBy
        // aggregate). `available` is Σ(all deltas) — entitlement, carry,
        // adjustments and consumption in one number the cache cannot lie
        // about. F2.4: floor-aware — with allowNegative the approval may
        // lawfully land the member into an advance down to −negativeFloor
        // days (identical rejection at floor 0).
        const projection = await ledgerProjectionFor(
          tx, request.userId, request.leaveTypeId, year,
        );
        const resolved = resolveLeavePolicy(type?.policy);
        const guard = checkLeaveRequestAgainstBalance(resolved, request.days, projection.available);
        if (!guard.ok) {
          throw new AuthorizationError(
            `Insufficient balance: ${request.days} day(s) requested, only ${projection.available} day(s) left for ${type?.name ?? "this leave type"}${advanceHint(resolved)}.`,
          );
        }

        // The consumption row — append-only (F1.2). One row per approval,
        // double-book-proof via the guarded status flip above; its undo (a
        // cancel) will be a sibling reversal row, never an edit or delete.
        await tx.leaveLedgerEntry.create({
          data: {
            userId: request.userId,
            leaveTypeId: request.leaveTypeId,
            year,
            delta: -request.days,
            entryType: "CONSUME",
            sourceType: "LEAVE_REQUEST",
            sourceId: request.id,
            note: `${type?.name ?? "Leave"} ${request.startDate.toISOString().slice(0, 10)} → ${request.endDate.toISOString().slice(0, 10)} (${request.days} d)`,
            isReversal: false,
          },
        });

        // Cache sync — an ABSOLUTE set from the projection (QA-1b's atomic
        // increment, superseded): the ledger row above is the truth, and an
        // absolute set also heals any drift the cache row carried.
        await tx.leaveBalance.update({
          where: { userId_leaveTypeId_year: { userId: request.userId, leaveTypeId: request.leaveTypeId, year } },
          data: { used: projection.used + request.days },
        });
        // F1.3 — approved leave derives ON_LEAVE attendance rows for every
        // date in range that does not already have a record (an explicit HR
        // mark wins; re-approval is idempotent). Inside the transaction so a
        // rolled-back approval never leaves phantom rows. The leave.approved
        // audit entry below is the decision's record — rows are just state.
        await deriveOnLeaveAttendance(tx, request, type?.name ?? "Leave");
      });
    } else {
      // QA-16: same guarded write on the reject path — a concurrent
      // decide/cancel must not be overwritten (last-writer-wins used to
      // silently flip an APPROVED request to REJECTED, decidedBy and all).
      const flipped = await db.leaveRequest.updateMany({
        where: { id: request.id, status: "PENDING" },
        data: {
          status: newStatus,
          decidedById: auth.userId,
          decidedAt: new Date(),
          decisionNote: data.note ?? "",
        },
      });
      if (flipped.count === 0) {
        throw new AuthorizationError(
          "This request is no longer pending — it was just decided or cancelled elsewhere. Refresh and try again.",
        );
      }
    }

    // Notify the requester (best-effort).
    try {
      await db.notification.create({
        data: {
          recipientUserId: request.userId,
          type: data.decision === "APPROVE" ? "SUCCESS" : "WARNING",
          title: `Leave request ${newStatus.toLowerCase()}`,
          message: `${auth.name} ${data.decision === "APPROVE" ? "approved" : "rejected"} your ${request.days}-day ${type?.name ?? "leave"} request${data.note ? `: ${data.note}` : "."}`,
        },
      });
    } catch (err) {
      // Never break the decision on a notification failure.
      logError("[hr-leave] notification create failed:", err);
    }

    await logAudit({
      actor: auth,
      action: data.decision === "APPROVE" ? "leave.approved" : "leave.rejected",
      entityType: "LEAVE_REQUEST",
      entityId: request.id,
      entityLabel: `${type?.name ?? "Leave"} ${request.startDate.toISOString().slice(0, 10)} → ${request.endDate.toISOString().slice(0, 10)}`,
      detail: `${auth.name} ${data.decision === "APPROVE" ? "approved" : "rejected"} ${requester?.name ?? "a member"}'s ${request.days}-day ${type?.name ?? "leave"} request${data.note ? ` — ${data.note}` : ""}.`,
    });
    revalidatePath("/");
  });
}

// ---------------------------------------------------------------------------
// Cancel — requester (while PENDING or APPROVED) or ADMIN; restores balance
// when an APPROVED request is cancelled.
// ---------------------------------------------------------------------------

export async function cancelLeaveRequest(input: { requestId: string }): Promise<ActionResult<void>> {
  return toResult(async () => {
    const auth = await requirePermission("leave:request");
    const data = parseOrThrow(cancelLeaveRequestSchema, input);

    const request = await db.leaveRequest.findUnique({ where: { id: data.requestId } });
    if (!request) throw new AuthorizationError("Leave request not found.");
    if (auth.userId !== request.userId && auth.role !== "ADMIN") {
      throw new AuthorizationError("Only the requester (or an admin) can cancel a leave request.");
    }
    if (request.status !== "PENDING" && request.status !== "APPROVED") {
      throw new AuthorizationError(`Only pending or approved requests can be cancelled — this one is ${request.status.toLowerCase()}.`);
    }

    const wasApproved = request.status === "APPROVED";
    if (wasApproved) {
      // Give the days back — transactional with the status flip. F1.2: the
      // refund is an append-only CONSUME reversal row (the approval row's
      // undo — the pair nets to zero in the ledger), and the cache sync
      // below clamps at zero so a drifted cache can never go below it.
      // QA-16: the status precheck above ran BEFORE this write — two tabs
      // cancelling the same APPROVED request both passed it and the second
      // restore was a double refund. The guarded updateMany makes a stale
      // cancel a zero-row update that aborts BEFORE the reversal.
      const year = request.startDate.getUTCFullYear();
      await db.$transaction(async (tx) => {
        const flipped = await tx.leaveRequest.updateMany({
          where: { id: request.id, status: "APPROVED" },
          data: { status: "CANCELLED", updatedAt: new Date() },
        });
        if (flipped.count === 0) {
          throw new AuthorizationError(
            "This request is no longer approved — it was just cancelled or changed elsewhere. Refresh and try again.",
          );
        }
        // F1.2 — the reversal row: append-only undo of the approval's
        // CONSUME entry. `used` lands exactly where the old decrement put
        // it (the pair nets to zero), but now BOTH events survive as rows —
        // the ledger's story of "approved then cancelled" is auditable.
        await tx.leaveLedgerEntry.create({
          data: {
            userId: request.userId,
            leaveTypeId: request.leaveTypeId,
            year,
            delta: request.days,
            entryType: "CONSUME",
            sourceType: "LEAVE_REQUEST",
            sourceId: request.id,
            note: `Reversal: approved request cancelled (${request.days} d returned)`,
            isReversal: true,
          },
        });

        // Cache sync — absolute set from the post-reversal projection,
        // clamped at zero (the old min() decrement's guarantee, kept).
        const projection = await ledgerProjectionFor(
          tx, request.userId, request.leaveTypeId, year,
        );
        await tx.leaveBalance.update({
          where: { userId_leaveTypeId_year: { userId: request.userId, leaveTypeId: request.leaveTypeId, year } },
          data: { used: Math.max(0, projection.used) },
        });
        // F1.3 — cancelling approved leave removes its DERIVED ON_LEAVE
        // rows again (dates still covered by ANOTHER approved request keep
        // theirs; MANUAL/IMPORT records are never touched). Transactional
        // with the status flip + refund above.
        await removeDerivedOnLeaveAttendance(tx, request);
      });
    } else {
      // QA-16: a cancel that read PENDING can race a concurrent approval —
      // a plain update would flip the just-APPROVED row to CANCELLED
      // WITHOUT restoring the days the approval debited (permanent leak).
      // The guarded write loses that race loudly instead; retrying the
      // cancel then takes the proper APPROVED restore path above.
      const flipped = await db.leaveRequest.updateMany({
        where: { id: request.id, status: "PENDING" },
        data: { status: "CANCELLED", updatedAt: new Date() },
      });
      if (flipped.count === 0) {
        throw new AuthorizationError(
          "This request is no longer pending — it was just approved or decided elsewhere. Cancel it again to undo the approved days.",
        );
      }
    }

    const type = await db.leaveType.findUnique({ where: { id: request.leaveTypeId }, select: { name: true } });
    await logAudit({
      actor: auth,
      action: "leave.cancelled",
      entityType: "LEAVE_REQUEST",
      entityId: request.id,
      entityLabel: `${type?.name ?? "Leave"} ${request.startDate.toISOString().slice(0, 10)} → ${request.endDate.toISOString().slice(0, 10)}`,
      detail: `${auth.name} cancelled a ${wasApproved ? "previously approved" : "pending"} ${request.days}-day ${type?.name ?? "leave"} request${wasApproved ? " (balance restored)" : ""}.`,
    });
    revalidatePath("/");
  });
}

// ---------------------------------------------------------------------------
// Types & policies (hr:admin)
// ---------------------------------------------------------------------------

export async function createLeaveType(input: {
  name: string;
  code: string;
  color?: string;
  requiresDoc?: boolean;
  paid?: boolean;
  policy: {
    annualDays: number;
    maxCarryOver: number;
    minNoticeDays: number;
    maxConsecutiveDays: number;
    // F2.4 strategy block — all optional; zod defaults reproduce the
    // pre-F2.4 semantics (MANUAL, no negative allowance, holidays excluded).
    allocationStrategy?: "MANUAL" | "ANNUAL_LUMP_SUM" | "EARNED" | "AFTER_SERVICE";
    accrualFrequency?: "MONTHLY" | "QUARTERLY" | "HALF_YEARLY" | "ANNUAL";
    allocateOnDay?: "FIRST" | "LAST" | "DOJ_DAY";
    accrualRounding?: "FLOOR_QUARTER" | "NEAREST";
    accrualCap?: number | null;
    grantOn?: "PERIOD_START" | "ANNIVERSARY";
    prorateForJoiners?: boolean;
    minServiceMonths?: number;
    accrueDuringProbation?: boolean;
    allowNegative?: boolean;
    negativeFloor?: number;
    carryExpiresAfterMonths?: number | null;
    countHolidaysInLeave?: boolean;
  };
}): Promise<ActionResult<{ id: string }>> {
  return toResult(async () => {
    const auth = await requirePermission("hr:admin");
    const data = parseOrThrow(leaveTypeSchema, input);

    let created;
    try {
      created = await db.leaveType.create({
        data: {
          name: data.name,
          code: data.code,
          color: data.color,
          requiresDoc: data.requiresDoc,
          paid: data.paid,
          active: true,
          policy: { create: data.policy },
        },
        include: { policy: true },
      });
    } catch (e) {
      // QA-18: LeaveType.name and .code are @unique. A duplicate used to
      // surface as the generic INTERNAL "Something went wrong" — which
      // reads like a server bug and can never succeed on retry. Map the
      // unique-constraint violation to a real message.
      if (isUniqueConstraintError(e)) {
        throw new AuthorizationError(
          `A leave type named "${data.name}" (or code ${data.code}) already exists — names and codes must be unique.`,
        );
      }
      throw e;
    }

    await logAudit({
      actor: auth,
      action: "leave.type_created",
      entityType: "LEAVE_TYPE",
      entityId: created.id,
      entityLabel: created.name,
      detail: `${auth.name} created leave type "${created.name}" (${created.code}) — ${data.policy.annualDays} days/year.`,
    });
    revalidatePath("/");
    return { id: created.id };
  });
}

export async function updateLeaveType(id: string, input: {
  name?: string;
  color?: string;
  requiresDoc?: boolean;
  paid?: boolean;
  active?: boolean;
  policy?: {
    annualDays: number;
    maxCarryOver: number;
    minNoticeDays: number;
    maxConsecutiveDays: number;
    // F2.4 strategy block — same shape as createLeaveType; the form always
    // sends the complete policy (a partial policy update that silently
    // reset a strategy to MANUAL is exactly the drift this avoids).
    allocationStrategy?: "MANUAL" | "ANNUAL_LUMP_SUM" | "EARNED" | "AFTER_SERVICE";
    accrualFrequency?: "MONTHLY" | "QUARTERLY" | "HALF_YEARLY" | "ANNUAL";
    allocateOnDay?: "FIRST" | "LAST" | "DOJ_DAY";
    accrualRounding?: "FLOOR_QUARTER" | "NEAREST";
    accrualCap?: number | null;
    grantOn?: "PERIOD_START" | "ANNIVERSARY";
    prorateForJoiners?: boolean;
    minServiceMonths?: number;
    accrueDuringProbation?: boolean;
    allowNegative?: boolean;
    negativeFloor?: number;
    carryExpiresAfterMonths?: number | null;
    countHolidaysInLeave?: boolean;
  };
}): Promise<ActionResult<void>> {
  return toResult(async () => {
    const auth = await requirePermission("hr:admin");
    const data = parseOrThrow(updateLeaveTypeSchema, input);

    const existing = await db.leaveType.findUnique({ where: { id } });
    if (!existing) throw new AuthorizationError("Leave type not found.");

    // PR-15 (production-readiness audit) — the leave type and its policy are
    // one logical write. A crash between the update and the upsert previously
    // left the type renamed but the entitlement (annual days) unchanged —
    // balances materialised afterwards would disagree with older ones.
    await db.$transaction(async (tx) => {
      await tx.leaveType.update({
        where: { id },
        data: {
          ...(data.name !== undefined ? { name: data.name } : {}),
          ...(data.color !== undefined ? { color: data.color } : {}),
          ...(data.requiresDoc !== undefined ? { requiresDoc: data.requiresDoc } : {}),
          ...(data.paid !== undefined ? { paid: data.paid } : {}),
          ...(data.active !== undefined ? { active: data.active } : {}),
        },
      });
      if (data.policy) {
        await tx.leavePolicy.upsert({
          where: { leaveTypeId: id },
          create: { leaveTypeId: id, ...data.policy },
          update: data.policy,
        });
      }
    });

    await logAudit({
      actor: auth,
      action: "leave.type_updated",
      entityType: "LEAVE_TYPE",
      entityId: id,
      entityLabel: data.name ?? existing.name,
      detail: `${auth.name} updated leave type "${data.name ?? existing.name}"${data.active === false ? " (deactivated)" : ""}.`,
    });
    revalidatePath("/");
  });
}


// ---------------------------------------------------------------------------
// LV-10 (S9) — the user-facing ADJUST writer: HR corrections on the ledger
// ---------------------------------------------------------------------------

/**
 * Adjust one member's leave balance for a year: an append-only ADJUST row
 * (signed days, REASON REQUIRED — an adjustment without a recorded why is
 * exactly the silent drift the ledger exists to prevent) plus the
 * transactional cache re-sync. hr:admin gated — the same surface as the
 * type/policy editor. The floor rule: an adjustment can never leave the
 * balance further below zero than the policy's advance-leave floor
 * (consumption and corrections share one bound).
 */
export async function adjustLeaveBalance(input: {
  userId: string;
  leaveTypeId: string;
  year: number;
  delta: number;
  reason: string;
}): Promise<ActionResult<{ availableBefore: number; availableAfter: number }>> {
  return toResult(async () => {
    const auth = await requirePermission("hr:admin");
    const data = parseOrThrow(adjustLeaveBalanceSchema, input);

    const [user, type] = await Promise.all([
      db.user.findUnique({ where: { id: data.userId }, select: { id: true, name: true, deletedAt: true } }),
      db.leaveType.findUnique({ where: { id: data.leaveTypeId }, include: { policy: true } }),
    ]);
    if (!user || user.deletedAt) throw new AuthorizationError("Member not found.");
    if (!type) throw new AuthorizationError("Leave type not found.");

    const policy = resolveLeavePolicy(type.policy);
    const floor = policy.allowNegative ? policy.negativeFloor : 0;

    // Materialize-if-missing + append the ADJUST row + re-sync the cache,
    // all in ONE transaction; the floor check reads the POST-materialization
    // truth (the ledger), so a first-ever adjustment lands on real numbers.
    const { availableBefore, availableAfter } = await db.$transaction(async (tx) => {
      await materializeLeaveBalanceTx(tx, data.userId, data.leaveTypeId, data.year);
      const before = await ledgerProjectionFor(tx, data.userId, data.leaveTypeId, data.year);
      const plan = planLeaveAdjustment({ available: before.available, delta: data.delta, negativeFloor: floor });
      if (!plan.withinFloor) {
        throw new AuthorizationError(
          `This adjustment would leave ${user.name} at ${plan.newAvailable} day(s) — past the −${floor}-day advance floor for ${type.name}. Reduce the correction, or raise the floor in the type's policy first.`,
        );
      }
      await tx.leaveLedgerEntry.create({
        data: {
          userId: data.userId,
          leaveTypeId: data.leaveTypeId,
          year: data.year,
          delta: data.delta,
          entryType: "ADJUST",
          sourceType: "HR_ADJUSTMENT",
          sourceId: "hr-adjust",
          note: data.reason,
          isReversal: false,
        },
      });
      const after = await ledgerProjectionFor(tx, data.userId, data.leaveTypeId, data.year);
      // Cache re-sync (absolute, drift-healing). Entitlement-side
      // corrections (ADJUST + EXPIRE) fold into `entitled` so the
      // member-facing available == Σ ledger deltas exactly.
      await tx.leaveBalance.update({
        where: { userId_leaveTypeId_year: { userId: data.userId, leaveTypeId: data.leaveTypeId, year: data.year } },
        data: {
          entitled: after.entitled + after.adjustments,
          carriedOver: after.carriedOver,
          used: Math.max(0, after.used),
        },
      });
      return { availableBefore: before.available, availableAfter: after.available };
    });

    await logAudit({
      actor: auth,
      action: "hr.leave_adjusted",
      entityType: "LEAVE_TYPE",
      entityId: type.id,
      entityLabel: `${type.name} · ${user.name} · ${data.year}`,
      detail: `${auth.name} adjusted ${user.name}'s ${type.name} balance for ${data.year} by ${data.delta > 0 ? "+" : ""}${data.delta} day(s) (${availableBefore} → ${availableAfter} available) — ${data.reason}`,
    });
    revalidatePath("/");
    return { availableBefore, availableAfter };
  });
}
