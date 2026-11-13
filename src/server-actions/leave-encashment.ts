"use server";

// ---------------------------------------------------------------------------
// P2 (LV-09, F2.2) — leave encashment server actions.
// docs/Fernly_HR_Payroll_Enhancement_Plan.md §7.2.1 payroll sweep, item 2.
//
// The flow rides the proven leave-request machinery end to end:
//   • request (member, leave:request) validates against the LEDGER
//     projection through the pure planLeaveEncashment kernel — the same
//     projection the approval re-validates INSIDE its transaction (QA-1
//     discipline: a stale request against a drained balance is refused at
//     decision time, not blind-debited);
//   • decision (hr:view + assertLeaveDecider — the S14 approver chain:
//     override → manager → ADMINs) flips the row through a guarded
//     updateMany (QA-16 discipline: two deciders cannot both win);
//   • APPROVE writes the CONSUME ledger row, the balance cache re-sync AND
//     the ENCASHMENT PayAdjustment (the P1 adapter — the money lands on
//     the payout period's run) in ONE transaction;
//   • the consuming run's LOCK flips the row PAID (payroll.ts, via the
//     adapter row's consumedRunId back-link).
//
// The amount snapshots at approval: days × (monthly gross ÷ the payout
// period's holiday-aware working days) — the F2.1 GROSS_OVER_WORKING_DAYS
// basis, the same rate the full-and-final statement uses.
// ---------------------------------------------------------------------------

import { revalidatePath } from "next/cache";
import { db } from "@/lib/infra/db";
import { requirePermission, AuthorizationError } from "./auth-guard";
import { logAudit } from "./shared";
import { toResult } from "./result";
import type { ActionResult } from "@/lib/action-result";
import { parseOrThrow } from "@/lib/validation";
import { requestLeaveEncashmentSchema, decideLeaveEncashmentSchema } from "@/lib/validation";
import { resolveLeavePolicy } from "@/lib/leave/leave-policy";
import { planLeaveEncashment, encashmentDailyRate, encashmentAmount } from "@/lib/leave/leave-encashment";
import { workingDaysInPeriod } from "@/lib/working-days";
import { parseComponents, computeOffer } from "@/lib/offer-math";
import { round2 } from "@/lib/payroll/payroll-math";
import {
  getHolidayLookup,
  todayUTC,
  assertLeaveDecider,
  ledgerProjectionFor,
  materializeLeaveBalanceTx,
  getApproverIdsFor,
} from "./hr-shared";
import { hasPermission } from "@/lib/auth/rbac";
import type { LeaveEncashmentT } from "@/lib/types";

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

type EncashmentRow = {
  id: string;
  userId: string;
  leaveTypeId: string;
  year: number;
  days: number;
  status: string;
  payoutPeriod: string;
  amount: number;
  dailyRate: number;
  reason: string;
  createdById: string;
  decidedById: string | null;
  decidedAt: Date | null;
  decisionNote: string;
  paidRunId: string;
  paidAt: Date | null;
  createdAt: Date;
};

function serializeEncashment(
  row: EncashmentRow,
  userName: string,
  typeName: string,
  typeColor: string,
  decidedBy: string | null,
): LeaveEncashmentT {
  return {
    id: row.id,
    userId: row.userId,
    userName,
    leaveTypeId: row.leaveTypeId,
    typeName,
    typeColor,
    year: row.year,
    days: row.days,
    status: (["PENDING", "APPROVED", "REJECTED", "PAID"].includes(row.status) ? row.status : "PENDING") as
      | "PENDING"
      | "APPROVED"
      | "REJECTED"
      | "PAID",
    payoutPeriod: row.payoutPeriod,
    amount: row.amount,
    dailyRate: row.dailyRate,
    reason: row.reason,
    decidedBy,
    decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
    decisionNote: row.decisionNote,
    paidRunPeriod: row.paidRunId || null,
    createdAt: row.createdAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Request (member-facing)
// ---------------------------------------------------------------------------

export async function requestLeaveEncashment(input: unknown): Promise<ActionResult<{ id: string }>> {
  return toResult(async () => {
    const auth = await requirePermission("leave:request");
    const data = parseOrThrow(requestLeaveEncashmentSchema, input);

    const type = await db.leaveType.findUnique({
      where: { id: data.leaveTypeId },
      include: { policy: true },
    });
    if (!type || !type.active) throw new AuthorizationError("Leave type not found.");
    const policy = resolveLeavePolicy(type.policy);

    // The request validates against the LEDGER projection (the same
    // aggregate the approval will re-read inside its transaction).
    const year = todayUTC().getUTCFullYear();
    const projection = await ledgerProjectionFor(db, auth.userId, type.id, year);
    const plan = planLeaveEncashment(policy, data.days, projection.available);
    if (!plan.ok) throw new AuthorizationError(plan.reason);

    // The payout period must still be payable: a LOCKED run never takes
    // new money (createPayAdjustment refuses the same thing).
    const targetRun = await db.payrollRun.findUnique({
      where: { period: data.payoutPeriod },
      select: { status: true },
    });
    if (targetRun?.status === "LOCKED") {
      throw new AuthorizationError(`The ${data.payoutPeriod} run is already locked — pick a later payout period.`);
    }

    const row = await db.leaveEncashment.create({
      data: {
        userId: auth.userId,
        leaveTypeId: type.id,
        year,
        days: plan.days,
        status: "PENDING",
        payoutPeriod: data.payoutPeriod,
        reason: data.reason,
        createdById: auth.userId,
      },
    });

    // Notify the approver chain (best-effort, same as leave requests).
    try {
      const approverIds = await getApproverIdsFor(auth.userId);
      for (const approverId of approverIds) {
        if (approverId === auth.userId) continue;
        await db.notification.create({
          data: {
            recipientUserId: approverId,
            type: "INFO",
            title: "Leave encashment requested",
            message: `${auth.name} requested ${plan.days} day(s) of ${type.name} encashment (payout ${data.payoutPeriod}).`,
          },
        });
      }
    } catch {
      // Never break the request on a notification failure.
    }

    await logAudit({
      actor: auth,
      action: "leave.encashment_requested",
      entityType: "LEAVE_ENCASHMENT",
      entityId: row.id,
      entityLabel: `${type.name} ${plan.days}d`,
      detail: `${auth.name} requested ${plan.days} day(s) of ${type.name} encashment — payout period ${data.payoutPeriod}.`,
    });
    revalidatePath("/");
    return { id: row.id };
  });
}

// ---------------------------------------------------------------------------
// Decision (the leave-approver chain — same decider as time-off)
// ---------------------------------------------------------------------------

export async function decideLeaveEncashment(input: unknown): Promise<ActionResult<{ ok: true }>> {
  return toResult(async () => {
    const auth = await requirePermission("hr:view");
    const data = parseOrThrow(decideLeaveEncashmentSchema, input);

    const request = await db.leaveEncashment.findUnique({ where: { id: data.encashmentId } });
    if (!request) throw new AuthorizationError("Encashment request not found.");
    if (request.status !== "PENDING") {
      throw new AuthorizationError(`This encashment request is already ${request.status.toLowerCase()}.`);
    }
    await assertLeaveDecider(auth, request.userId);

    const type = await db.leaveType.findUnique({
      where: { id: request.leaveTypeId },
      include: { policy: true },
    });
    const policy = resolveLeavePolicy(type?.policy);
    const requester = await db.user.findUnique({ where: { id: request.userId }, select: { name: true } });

    if (data.decision === "REJECT") {
      // QA-16 discipline: the guarded flip — a concurrent decide cannot be
      // overwritten by this one.
      const flipped = await db.leaveEncashment.updateMany({
        where: { id: request.id, status: "PENDING" },
        data: {
          status: "REJECTED",
          decidedById: auth.userId,
          decidedAt: new Date(),
          decisionNote: data.note ?? "",
        },
      });
      if (flipped.count === 0) {
        throw new AuthorizationError(
          "This request is no longer pending — it was just decided elsewhere. Refresh and try again.",
        );
      }
      await logAudit({
        actor: auth,
        action: "leave.encashment_rejected",
        entityType: "LEAVE_ENCASHMENT",
        entityId: request.id,
        entityLabel: `${type?.name ?? "Leave"} ${request.days}d`,
        detail: `${auth.name} rejected ${requester?.name ?? "a member"}'s ${request.days}-day ${type?.name ?? "leave"} encashment request${data.note ? ` — ${data.note}` : ""}.`,
      });
      revalidatePath("/");
      return { ok: true };
    }

    // ---- APPROVE ---------------------------------------------------------
    // The payout period must STILL be payable (it may have locked since the
    // request was submitted).
    const targetRun = await db.payrollRun.findUnique({
      where: { period: request.payoutPeriod },
      select: { status: true },
    });
    if (targetRun?.status === "LOCKED") {
      throw new AuthorizationError(
        `The ${request.payoutPeriod} run locked since this request was submitted — ask the member to re-request for a later period.`,
      );
    }

    // The rate basis: the employee's ACTIVE structure's monthly gross ÷ the
    // payout period's holiday-aware working days (F2.1 basis).
    const structure = await db.salaryStructure.findFirst({
      where: { userId: request.userId, isActive: true },
    });
    if (!structure) {
      throw new AuthorizationError(
        "No active salary structure for this employee — the encashment rate cannot be computed.",
      );
    }
    const annualGross = computeOffer(parseComponents(structure.components)).earnings;
    const monthlyGross = round2(annualGross / 12);
    const [py, pm] = request.payoutPeriod.split("-").map(Number);
    const periodHolidays = await getHolidayLookup(
      new Date(Date.UTC(py, pm - 1, 1)),
      new Date(Date.UTC(py, pm, 0)),
    );
    const periodWorkingDays = workingDaysInPeriod(request.payoutPeriod, periodHolidays);
    const dailyRate = encashmentDailyRate(monthlyGross, periodWorkingDays);
    const amount = encashmentAmount(request.days, dailyRate);
    if (amount <= 0) {
      throw new AuthorizationError(
        "The computed encashment amount is zero — check the salary structure or the payout period's working days.",
      );
    }

    await db.$transaction(async (tx) => {
      // QA-16: the guarded flip — whoever wins the race owns the decision.
      const flipped = await tx.leaveEncashment.updateMany({
        where: { id: request.id, status: "PENDING" },
        data: {
          status: "APPROVED",
          amount,
          dailyRate,
          decidedById: auth.userId,
          decidedAt: new Date(),
          decisionNote: data.note ?? "",
        },
      });
      if (flipped.count === 0) {
        throw new AuthorizationError(
          "This request is no longer pending — it was just decided elsewhere. Refresh and try again.",
        );
      }

      // Materialize the balance row when missing (fail-closed, same as the
      // leave-approval path — an encashment against a never-materialized
      // year gets its GRANT explanation or a loud refusal).
      await materializeLeaveBalanceTx(tx, request.userId, request.leaveTypeId, request.year);

      // QA-1: re-validate against the LIVE ledger projection inside the
      // transaction — the request's submission-time check may be stale.
      const projection = await ledgerProjectionFor(tx, request.userId, request.leaveTypeId, request.year);
      const plan = planLeaveEncashment(policy, request.days, projection.available);
      if (!plan.ok) {
        throw new AuthorizationError(plan.reason);
      }

      // The consumption row — append-only (F1.2). One row per approval,
      // double-book-proof via the guarded status flip above.
      await tx.leaveLedgerEntry.create({
        data: {
          userId: request.userId,
          leaveTypeId: request.leaveTypeId,
          year: request.year,
          delta: -request.days,
          entryType: "CONSUME",
          sourceType: "LEAVE_ENCASHMENT",
          sourceId: request.id,
          note: `${type?.name ?? "Leave"} encashment (${request.days} d → ${request.payoutPeriod})`,
          isReversal: false,
        },
      });
      // Cache sync — absolute set from the projection (heals drift).
      await tx.leaveBalance.update({
        where: { userId_leaveTypeId_year: { userId: request.userId, leaveTypeId: request.leaveTypeId, year: request.year } },
        data: { used: projection.used + request.days },
      });

      // The money: the P1 adapter row, landing on the payout period's run
      // (at its creation, or via the explicit Apply action when the run
      // already exists). Same transaction — days consumed and money queued
      // commit together or not at all.
      await tx.payAdjustment.create({
        data: {
          userId: request.userId,
          sourceType: "ENCASHMENT",
          sourceId: request.id,
          componentCode: "",
          label: `Leave encashment — ${type?.name ?? "Leave"} (${request.days}d)`,
          side: "EARNING",
          recurrence: "ONE_SHOT",
          calcMode: "FIXED",
          amount,
          period: request.payoutPeriod,
          note: `${request.days} day(s) × $${dailyRate.toLocaleString("en-NZ")} (daily rate)`,
          createdById: auth.userId,
        },
      });
    });

    // Notify the requester (best-effort).
    try {
      await db.notification.create({
        data: {
          recipientUserId: request.userId,
          type: "SUCCESS",
          title: "Leave encashment approved",
          message: `Your ${request.days}-day ${type?.name ?? "leave"} encashment was approved — $${amount.toLocaleString("en-NZ")} lands on the ${request.payoutPeriod} run.`,
        },
      });
    } catch {
      // Never break the decision on a notification failure.
    }

    await logAudit({
      actor: auth,
      action: "leave.encashment_approved",
      entityType: "LEAVE_ENCASHMENT",
      entityId: request.id,
      entityLabel: `${type?.name ?? "Leave"} ${request.days}d`,
      detail: `${auth.name} approved ${requester?.name ?? "a member"}'s ${request.days}-day ${type?.name ?? "leave"} encashment — $${amount.toLocaleString("en-NZ")} ($${dailyRate.toLocaleString("en-NZ")}/day) on the ${request.payoutPeriod} run${data.note ? ` — ${data.note}` : ""}.`,
    });
    revalidatePath("/");
    return { ok: true };
  });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** The member's own encashment rows (Leave view). leave:request. */
export async function getMyEncashments(): Promise<ActionResult<LeaveEncashmentT[]>> {
  return toResult(async () => {
    const auth = await requirePermission("leave:request");
    const rows = await db.leaveEncashment.findMany({
      where: { userId: auth.userId },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    if (rows.length === 0) return [];
    const types = await db.leaveType.findMany({ select: { id: true, name: true, color: true } });
    const typeById = new Map(types.map((t) => [t.id, t]));
    return rows.map((r) =>
      serializeEncashment(
        r,
        auth.name,
        typeById.get(r.leaveTypeId)?.name ?? "Leave",
        typeById.get(r.leaveTypeId)?.color ?? "#8b5cf6",
        null,
      ),
    );
  });
}

/** The decision queue (HR console) — PENDING rows for people the current
 * user may decide for, mirroring getLeaveQueue's scoping. hr:view. */
export async function getEncashmentQueue(): Promise<
  ActionResult<{ requests: LeaveEncashmentT[]; canAdmin: boolean }>
> {
  return toResult(async () => {
    const auth = await requirePermission("hr:view");
    const canAdmin = hasPermission(auth.role, "hr:admin");

    let visibleUserIds: string[] | null = null;
    if (auth.role === "MANAGER") {
      const { getSubtreeUserIds } = await import("@/lib/auth/hierarchy");
      visibleUserIds = [...(await getSubtreeUserIds(auth.userId))];
    }

    const rows = await db.leaveEncashment.findMany({
      where: { status: "PENDING", ...(visibleUserIds ? { userId: { in: visibleUserIds } } : {}) },
      orderBy: { createdAt: "asc" },
      take: 200,
    });
    if (rows.length === 0) return { requests: [], canAdmin };

    const types = await db.leaveType.findMany({ select: { id: true, name: true, color: true } });
    const typeById = new Map(types.map((t) => [t.id, t]));
    const userIds = [...new Set(rows.map((r) => r.userId))];
    const people = await db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } });
    const names = new Map(people.map((p) => [p.id, p.name]));
    return {
      requests: rows.map((r) =>
        serializeEncashment(
          r,
          names.get(r.userId) ?? "(former user)",
          typeById.get(r.leaveTypeId)?.name ?? "Leave",
          typeById.get(r.leaveTypeId)?.color ?? "#8b5cf6",
          null,
        ),
      ),
      canAdmin,
    };
  });
}
