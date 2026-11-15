"use server";

// ---------------------------------------------------------------------------
// G4 — the shift + roster server actions (lib/hr/shifts.ts owns the pure
// clock math). Shifts are EXPECTED hours — master data (the Shift CRUD)
// plus the roster (one slot per employee per day; the @@unique is the
// no-double-booking guard and assignShift surfaces its collision as a
// friendly error). Absence detection lives here too: a SCHEDULED slot
// whose day carries no attendance mark for that employee flips ABSENT on
// the explicit "mark absences" pass (§4 — the roster informs absence,
// never payroll directly).
//
// RBAC: everything attendance:manage (SUPER_ADMIN + ADMIN + HR — the F1.3
// audience; members see their own roster through their profile surface).
// ---------------------------------------------------------------------------

import { revalidatePath } from "next/cache";
import { db } from "@/lib/infra/db";
import { requirePermission, AuthorizationError } from "./auth-guard";
import {
  parseOrThrow,
  shiftSchema,
  updateShiftSchema,
  assignShiftSchema,
  assignmentRefSchema,
  assignmentStatusSchema,
  swapShiftSchema,
  rosterDaySchema,
  moveShiftSchema,
} from "@/lib/validation";
import { logAudit } from "./shared";
import { toResult, isUniqueConstraintError } from "./result";
import type { ActionResult } from "@/lib/shared/action-result";
import type { ShiftT, ShiftAssignmentT, RosterDayT } from "@/lib/types";
import {
  isValidShiftInput,
  shiftExpectedHours,
  shiftIsOvernight,
  absenceCandidates,
} from "@/lib/hr/shifts";
import { dayKey, parseDay } from "@/lib/hr/working-days";

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

function toShiftT(row: {
  id: string; name: string; startTime: string; endTime: string;
  isOvernight: boolean; breakMinutes: number; isActive: boolean;
}, assignmentCount = 0): ShiftT {
  return {
    id: row.id,
    name: row.name,
    startTime: row.startTime,
    endTime: row.endTime,
    isOvernight: row.isOvernight,
    breakMinutes: row.breakMinutes,
    isActive: row.isActive,
    expectedHours: shiftExpectedHours(row),
    assignmentCount,
  };
}

function toAssignmentT(row: {
  id: string; employeeId: string; shiftId: string; rosterDate: Date;
  status: string; note: string;
  employee?: { name: string } | null;
  shift?: { name: string } | null;
}): ShiftAssignmentT {
  return {
    id: row.id,
    employeeId: row.employeeId,
    employeeName: row.employee?.name ?? "",
    shiftId: row.shiftId,
    shiftName: row.shift?.name ?? "",
    rosterDate: dayKey(row.rosterDate),
    status: row.status,
    note: row.note,
  };
}

/** The shift catalog (attendance:manage) + each shift's live assignment
 * count (the "in use" guard behind deactivation). */
export async function getShifts(): Promise<ActionResult<ShiftT[]>> {
  return toResult(async () => {
    await requirePermission("attendance:manage");
    const [rows, counts] = await Promise.all([
      db.shift.findMany({ orderBy: { name: "asc" } }),
      db.shiftAssignment.groupBy({ by: ["shiftId"], _count: { _all: true } }),
    ]);
    const countById = new Map(counts.map((c) => [c.shiftId, c._count._all]));
    return rows.map((r) => toShiftT(r, countById.get(r.id) ?? 0));
  });
}

/** The roster window (attendance:manage): every assignment whose day
 * falls in [from, to], grouped per day (empty days included — the grid
 * renders the whole span). */
export async function getRoster(input: {
  from: string;
  to: string;
}): Promise<ActionResult<{ days: RosterDayT[] }>> {
  return toResult(async () => {
    await requirePermission("attendance:manage");
    const from = parseDay(input.from);
    const to = parseDay(input.to);
    if (from.getTime() > to.getTime()) {
      throw new AuthorizationError("The roster start must not be after its end.");
    }
    const rows = await db.shiftAssignment.findMany({
      where: { rosterDate: { gte: from, lte: to } },
      orderBy: [{ rosterDate: "asc" }, { employee: { name: "asc" } }],
      include: { employee: { select: { name: true } }, shift: { select: { name: true } } },
    });
    const byDay = new Map<string, ShiftAssignmentT[]>();
    for (const r of rows) {
      const k = dayKey(r.rosterDate);
      const list = byDay.get(k);
      if (list) list.push(toAssignmentT(r));
      else byDay.set(k, [toAssignmentT(r)]);
    }
    const days: RosterDayT[] = [];
    for (let t = from.getTime(); t <= to.getTime(); t += 86_400_000) {
      const k = dayKey(new Date(t));
      days.push({ day: k, assignments: byDay.get(k) ?? [] });
    }
    return { days };
  });
}

/** One roster day (attendance:manage): the day's assignments + the active
 * shift catalog + the rosterable employees (the assign menu's inputs). */
export async function getRosterDay(input: unknown): Promise<ActionResult<{
  day: string;
  assignments: ShiftAssignmentT[];
  shifts: ShiftT[];
  employees: Array<{ id: string; name: string }>;
}>> {
  return toResult(async () => {
    await requirePermission("attendance:manage");
    const { date } = parseOrThrow(rosterDaySchema, input);
    const [rows, shifts, employees] = await Promise.all([
      db.shiftAssignment.findMany({
        where: { rosterDate: parseDay(date) },
        orderBy: { employee: { name: "asc" } },
        include: { employee: { select: { name: true } }, shift: { select: { name: true } } },
      }),
      db.shift.findMany({ where: { isActive: true }, orderBy: { name: "asc" } }),
      db.user.findMany({
        where: { deletedAt: null },
        select: { id: true, name: true },
        orderBy: { name: "asc" },
        take: 500,
      }),
    ]);
    return {
      day: date,
      assignments: rows.map(toAssignmentT),
      shifts: shifts.map((s) => toShiftT(s)),
      employees,
    };
  });
}

// ---------------------------------------------------------------------------
// Shift master CRUD
// ---------------------------------------------------------------------------

export async function createShift(input: unknown): Promise<ActionResult<{ id: string }>> {
  return toResult(async () => {
    const auth = await requirePermission("attendance:manage");
    const data = parseOrThrow(shiftSchema, input);
    const err = isValidShiftInput(data);
    if (err) throw new AuthorizationError(err);
    // isOvernight is DERIVED (the honest clock math), never an author's
    // claim — the S2 derived-facts discipline.
    const isOvernight = shiftIsOvernight(data.startTime, data.endTime);
    try {
      const row = await db.shift.create({
        data: {
          name: data.name,
          startTime: data.startTime,
          endTime: data.endTime,
          isOvernight,
          breakMinutes: data.breakMinutes,
          isActive: data.isActive ?? true,
        },
      });
      await logAudit({
        actor: auth,
        action: "hr.shift_created",
        entityType: "SHIFT",
        entityId: row.id,
        entityLabel: row.name,
        detail: `${auth.name} created the ${row.name} shift (${row.startTime}–${row.endTime}${isOvernight ? ", overnight" : ""}, ${row.breakMinutes} min break, ${shiftExpectedHours(row) ?? "?"} h expected).`,
      });
      revalidatePath("/");
      return { id: row.id };
    } catch (e) {
      if (isUniqueConstraintError(e)) {
        throw new AuthorizationError(`A shift named "${data.name}" already exists.`);
      }
      throw e;
    }
  });
}

export async function updateShift(input: unknown): Promise<ActionResult<void>> {
  return toResult(async () => {
    const auth = await requirePermission("attendance:manage");
    const data = parseOrThrow(updateShiftSchema, input);
    const err = isValidShiftInput(data);
    if (err) throw new AuthorizationError(err);
    const existing = await db.shift.findUnique({ where: { id: data.shiftId } });
    if (!existing) throw new AuthorizationError("Shift not found.");
    const isOvernight = shiftIsOvernight(data.startTime, data.endTime);
    try {
      await db.shift.update({
        where: { id: data.shiftId },
        data: {
          name: data.name,
          startTime: data.startTime,
          endTime: data.endTime,
          isOvernight,
          breakMinutes: data.breakMinutes,
          isActive: data.isActive ?? true,
        },
      });
      await logAudit({
        actor: auth,
        action: "hr.shift_updated",
        entityType: "SHIFT",
        entityId: data.shiftId,
        entityLabel: data.name,
        detail: `${auth.name} updated the ${data.name} shift (${data.startTime}–${data.endTime}${isOvernight ? ", overnight" : ""}, ${data.breakMinutes} min break) — future roster slots pick up the new times; existing ones keep their recorded shift.`,
      });
      revalidatePath("/");
    } catch (e) {
      if (isUniqueConstraintError(e)) {
        throw new AuthorizationError(`A shift named "${data.name}" already exists.`);
      }
      throw e;
    }
  });
}

// ---------------------------------------------------------------------------
// Roster writers
// ---------------------------------------------------------------------------

/** Assign a shift to an employee on a day. The DB's
 * @@unique([employeeId, rosterDate]) is the no-double-booking guard; its
 * collision surfaces as the friendly "already rostered" error. */
export async function assignShift(input: unknown): Promise<ActionResult<{ id: string }>> {
  return toResult(async () => {
    const auth = await requirePermission("attendance:manage");
    const data = parseOrThrow(assignShiftSchema, input);
    const [employee, shift] = await Promise.all([
      db.user.findUnique({ where: { id: data.employeeId }, select: { id: true, name: true, deletedAt: true } }),
      db.shift.findUnique({ where: { id: data.shiftId } }),
    ]);
    if (!employee || employee.deletedAt) throw new AuthorizationError("Employee not found.");
    if (!shift || !shift.isActive) throw new AuthorizationError("Shift not found (or inactive).");
    try {
      const row = await db.shiftAssignment.create({
        data: {
          employeeId: data.employeeId,
          shiftId: data.shiftId,
          rosterDate: parseDay(data.rosterDate),
          note: data.note ?? "",
        },
      });
      await logAudit({
        actor: auth,
        action: "hr.roster_assigned",
        entityType: "SHIFT_ASSIGNMENT",
        entityId: row.id,
        entityLabel: `${employee.name} · ${data.rosterDate}`,
        detail: `${auth.name} rostered ${employee.name} on the ${shift.name} shift (${shift.startTime}–${shift.endTime}) for ${data.rosterDate}.`,
      });
      revalidatePath("/");
      return { id: row.id };
    } catch (e) {
      if (isUniqueConstraintError(e)) {
        throw new AuthorizationError(
          `${employee.name} is already rostered on ${data.rosterDate} — one shift per employee per day (cancel or swap the existing slot first).`,
        );
      }
      throw e;
    }
  });
}

/** Remove a roster slot (the cancel). */
export async function unassignShift(input: unknown): Promise<ActionResult<void>> {
  return toResult(async () => {
    const auth = await requirePermission("attendance:manage");
    const { assignmentId } = parseOrThrow(assignmentRefSchema, input);
    const existing = await db.shiftAssignment.findUnique({
      where: { id: assignmentId },
      include: { employee: { select: { name: true } }, shift: { select: { name: true } } },
    });
    if (!existing) throw new AuthorizationError("Roster slot not found.");
    await db.shiftAssignment.delete({ where: { id: assignmentId } });
    await logAudit({
      actor: auth,
      action: "hr.roster_unassigned",
      entityType: "SHIFT_ASSIGNMENT",
      entityId: assignmentId,
      entityLabel: `${existing.employee.name} · ${dayKey(existing.rosterDate)}`,
      detail: `${auth.name} removed ${existing.employee.name}'s ${existing.shift.name} slot on ${dayKey(existing.rosterDate)}.`,
    });
    revalidatePath("/");
  });
}

/** Flip a slot's status (COMPLETED / ABSENT / back to SCHEDULED — the
 * manual correction path; the bulk absence pass lives below). */
export async function setAssignmentStatus(input: unknown): Promise<ActionResult<void>> {
  return toResult(async () => {
    const auth = await requirePermission("attendance:manage");
    const data = parseOrThrow(assignmentStatusSchema, input);
    const existing = await db.shiftAssignment.findUnique({
      where: { id: data.assignmentId },
      include: { employee: { select: { name: true } }, shift: { select: { name: true } } },
    });
    if (!existing) throw new AuthorizationError("Roster slot not found.");
    const flipped = await db.shiftAssignment.updateMany({
      where: { id: data.assignmentId, status: { not: data.status } },
      data: { status: data.status, ...(data.note != null ? { note: data.note } : {}) },
    });
    if (flipped.count === 0) {
      throw new AuthorizationError("That slot already carries the requested status.");
    }
    await logAudit({
      actor: auth,
      action: "hr.roster_status_changed",
      entityType: "SHIFT_ASSIGNMENT",
      entityId: data.assignmentId,
      entityLabel: `${existing.employee.name} · ${dayKey(existing.rosterDate)}`,
      detail: `${auth.name} set ${existing.employee.name}'s ${existing.shift.name} slot on ${dayKey(existing.rosterDate)} to ${data.status}${data.note ? ` — ${data.note}` : ""}.`,
    });
    revalidatePath("/");
  });
}

/** Swap a slot to another employee: the original flips SWAPPED (kept for
 * the trace) and the target gains a fresh SCHEDULED slot on the same
 * day — one transaction, so a mid-swap failure leaves no half-move. */
export async function swapShift(input: unknown): Promise<ActionResult<{ id: string }>> {
  return toResult(async () => {
    const auth = await requirePermission("attendance:manage");
    const data = parseOrThrow(swapShiftSchema, input);
    const existing = await db.shiftAssignment.findUnique({
      where: { id: data.assignmentId },
      include: { employee: { select: { name: true } }, shift: { select: { name: true } } },
    });
    if (!existing) throw new AuthorizationError("Roster slot not found.");
    if (existing.employeeId === data.toEmployeeId) {
      throw new AuthorizationError("Pick a different employee to swap with.");
    }
    const target = await db.user.findUnique({
      where: { id: data.toEmployeeId },
      select: { id: true, name: true, deletedAt: true },
    });
    if (!target || target.deletedAt) throw new AuthorizationError("Swap target not found.");
    try {
      const created = await db.$transaction(async (tx) => {
        const flipped = await tx.shiftAssignment.updateMany({
          where: { id: data.assignmentId, status: "SCHEDULED" },
          data: { status: "SWAPPED", note: data.note ?? `Swapped with ${target.name}` },
        });
        if (flipped.count === 0) {
          throw new AuthorizationError("Only a SCHEDULED slot can be swapped.");
        }
        return tx.shiftAssignment.create({
          data: {
            employeeId: target.id,
            shiftId: existing.shiftId,
            rosterDate: existing.rosterDate,
            status: "SCHEDULED",
            note: data.note ?? `Swapped from ${existing.employee.name}`,
          },
        });
      });
      await logAudit({
        actor: auth,
        action: "hr.roster_swapped",
        entityType: "SHIFT_ASSIGNMENT",
        entityId: created.id,
        entityLabel: `${target.name} · ${dayKey(existing.rosterDate)}`,
        detail: `${auth.name} swapped ${existing.employee.name}'s ${existing.shift.name} slot on ${dayKey(existing.rosterDate)} to ${target.name}.`,
      });
      revalidatePath("/");
      return { id: created.id };
    } catch (e) {
      if (isUniqueConstraintError(e)) {
        throw new AuthorizationError(
          `${target.name} is already rostered on ${dayKey(existing.rosterDate)} — one shift per employee per day.`,
        );
      }
      throw e;
    }
  });
}

/** Move one roster slot to another day (the drag-drop grid's writer):
 * the same employee + shift on a new date — one guard, the target day's
 * unique constraint (the source day's row is UPDATEd, so it frees itself). */
export async function moveShift(input: unknown): Promise<ActionResult<void>> {
  return toResult(async () => {
    const auth = await requirePermission("attendance:manage");
    const data = parseOrThrow(moveShiftSchema, input);
    const existing = await db.shiftAssignment.findUnique({
      where: { id: data.assignmentId },
      include: { employee: { select: { name: true } }, shift: { select: { name: true } } },
    });
    if (!existing) throw new AuthorizationError("Roster slot not found.");
    if (dayKey(existing.rosterDate) === data.toRosterDate) {
      throw new AuthorizationError("That slot is already on that day.");
    }
    try {
      await db.shiftAssignment.update({
        where: { id: data.assignmentId },
        data: { rosterDate: parseDay(data.toRosterDate) },
      });
      await logAudit({
        actor: auth,
        action: "hr.roster_status_changed",
        entityType: "SHIFT_ASSIGNMENT",
        entityId: data.assignmentId,
        entityLabel: `${existing.employee.name} · ${data.toRosterDate}`,
        detail: `${auth.name} moved ${existing.employee.name}'s ${existing.shift.name} slot from ${dayKey(existing.rosterDate)} to ${data.toRosterDate}.`,
      });
      revalidatePath("/");
    } catch (e) {
      if (isUniqueConstraintError(e)) {
        throw new AuthorizationError(
          `${existing.employee.name} is already rostered on ${data.toRosterDate} — one shift per employee per day.`,
        );
      }
      throw e;
    }
  });
}

// ---------------------------------------------------------------------------
// Absence detection (§4 — assigned but no attendance = absent)
// ---------------------------------------------------------------------------
/** The explicit pass: every SCHEDULED slot on the day whose employee has
 * NO attendance record for that day flips ABSENT (the derived-statuses
 * discipline — the flip is recomputed only on demand, never a cron
 * surprise; SWAPPED/COMPLETED slots stay untouched). Returns the count. */
export async function markRosterAbsencesForDay(input: unknown): Promise<ActionResult<{ marked: number }>> {
  return toResult(async () => {
    const auth = await requirePermission("attendance:manage");
    const { date } = parseOrThrow(rosterDaySchema, input);
    const day = parseDay(date);
    const nextDay = new Date(day.getTime() + 86_400_000);
    const [slots, marks] = await Promise.all([
      db.shiftAssignment.findMany({ where: { rosterDate: day, status: "SCHEDULED" } }),
      db.attendanceRecord.findMany({
        where: { date: { gte: day, lt: nextDay } },
        select: { userId: true },
      }),
    ]);
    const marked = new Set(marks.map((m) => m.userId));
    const candidates = absenceCandidates(
      slots.map((s) => ({ id: s.id, employeeId: s.employeeId, rosterDay: date, status: s.status })),
      new Set([...marked].map((userId) => `${userId}|${date}`)),
    );
    if (candidates.length === 0) return { marked: 0 };
    let markedCount = 0;
    await db.$transaction(async (tx) => {
      for (const c of candidates) {
        const flipped = await tx.shiftAssignment.updateMany({
          where: { id: c.id, status: "SCHEDULED" },
          data: { status: "ABSENT", note: "Absent — no attendance mark on the rostered day" },
        });
        markedCount += flipped.count;
      }
    });
    await logAudit({
      actor: auth,
      action: "hr.roster_absences_marked",
      entityType: "SHIFT_ASSIGNMENT",
      entityId: date,
      entityLabel: date,
      detail: `${auth.name} ran absence detection for ${date}: ${markedCount} rostered slot(s) flipped ABSENT (assigned but unmarked)${candidates.length - markedCount > 0 ? `, ${candidates.length - markedCount} raced and were left alone` : ""}.`,
    });
    revalidatePath("/");
    return { marked: markedCount };
  });
}
