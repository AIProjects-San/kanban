"use server";

// ---------------------------------------------------------------------------
// G4 — the timesheet server actions (lib/hr/timesheets.ts owns the pure
// kernel: the status graph, the four-eyes rule, the hours math).
//
// The document lifecycle:
//   save      → DRAFT (owner self-service, session-identity scoped; or
//               attendance:manage on behalf) — full line replace, Σ hours
//               re-materialized in the same transaction
//   submit    → SUBMITTED (the owner, from DRAFT or REJECTED)
//   decide    → APPROVED | REJECTED (attendance:manage + four-eyes: the
//               approver is never the employee whose hours these are)
//   (effect)  → LOCKED — written only by the payroll lock that consumed
//               the sheet (the reviewed G4 hook; nothing here flips it)
//
// RBAC: self-service writes are session-identity scoped (the
// getMyPayslips precedent — a MEMBER may draft and submit their own
// hours, nothing else); every review read/write requires
// attendance:manage (SUPER_ADMIN + ADMIN + HR — the F1.3 audience).
// ---------------------------------------------------------------------------

import { revalidatePath } from "next/cache";
import { db } from "@/lib/infra/db";
import { requirePermission, getSessionOrThrow, AuthorizationError } from "./auth-guard";
import { parseOrThrow, saveTimesheetSchema, timesheetRefSchema, decideTimesheetSchema } from "@/lib/validation";
import { logAudit } from "./shared";
import { toResult } from "./result";
import type { ActionResult } from "@/lib/shared/action-result";
import type { TimesheetT, TimesheetDetailT, TimesheetLineT } from "@/lib/types";
import {
  canApproveTimesheet,
  isEditableTimesheet,
  overtimeHours,
  billableHours,
  sumLineHours,
  isValidTimesheetLine,
  canTransitionTimesheet,
} from "@/lib/hr/timesheets";
import { dayKey, parseDay } from "@/lib/hr/working-days";


// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

function toLineT(row: {
  id: string; workDate: Date; hours: number; projectId: string | null;
  taskId: string | null; description: string | null; isBillable: boolean; isOvertime: boolean;
}): TimesheetLineT {
  return {
    id: row.id,
    workDate: dayKey(row.workDate),
    hours: row.hours,
    projectId: row.projectId,
    taskId: row.taskId,
    description: row.description,
    isBillable: row.isBillable,
    isOvertime: row.isOvertime,
  };
}

function toTimesheetT(row: {
  id: string; employeeId: string; periodStart: Date; periodEnd: Date; status: string;
  totalHours: number; submittedAt: Date | null; approvedAt: Date | null; rejectReason: string;
  payrollRunId: string | null; createdAt: Date;
  employee?: { name: string } | null;
  lines?: Array<{ hours: number; isOvertime: boolean; isBillable: boolean }>;
}, approvedByName: string | null = null): TimesheetT {
  return {
    id: row.id,
    employeeId: row.employeeId,
    employeeName: row.employee?.name ?? "",
    periodStart: dayKey(row.periodStart),
    periodEnd: dayKey(row.periodEnd),
    status: row.status,
    totalHours: row.totalHours,
    overtimeHours: row.lines ? overtimeHours(row.lines) : 0,
    billableHours: row.lines ? billableHours(row.lines) : 0,
    submittedAt: row.submittedAt ? row.submittedAt.toISOString() : null,
    approvedByName,
    approvedAt: row.approvedAt ? row.approvedAt.toISOString() : null,
    rejectReason: row.rejectReason,
    payrollRunId: row.payrollRunId,
    createdAt: row.createdAt.toISOString(),
    lineCount: row.lines?.length ?? 0,
  };
}

/** The employee's own timesheets (self-service list — session identity,
 * no permission: a MEMBER's own hours are theirs to draft). */
export async function getMyTimesheets(): Promise<ActionResult<TimesheetT[]>> {
  return toResult(async () => {
    const auth = await getSessionOrThrow();
    const rows = await db.timesheet.findMany({
      where: { employeeId: auth.userId },
      orderBy: [{ periodStart: "desc" }, { createdAt: "desc" }],
      include: { employee: { select: { name: true } }, lines: true },
      take: 100,
    });
    return rows.map((r) => toTimesheetT(r));
  });
}

/** One timesheet with its lines + the viewer's standing. Owner sees their
 * own (any status); anyone else needs attendance:manage. */
export async function getTimesheetDetail(input: unknown): Promise<ActionResult<TimesheetDetailT>> {
  return toResult(async () => {
    const auth = await getSessionOrThrow();
    const { timesheetId } = parseOrThrow(timesheetRefSchema, input);
    const row = await db.timesheet.findUnique({
      where: { id: timesheetId },
      include: {
        employee: { select: { name: true } },
        lines: { orderBy: { workDate: "asc" } },
      },
    });
    if (!row) throw new AuthorizationError("Timesheet not found.");
    // Timesheet carries no approver relation (bare approvedById) — the
    // name joins in memory, same as the loans' approver read.
    const approver = row.approvedById
      ? await db.user.findUnique({ where: { id: row.approvedById }, select: { name: true } })
      : null;
    const isOwner = row.employeeId === auth.userId;
    let canManage = false;
    if (!isOwner) {
      try {
        await requirePermission("attendance:manage");
        canManage = true;
      } catch {
        canManage = false;
      }
    }
    if (!isOwner && !canManage) {
      throw new AuthorizationError("You may only view your own timesheets.");
    }
    const base = toTimesheetT(row, approver?.name ?? null);
    return {
      ...base,
      lines: row.lines.map(toLineT),
      viewer: {
        isOwner,
        canEdit: (isOwner || canManage) && isEditableTimesheet(row.status),
        canSubmit: (isOwner || canManage) && (row.status === "DRAFT" || row.status === "REJECTED"),
        canDecide: canManage && row.status === "SUBMITTED" && canApproveTimesheet(row.employeeId, auth.userId),
      },
    };
  });
}

/** The HR review queue (attendance:manage): every timesheet, newest
 * first, filterable by status. */
export async function getTimesheetsForReview(input?: unknown): Promise<ActionResult<TimesheetT[]>> {
  return toResult(async () => {
    await requirePermission("attendance:manage");
    const statusFilter =
      input != null && typeof input === "object" && "status" in input && typeof (input as { status: unknown }).status === "string"
        ? (input as { status: string }).status
        : undefined;
    const rows = await db.timesheet.findMany({
      where: statusFilter ? { status: statusFilter } : undefined,
      orderBy: [{ periodStart: "desc" }, { createdAt: "desc" }],
      include: { employee: { select: { name: true } }, lines: true },
      take: 200,
    });
    return rows.map((r) => toTimesheetT(r));
  });
}

/** One employee's timesheets (the HR-side employee page). */
export async function getEmployeeTimesheets(employeeId: string): Promise<ActionResult<TimesheetT[]>> {
  return toResult(async () => {
    await requirePermission("attendance:manage");
    const rows = await db.timesheet.findMany({
      where: { employeeId },
      orderBy: [{ periodStart: "desc" }, { createdAt: "desc" }],
      include: { employee: { select: { name: true } }, lines: true },
      take: 100,
    });
    return rows.map((r) => toTimesheetT(r));
  });
}

// ---------------------------------------------------------------------------
// Writers
// ---------------------------------------------------------------------------

/** Create or replace a DRAFT/REJECTED timesheet's lines (the full-replace
 * discipline — the draft is one document, not a per-line patch surface).
 * Owner self-service or attendance:manage on behalf; the Σ hours
 * re-materializes in the same transaction. */
export async function saveTimesheet(input: unknown): Promise<ActionResult<{ id: string; totalHours: number }>> {
  return toResult(async () => {
    const auth = await getSessionOrThrow();
    const data = parseOrThrow(saveTimesheetSchema, input);
    const onBehalf = auth.userId !== data.employeeId;
    if (onBehalf) {
      // HR/admin drafting for someone else — the attendance audience.
      await requirePermission("attendance:manage");
    }
    const employee = await db.user.findUnique({
      where: { id: data.employeeId },
      select: { id: true, name: true, deletedAt: true },
    });
    if (!employee || employee.deletedAt) {
      throw new AuthorizationError("Employee not found.");
    }
    if (parseDay(data.periodStart).getTime() > parseDay(data.periodEnd).getTime()) {
      throw new AuthorizationError("The period start must not be after the period end.");
    }
    // Line-level guards (the kernel twin): hours sane, days inside the window.
    for (const line of data.lines) {
      const err = isValidTimesheetLine({
        hours: line.hours,
        workDay: line.workDate,
        periodStartDay: data.periodStart,
        periodEndDay: data.periodEnd,
      });
      if (err) throw new AuthorizationError(err);
    }
    const totalHours = sumLineHours(data.lines);

    // Find the employee's existing sheet for this exact window (one sheet
    // per window: re-saving a window rewrites its draft, never forks it).
    const existing = await db.timesheet.findFirst({
      where: { employeeId: data.employeeId, periodStart: parseDay(data.periodStart), periodEnd: parseDay(data.periodEnd) },
    });
    if (existing && !isEditableTimesheet(existing.status)) {
      throw new AuthorizationError(
        existing.status === "LOCKED"
          ? "That timesheet is locked — a payroll run already consumed it."
          : "That timesheet is awaiting review and cannot be edited. Reject it first to return it to draft.",
      );
    }

    const saved = await db.$transaction(async (tx) => {
      const sheet = existing
        ? await tx.timesheet.update({
            where: { id: existing.id },
            data: {
              totalHours,
              // A re-save after rejection returns it to DRAFT (the graph's
              // REJECTED → DRAFT edge, folded into the save).
              ...(existing.status === "REJECTED" ? { status: "DRAFT", rejectedById: null, rejectedAt: null, rejectReason: "" } : {}),
            },
          })
        : await tx.timesheet.create({
            data: {
              employeeId: data.employeeId,
              periodStart: parseDay(data.periodStart),
              periodEnd: parseDay(data.periodEnd),
              status: "DRAFT",
              totalHours,
              createdById: auth.userId,
            },
          });
      if (existing) {
        await tx.timesheetLine.deleteMany({ where: { timesheetId: sheet.id } });
      }
      for (const line of data.lines) {
        await tx.timesheetLine.create({
          data: {
            timesheetId: sheet.id,
            workDate: parseDay(line.workDate),
            hours: line.hours,
            projectId: line.projectId ?? null,
            taskId: line.taskId ?? null,
            description: line.description ?? null,
            isBillable: line.isBillable ?? false,
            isOvertime: line.isOvertime ?? false,
          },
        });
      }
      return sheet;
    });

    await logAudit({
      actor: auth,
      action: existing ? "hr.timesheet_updated" : "hr.timesheet_created",
      entityType: "TIMESHEET",
      entityId: saved.id,
      entityLabel: `${employee.name} · ${data.periodStart} → ${data.periodEnd}`,
      detail: `${auth.name} ${existing ? "updated" : "drafted"} ${employee.name}'s timesheet for ${data.periodStart} → ${data.periodEnd} — ${data.lines.length} line(s), ${totalHours} h.`,
    });
    revalidatePath("/");
    return { id: saved.id, totalHours };
  });
}

/** DRAFT/REJECTED → SUBMITTED (the guarded flip — status in the WHERE
 * clause, the QA-16 discipline). Owner or attendance:manage. */
export async function submitTimesheet(input: unknown): Promise<ActionResult<void>> {
  return toResult(async () => {
    const auth = await getSessionOrThrow();
    const { timesheetId } = parseOrThrow(timesheetRefSchema, input);
    const sheet = await db.timesheet.findUnique({
      where: { id: timesheetId },
      include: { employee: { select: { name: true } } },
    });
    if (!sheet) throw new AuthorizationError("Timesheet not found.");
    if (sheet.employeeId !== auth.userId) {
      await requirePermission("attendance:manage");
    }
    if (!canTransitionTimesheet(sheet.status, "SUBMITTED")) {
      throw new AuthorizationError(
        sheet.status === "SUBMITTED"
          ? "That timesheet is already awaiting review."
          : sheet.status === "LOCKED"
            ? "That timesheet is locked — a payroll run already consumed it."
            : "Only a draft (or rejected) timesheet can be submitted.",
      );
    }
    if (sheet.totalHours <= 0) {
      throw new AuthorizationError("Add at least one line before submitting.");
    }
    const flipped = await db.timesheet.updateMany({
      where: { id: timesheetId, status: sheet.status },
      data: { status: "SUBMITTED", submittedAt: new Date() },
    });
    if (flipped.count === 0) {
      throw new AuthorizationError("That timesheet is no longer in its recorded state — refresh and try again.");
    }
    await logAudit({
      actor: auth,
      action: "hr.timesheet_submitted",
      entityType: "TIMESHEET",
      entityId: timesheetId,
      entityLabel: `${sheet.employee.name} · ${dayKey(sheet.periodStart)} → ${dayKey(sheet.periodEnd)}`,
      detail: `${auth.name} submitted ${sheet.employee.name}'s timesheet (${sheet.totalHours} h) for review.`,
    });
    revalidatePath("/");
  });
}

/** SUBMITTED → APPROVED | REJECTED (attendance:manage + four-eyes: the
 * approver is never the employee; REJECTED carries the reason and returns
 * the sheet to its author). Guarded flips both ways. */
export async function decideTimesheet(input: unknown): Promise<ActionResult<void>> {
  return toResult(async () => {
    const auth = await requirePermission("attendance:manage");
    const data = parseOrThrow(decideTimesheetSchema, input);
    const sheet = await db.timesheet.findUnique({
      where: { id: data.timesheetId },
      include: { employee: { select: { name: true } } },
    });
    if (!sheet) throw new AuthorizationError("Timesheet not found.");
    if (sheet.status !== "SUBMITTED") {
      throw new AuthorizationError("Only a submitted timesheet can be decided.");
    }
    if (!canApproveTimesheet(sheet.employeeId, auth.userId)) {
      throw new AuthorizationError("Four-eyes rule: you cannot review your own timesheet.");
    }
    if (data.decision === "REJECT" && !(data.reason ?? "").trim()) {
      throw new AuthorizationError("A rejection needs a reason for the author.");
    }
    const label = `${sheet.employee.name} · ${dayKey(sheet.periodStart)} → ${dayKey(sheet.periodEnd)}`;
    if (data.decision === "APPROVE") {
      const flipped = await db.timesheet.updateMany({
        where: { id: data.timesheetId, status: "SUBMITTED" },
        data: { status: "APPROVED", approvedById: auth.userId, approvedAt: new Date() },
      });
      if (flipped.count === 0) {
        throw new AuthorizationError("That timesheet is no longer submitted — refresh and try again.");
      }
      await logAudit({
        actor: auth,
        action: "hr.timesheet_approved",
        entityType: "TIMESHEET",
        entityId: data.timesheetId,
        entityLabel: label,
        detail: `${auth.name} approved ${sheet.employee.name}'s timesheet (${sheet.totalHours} h) — the hours are now payroll-consumable.`,
      });
    } else {
      const flipped = await db.timesheet.updateMany({
        where: { id: data.timesheetId, status: "SUBMITTED" },
        data: {
          status: "REJECTED",
          rejectedById: auth.userId,
          rejectedAt: new Date(),
          rejectReason: (data.reason ?? "").trim(),
        },
      });
      if (flipped.count === 0) {
        throw new AuthorizationError("That timesheet is no longer submitted — refresh and try again.");
      }
      await logAudit({
        actor: auth,
        action: "hr.timesheet_rejected",
        entityType: "TIMESHEET",
        entityId: data.timesheetId,
        entityLabel: label,
        detail: `${auth.name} rejected ${sheet.employee.name}'s timesheet — ${(data.reason ?? "").trim()}`,
      });
    }
    revalidatePath("/");
  });
}
