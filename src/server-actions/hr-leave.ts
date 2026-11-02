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
import type { LeaveStatus, LeaveRequestT, LeaveTypeT, LeaveBalanceT } from "@/lib/types";
import {
  createLeaveRequestSchema,
  decideLeaveRequestSchema,
  cancelLeaveRequestSchema,
  leaveTypeSchema,
  updateLeaveTypeSchema,
  parseOrThrow,
} from "@/lib/validation";
import { logAudit } from "./shared";
import { toResult, isUniqueConstraintError } from "./result";
import type { ActionResult } from "@/lib/action-result";
import {
  parseDay,
  workingDays,
  daysBetween,
  todayUTC,
  getApproverIdsFor,
  assertLeaveDecider,
  getOrCreateBalance,
  getOrCreateBalancesBatch,
  findOverlappingActiveRequest,
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
  }>
> {
  return toResult(async () => {
    const auth = await requirePermission("leave:request");
    const year = todayUTC().getUTCFullYear();

    const [types, requests] = await Promise.all([
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
    ]);

    // PR-19 — balances for every active type in ONE batched read (+ a rare
    // lazy materialize write for missing rows). The previous per-type loop
    // ran 3 queries per leave type — a genuine N+1 with a write on the read
    // path — on every Leave-view load.
    const balancesByType = await getOrCreateBalancesBatch(
      auth.userId,
      types.map((t) => ({ id: t.id, entitled: t.policy?.annualDays ?? 0 })),
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
        policy: t.policy
          ? {
              annualDays: t.policy.annualDays,
              maxCarryOver: t.policy.maxCarryOver,
              minNoticeDays: t.policy.minNoticeDays,
              maxConsecutiveDays: t.policy.maxConsecutiveDays,
            }
          : null,
      })),
      year,
      canManage: hasPermission(auth.role as never, "hr:view"),
    };
  });
}

// ---------------------------------------------------------------------------
// Read — HR console queue (hr:view). MANAGER sees their subtree's requests;
// ADMIN/HR see the whole workspace.
// ---------------------------------------------------------------------------

export async function getLeaveQueue(): Promise<
  ActionResult<{ requests: LeaveRequestT[]; canAdmin: boolean; types: LeaveTypeT[] }>
> {
  return toResult(async () => {
    const auth = await requirePermission("hr:view");
    const canAdmin = hasPermission(auth.role as never, "hr:admin");

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
      types: types.map((t) => ({
        id: t.id,
        name: t.name,
        code: t.code,
        requiresDoc: t.requiresDoc,
        paid: t.paid,
        color: t.color,
        active: t.active,
        policy: t.policy
          ? {
              annualDays: t.policy.annualDays,
              maxCarryOver: t.policy.maxCarryOver,
              minNoticeDays: t.policy.minNoticeDays,
              maxConsecutiveDays: t.policy.maxConsecutiveDays,
            }
          : null,
      })),
    };
  });
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

    const start = parseDay(data.startDate);
    const end = parseDay(data.endDate);
    if (daysBetween(start, end) < 0) {
      throw new AuthorizationError("The end date must be on or after the start date.");
    }
    const days = workingDays(start, end);
    if (days <= 0) {
      throw new AuthorizationError("That range contains no working days (Mon–Fri).");
    }

    // Policy guard rails — each check rejects with a specific message so the
    // UI can tell the member exactly which rail they hit.
    const policy = type.policy;
    if (policy) {
      const notice = daysBetween(todayUTC(), start);
      if (notice < policy.minNoticeDays) {
        throw new AuthorizationError(
          `${type.name} requires at least ${policy.minNoticeDays} day(s) of notice — start date is too soon.`,
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

    // Balance — insufficient balance rejects at submission (scoping decision).
    const year = start.getUTCFullYear();
    const balance = await getOrCreateBalance(auth.userId, type.id, year, policy?.annualDays ?? 0);
    const available = balance.entitled + balance.carriedOver - balance.used;
    if (days > available) {
      throw new AuthorizationError(
        `Insufficient balance: ${days} day(s) requested, ${available} available for ${type.name}.`,
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
    const type = await db.leaveType.findUnique({ where: { id: request.leaveTypeId }, select: { name: true } });
    const requester = await db.user.findUnique({ where: { id: request.userId }, select: { name: true } });

    if (data.decision === "APPROVE") {
      // `used` only ever changes here and in cancel — transactionally, and
      // always by exactly the request's `days`.
      //
      // QA-1 (overdraft guard): the balance is re-validated at approval
      // time, INSIDE the transaction. At submission each of two
      // non-overlapping requests can individually pass the check, so the
      // second approval must refuse (not blindly debit) once the first one
      // has consumed the remaining days. QA-1b: the debit is an atomic
      // `{ increment }` — the old read-then-write computed `used` outside the
      // transaction and could lose a concurrent update.
      //
      // QA-16: the PENDING precheck above runs BEFORE this write. Two tabs
      // (or two deciders) can both pass it; without a status guard in the
      // WHERE clause both "win" and the balance is debited TWICE (or an
      // approve/reject interleave leaves a REJECTED row with debited days).
      // The guarded updateMany flips the row atomically; a zero count means
      // someone else won the race — abort BEFORE any balance write, with a
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
        const row = await tx.leaveBalance.findUnique({
          where: { userId_leaveTypeId_year: { userId: request.userId, leaveTypeId: request.leaveTypeId, year } },
        });
        // The three numbers that decide the guard. When the row was never
        // materialized (e.g. entitled was 0 at submission and the policy was
        // raised since), create it from the policy default. If the create
        // loses a unique-trio race to a concurrent writer, re-read the
        // winner's row — never assume zero usage (fail closed).
        let entitled = row?.entitled;
        let carriedOver = row?.carriedOver;
        let used = row?.used;
        if (entitled === undefined || carriedOver === undefined || used === undefined) {
          const policy = await tx.leavePolicy.findUnique({ where: { leaveTypeId: request.leaveTypeId } });
          entitled = policy?.annualDays ?? 0;
          carriedOver = 0;
          used = 0;
          try {
            await tx.leaveBalance.create({
              data: { userId: request.userId, leaveTypeId: request.leaveTypeId, year, entitled, carriedOver, used },
            });
          } catch {
            const winner = await tx.leaveBalance.findUnique({
              where: { userId_leaveTypeId_year: { userId: request.userId, leaveTypeId: request.leaveTypeId, year } },
            });
            if (winner) {
              entitled = winner.entitled;
              carriedOver = winner.carriedOver;
              used = winner.used;
            }
          }
        }
        const available = entitled + carriedOver - used;
        if (request.days > available) {
          throw new AuthorizationError(
            `Insufficient balance: ${request.days} day(s) requested, only ${available} day(s) left for ${type?.name ?? "this leave type"}.`,
          );
        }
        await tx.leaveBalance.update({
          where: { userId_leaveTypeId_year: { userId: request.userId, leaveTypeId: request.leaveTypeId, year } },
          data: { used: { increment: request.days } },
        });
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
      // Give the days back — transactional with the status flip, and atomic
      // (QA-1b): decrement by at most what is actually used so a drifted
      // balance can never go below zero.
      // QA-16: the status precheck above ran BEFORE this write — two tabs
      // cancelling the same APPROVED request both passed it and the second
      // restore was a double refund. The guarded updateMany makes a stale
      // cancel a zero-row update that aborts BEFORE the decrement.
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
        const balance = await tx.leaveBalance.findUnique({
          where: { userId_leaveTypeId_year: { userId: request.userId, leaveTypeId: request.leaveTypeId, year } },
        });
        if (balance) {
          await tx.leaveBalance.update({
            where: { userId_leaveTypeId_year: { userId: request.userId, leaveTypeId: request.leaveTypeId, year } },
            data: { used: { decrement: Math.min(request.days, balance.used) } },
          });
        }
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
