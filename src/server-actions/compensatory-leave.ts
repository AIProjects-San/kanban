"use server";

// ---------------------------------------------------------------------------
// P30 (LV-01/LV-11, L10) — compensatory leave server actions
// (docs/Fernly_HR_Payroll_Enhancement_Plan.md §7.2.2 item P30; the
// benchmark's `Compensatory Leave Request` doctype).
//
// The flow rides the proven encashment/leave machinery end to end:
//   • claim (member, leave:request) walks the span through the pure
//     earnedCompDays kernel — EVERY day must be a weekend/holiday with worked
//     attendance (PRESENT/WFH = 1 day, HALF_DAY = 0.5); the same facts are
//     re-validated INSIDE the approval transaction (QA-1: attendance may
//     have been corrected between submission and decision);
//   • decision (hr:view + assertLeaveDecider — the S14 approver chain)
//     flips the row through a guarded updateMany (QA-16: two deciders
//     cannot both win);
//   • APPROVE writes the comp GRANT ledger row (+days, sourceType
//     COMP_REQUEST — the append-only F1.2 source of truth) and re-syncs
//     the LeaveBalance cache in ONE transaction; the days then spend
//     through the normal createLeaveRequest path against the compensatory
//     type (annualDays 0 in the usual shape — earned days are the only
//     entitlement);
//   • REJECTED claims nothing (no ledger row, no balance change).
//
// The GRANT lands in the ACTIVE allocation window's bucket (the same bucket
// the cron's grant phase advances — near-term consumption lives there);
// a year-end boundary carries whatever maxCarryOver allows, exactly like
// every other type.
// ---------------------------------------------------------------------------

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requirePermission, AuthorizationError } from "./auth-guard";
import { logAudit } from "./shared";
import { toResult } from "./result";
import type { ActionResult } from "@/lib/action-result";
import { parseOrThrow, createCompLeaveRequestSchema, decideCompLeaveRequestSchema } from "@/lib/validation";
import { earnedCompDays } from "@/lib/compensatory-leave";
import { dayKey, holidayLookupFrom } from "@/lib/working-days";
import {
  todayUTC,
  getApproverIdsFor,
  assertLeaveDecider,
  ledgerProjectionFor,
  materializeLeaveBalanceTx,
  loadLeavePeriods,
  windowArgFor,
} from "./hr-shared";
import { resolveActiveWindow } from "@/lib/leave-period";
import type { CompLeaveRequestT } from "@/lib/types";

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

type CompRow = {
  id: string;
  userId: string;
  leaveTypeId: string;
  workFromDate: Date;
  workToDate: Date;
  days: number;
  reason: string;
  status: string;
  decidedById: string | null;
  decidedAt: Date | null;
  decisionNote: string;
  createdAt: Date;
};

function serializeComp(
  row: CompRow,
  userName: string,
  typeName: string,
  typeColor: string,
  decidedBy: string | null,
): CompLeaveRequestT {
  return {
    id: row.id,
    userId: row.userId,
    userName,
    leaveTypeId: row.leaveTypeId,
    typeName,
    typeColor,
    workFromDate: row.workFromDate.toISOString().slice(0, 10),
    workToDate: row.workToDate.toISOString().slice(0, 10),
    days: row.days,
    reason: row.reason,
    status: (["PENDING", "APPROVED", "REJECTED"].includes(row.status)
      ? row.status
      : "PENDING") as CompLeaveRequestT["status"],
    decidedById: row.decidedById,
    decidedBy,
    decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
    decisionNote: row.decisionNote,
    createdAt: row.createdAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Shared validation helpers (the submission and the approval's in-tx
// re-validation run the SAME code — one rule, two surfaces)
// ---------------------------------------------------------------------------

/** Read the attendance facts for a worked span via the caller's client
 * (the global db at submission, the transaction inside the decision —
 * the tx-hygiene rule). Returns the day-key → status map. */
async function attendanceMapFor(
  client: { attendanceRecord: { findMany: typeof db.attendanceRecord.findMany } },
  userId: string,
  workFrom: Date,
  workTo: Date,
): Promise<Map<string, string>> {
  const rows = await client.attendanceRecord.findMany({
    where: { userId, date: { gte: workFrom, lte: workTo } },
    select: { date: true, status: true },
  });
  return new Map(rows.map((r) => [dayKey(r.date), r.status]));
}

/** The refusal message naming the first few refused days (the LV-B03
 * worked-holiday validation, humanized). */
function problemsMessage(problems: ReadonlyArray<{ date: string; reason: string }>): string {
  const shown = problems.slice(0, 3).map((p) => `${p.date} ${p.reason}`);
  return `${shown.join("; ")}${problems.length > 3 ? ` (and ${problems.length - 3} more day(s))` : ""}`;
}

// ---------------------------------------------------------------------------
// Claim (member-facing)
// ---------------------------------------------------------------------------

export async function createCompensatoryLeaveRequest(input: unknown): Promise<ActionResult<{ id: string; days: number }>> {
  return toResult(async () => {
    const auth = await requirePermission("leave:request");
    const data = parseOrThrow(createCompLeaveRequestSchema, input);

    const type = await db.leaveType.findUnique({
      where: { id: data.leaveTypeId },
      include: { policy: true },
    });
    if (!type || !type.active) throw new AuthorizationError("Leave type not found.");
    if (!type.isCompensatory) {
      throw new AuthorizationError(
        `${type.name} is not a compensatory type — comp-off claims ride types marked Comp.`,
      );
    }

    // F2.1 — the same exit-finality gate as time-off: an EXITED employee's
    // comp arc is closed (their ledger keeps its rows).
    const requesterProfile = await db.employeeProfile.findUnique({
      where: { userId: auth.userId },
      select: { employmentStatus: true },
    });
    if (requesterProfile?.employmentStatus === "EXITED") {
      throw new AuthorizationError(
        "Your employment is recorded as exited — comp-off claims are closed. Contact HR if this is wrong.",
      );
    }

    const workFrom = new Date(`${data.workFromDate}T00:00:00.000Z`);
    const workTo = new Date(`${data.workToDate}T00:00:00.000Z`);
    if (workTo.getTime() < workFrom.getTime()) {
      throw new AuthorizationError("The worked-to date must be on or after the worked-from date.");
    }
    // The claim is about days already worked — attendance can only have
    // been marked for the past (today included: HR may mark the day's
    // attendance before the member files).
    if (workTo.getTime() > todayUTC().getTime()) {
      throw new AuthorizationError(
        "Comp-off claims cover days you have already worked — the worked-to date can't be in the future.",
      );
    }

    // The worked-holiday walk (LV-B03): every day non-working + attendance
    // shows worked. The walk is the SAME kernel the approval re-runs.
    const [holidayRows, attendance] = await Promise.all([
      db.holidayCalendarEntry.findMany({
        where: { date: { gte: workFrom, lte: workTo } },
        select: { date: true, isHalfDay: true },
      }),
      attendanceMapFor(db, auth.userId, workFrom, workTo),
    ]);
    const walk = earnedCompDays({
      workFrom: data.workFromDate,
      workTo: data.workToDate,
      holidays: holidayLookupFrom(holidayRows),
      attendanceByDay: attendance,
    });
    if (walk.problems.length > 0) {
      throw new AuthorizationError(`The claim can't be filed — ${problemsMessage(walk.problems)}.`);
    }
    if (walk.days <= 0) {
      throw new AuthorizationError("That span earns no comp-off days.");
    }

    // Double-earning guard: one claim per worked day — an ACTIVE (PENDING or
    // APPROVED) comp request of this member overlapping the span refuses
    // (across every compensatory type; the worked day is the fact).
    const overlapping = await db.compensatoryLeaveRequest.findFirst({
      where: {
        userId: auth.userId,
        status: { in: ["PENDING", "APPROVED"] },
        workFromDate: { lte: workTo },
        workToDate: { gte: workFrom },
      },
      select: { id: true, workFromDate: true, workToDate: true },
    });
    if (overlapping) {
      throw new AuthorizationError(
        `You already have a comp-off claim covering ${overlapping.workFromDate.toISOString().slice(0, 10)} → ${overlapping.workToDate.toISOString().slice(0, 10)} — each worked day earns comp once.`,
      );
    }

    const row = await db.compensatoryLeaveRequest.create({
      data: {
        userId: auth.userId,
        leaveTypeId: type.id,
        workFromDate: workFrom,
        workToDate: workTo,
        days: walk.days,
        reason: data.reason,
        status: "PENDING",
      },
    });

    // Notify the approver chain (best-effort, never blocks the claim).
    try {
      const approverIds = await getApproverIdsFor(auth.userId);
      for (const approverId of approverIds) {
        if (approverId === auth.userId) continue;
        await db.notification.create({
          data: {
            recipientUserId: approverId,
            type: "INFO",
            title: "Comp-off claim submitted",
            message: `${auth.name} claimed ${walk.days} comp-off day(s) for working ${data.workFromDate} → ${data.workToDate} (${type.name}).`,
          },
        });
      }
    } catch {
      // Never break the claim on a notification failure.
    }

    await logAudit({
      actor: auth,
      action: "leave.comp_requested",
      entityType: "COMP_REQUEST",
      entityId: row.id,
      entityLabel: `${type.name} ${walk.days}d`,
      detail: `${auth.name} claimed ${walk.days} comp-off day(s) for working ${data.workFromDate} → ${data.workToDate} (${type.name}).`,
    });
    revalidatePath("/");
    return { id: row.id, days: walk.days };
  });
}

// ---------------------------------------------------------------------------
// Decision (the leave-approver chain — same decider as time-off/encashment)
// ---------------------------------------------------------------------------

export async function decideCompensatoryLeaveRequest(input: unknown): Promise<ActionResult<{ ok: true }>> {
  return toResult(async () => {
    const auth = await requirePermission("hr:view");
    const data = parseOrThrow(decideCompLeaveRequestSchema, input);

    const request = await db.compensatoryLeaveRequest.findUnique({ where: { id: data.compId } });
    if (!request) throw new AuthorizationError("Comp-off claim not found.");
    if (request.status !== "PENDING") {
      throw new AuthorizationError(`This comp-off claim is already ${request.status.toLowerCase()}.`);
    }
    await assertLeaveDecider(auth, request.userId);

    const type = await db.leaveType.findUnique({
      where: { id: request.leaveTypeId },
      select: { name: true, isCompensatory: true },
    });
    const requester = await db.user.findUnique({ where: { id: request.userId }, select: { name: true } });

    if (data.decision === "REJECT") {
      // QA-16: the guarded flip — a concurrent decide cannot be overwritten.
      const flipped = await db.compensatoryLeaveRequest.updateMany({
        where: { id: request.id, status: "PENDING" },
        data: {
          status: "REJECTED",
          decidedById: auth.userId,
          decidedAt: new Date(),
          decisionNote: data.note,
        },
      });
      if (flipped.count === 0) {
        throw new AuthorizationError(
          "This claim is no longer pending — it was just decided elsewhere. Refresh and try again.",
        );
      }
      await logAudit({
        actor: auth,
        action: "leave.comp_rejected",
        entityType: "COMP_REQUEST",
        entityId: request.id,
        entityLabel: `${type?.name ?? "Comp"} ${request.days}d`,
        detail: `${auth.name} rejected ${requester?.name ?? "a member"}'s ${request.days}-day comp-off claim${data.note ? ` — ${data.note}` : ""}.`,
      });
      revalidatePath("/");
      return { ok: true };
    }

    // ---- APPROVE ---------------------------------------------------------
    const workFromKey = request.workFromDate.toISOString().slice(0, 10);
    const workToKey = request.workToDate.toISOString().slice(0, 10);

    // The GRANT lands in the ACTIVE window's bucket (the cron's grant-phase
    // bucket — near-term consumption lives there; P27 discipline, no
    // calendar-year guess).
    const periods = await loadLeavePeriods();
    const active = resolveActiveWindow(periods, dayKey(todayUTC()));
    const year = active.bucketYear;

    await db.$transaction(async (tx) => {
      // QA-16: the guarded flip — whoever wins the race owns the decision.
      const flipped = await tx.compensatoryLeaveRequest.updateMany({
        where: { id: request.id, status: "PENDING" },
        data: {
          status: "APPROVED",
          decidedById: auth.userId,
          decidedAt: new Date(),
          decisionNote: data.note,
        },
      });
      if (flipped.count === 0) {
        throw new AuthorizationError(
          "This claim is no longer pending — it was just decided elsewhere. Refresh and try again.",
        );
      }

      // QA-1: re-validate the worked-holiday facts INSIDE the transaction —
      // attendance may have been corrected (or un-marked) since submission.
      // Same kernel, same refusal message.
      const [holidayRows, attendance] = await Promise.all([
        tx.holidayCalendarEntry.findMany({
          where: { date: { gte: request.workFromDate, lte: request.workToDate } },
          select: { date: true, isHalfDay: true },
        }),
        tx.attendanceRecord.findMany({
          where: { userId: request.userId, date: { gte: request.workFromDate, lte: request.workToDate } },
          select: { date: true, status: true },
        }),
      ]);
      const walk = earnedCompDays({
        workFrom: workFromKey,
        workTo: workToKey,
        holidays: holidayLookupFrom(holidayRows),
        attendanceByDay: new Map(attendance.map((r) => [dayKey(r.date), r.status])),
      });
      if (walk.problems.length > 0) {
        throw new AuthorizationError(
          `The claim no longer checks out — ${problemsMessage(walk.problems)}. Correct the attendance records or reject the claim.`,
        );
      }
      if (walk.days !== request.days) {
        throw new AuthorizationError(
          `Attendance for ${workFromKey} → ${workToKey} changed since the claim was filed (it now prices ${walk.days} day(s), the claim says ${request.days}) — reject it and have the member re-file.`,
        );
      }

      // The double-earning re-check (QA-1): a concurrently approved claim
      // covering the same worked day must not earn twice.
      const overlapping = await tx.compensatoryLeaveRequest.findFirst({
        where: {
          userId: request.userId,
          status: "APPROVED",
          id: { not: request.id },
          workFromDate: { lte: request.workToDate },
          workToDate: { gte: request.workFromDate },
        },
        select: { id: true },
      });
      if (overlapping) {
        throw new AuthorizationError(
          "Another approved comp-off claim already covers one of those worked days — each day earns comp once.",
        );
      }

      // Materialize the balance row when missing (fail-closed, the same
      // discipline as the leave approval; a compensatory type with
      // annualDays 0 materializes an empty row — the GRANT below is its
      // whole entitlement story).
      await materializeLeaveBalanceTx(
        tx, request.userId, request.leaveTypeId, year,
        windowArgFor(periods, active),
      );

      // The comp GRANT row — append-only (F1.2), the ONLY writer of comp
      // entitlement. Note names the worked days; the pair (sourceType
      // COMP_REQUEST, sourceId = the claim's id) makes the grant auditable
      // back to the claim that earned it.
      await tx.leaveLedgerEntry.create({
        data: {
          userId: request.userId,
          leaveTypeId: request.leaveTypeId,
          year,
          delta: request.days,
          entryType: "GRANT",
          sourceType: "COMP_REQUEST",
          sourceId: request.id,
          note: `Comp-off earned: worked ${workFromKey} → ${workToKey}`,
          isReversal: false,
        },
      });

      // Cache sync — absolute set from the post-grant projection (heals
      // drift; the comp GRANT folds into `entitled` exactly like the
      // strategy grants the cron writes).
      const after = await ledgerProjectionFor(tx, request.userId, request.leaveTypeId, year);
      await tx.leaveBalance.update({
        where: { userId_leaveTypeId_year: { userId: request.userId, leaveTypeId: request.leaveTypeId, year } },
        data: {
          entitled: after.entitled,
          carriedOver: after.carriedOver,
          used: Math.max(0, after.used),
        },
      });
    });

    // Notify the requester (best-effort).
    try {
      await db.notification.create({
        data: {
          recipientUserId: request.userId,
          type: "SUCCESS",
          title: "Comp-off approved",
          message: `Your ${request.days}-day comp-off claim (${workFromKey} → ${workToKey}) was approved — the days are on your ${type?.name ?? "comp"} balance.`,
        },
      });
    } catch {
      // Never break the decision on a notification failure.
    }

    await logAudit({
      actor: auth,
      action: "leave.comp_approved",
      entityType: "COMP_REQUEST",
      entityId: request.id,
      entityLabel: `${type?.name ?? "Comp"} ${request.days}d`,
      detail: `${auth.name} approved ${requester?.name ?? "a member"}'s ${request.days}-day comp-off claim (worked ${workFromKey} → ${workToKey})${data.note ? ` — ${data.note}` : ""}.`,
    });
    revalidatePath("/");
    return { ok: true };
  });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** The member's own comp-off claims (Leave view). leave:request. */
export async function getMyCompensatoryRequests(): Promise<ActionResult<CompLeaveRequestT[]>> {
  return toResult(async () => {
    const auth = await requirePermission("leave:request");
    const rows = await db.compensatoryLeaveRequest.findMany({
      where: { userId: auth.userId },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    if (rows.length === 0) return [];
    const types = await db.leaveType.findMany({ select: { id: true, name: true, color: true } });
    const typeById = new Map(types.map((t) => [t.id, t]));
    return rows.map((r) =>
      serializeComp(
        r,
        auth.name,
        typeById.get(r.leaveTypeId)?.name ?? "Comp",
        typeById.get(r.leaveTypeId)?.color ?? "#8b5cf6",
        null,
      ),
    );
  });
}

/** The decision queue (HR console) — PENDING claims for people the current
 * user may decide for, mirroring getLeaveQueue's scoping. hr:view. */
export async function getCompensatoryQueue(): Promise<ActionResult<CompLeaveRequestT[]>> {
  return toResult(async () => {
    const auth = await requirePermission("hr:view");

    let visibleUserIds: string[] | null = null;
    if (auth.role === "MANAGER") {
      const { getSubtreeUserIds } = await import("@/lib/hierarchy");
      visibleUserIds = [...(await getSubtreeUserIds(auth.userId))];
    }

    const rows = await db.compensatoryLeaveRequest.findMany({
      where: { status: "PENDING", ...(visibleUserIds ? { userId: { in: visibleUserIds } } : {}) },
      orderBy: { createdAt: "asc" },
      take: 200,
    });
    if (rows.length === 0) return [];

    const types = await db.leaveType.findMany({ select: { id: true, name: true, color: true } });
    const typeById = new Map(types.map((t) => [t.id, t]));
    const userIds = [...new Set(rows.map((r) => r.userId))];
    const people = await db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } });
    const names = new Map(people.map((p) => [p.id, p.name]));
    return rows.map((r) =>
      serializeComp(
        r,
        names.get(r.userId) ?? "(former user)",
        typeById.get(r.leaveTypeId)?.name ?? "Comp",
        typeById.get(r.leaveTypeId)?.color ?? "#8b5cf6",
        null,
      ),
    );
  });
}
