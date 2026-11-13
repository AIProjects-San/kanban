"use server";

// ---------------------------------------------------------------------------
// F1.3 — attendance records server actions
// (docs/Fernly_HR_Payroll_Enhancement_Plan.md §7.1).
//
// RBAC: marking/upsert/delete and the HR month grid are `attendance:manage`
// (ADMIN + HR — a NEW permission, deliberately not hr:admin, so the DB
// permission ceiling can diverge the two). getMyAttendance is the
// self-scoped read: the CURRENT user's own month, resolved from the session
// with no member inputs (the getMyPayslips convention). Members never write
// attendance — decision §9.1: no self-marking, WFH is a status HR sets.
//
// ON_LEAVE rows are derived server-side from approved leave
// (hr-leave.ts decideLeaveRequest → deriveOnLeaveAttendance) and removed
// again on cancel — the form schema rejects the status outright.
//
// Upsert semantics mirror the F1.1 holiday calendar: `id` present → update
// (the date may move); absent → create. A (userId, date) pair already taken
// by ANOTHER record rejects with a message naming the person and date
// (QA-18 convention). One record per person per day.
// ---------------------------------------------------------------------------

import { revalidatePath } from "next/cache";
import { db } from "@/lib/infra/db";
import { requirePermission, getSessionOrThrow, AuthorizationError } from "./auth-guard";
import type { AttendanceT, AttendanceMonthT, AttendanceStatus, AttendanceSource } from "@/lib/types";
import type { ActionResult } from "@/lib/shared/action-result";
import { attendanceRecordSchema, deleteAttendanceRecordSchema, parseOrThrow } from "@/lib/validation";
import { logAudit } from "./shared";
import { toResult, isUniqueConstraintError } from "./result";
import { parseDay } from "./hr-shared";
import { deriveAttendanceTiming, type AttendanceTimingFacts } from "@/lib/hr/attendance-flags";
import { getWorkspaceConfig } from "@/lib/infra/config-loader";
import { nonWorkingDayReason } from "@/lib/hr/working-days";
import { monthlyAttendanceSheetCsv } from "@/lib/hr/attendance-sheet";

/** Clamp/normalize a (year, month) pair; invalid input falls back to the
 * current UTC month (getHolidayCalendar's year convention). */
function normalizeMonth(
  yearInput: number | undefined,
  monthInput: number | undefined,
): { year: number; month: number } {
  const now = new Date();
  const y = Number(yearInput);
  const m = Number(monthInput);
  return {
    year: Number.isInteger(y) && y >= 2000 && y <= 2100 ? y : now.getUTCFullYear(),
    month: Number.isInteger(m) && m >= 1 && m <= 12 ? m : now.getUTCMonth() + 1,
  };
}

function monthBounds(year: number, month: number): { start: Date; end: Date } {
  return {
    start: new Date(Date.UTC(year, month - 1, 1)),
    end: new Date(Date.UTC(year, month, 0)),
  };
}

/** Serialize one row for the client (dates → "yyyy-mm-dd"). */
function serializeAttendance(
  r: {
    id: string;
    userId: string;
    date: Date;
    status: string;
    inTime: string | null;
    outTime: string | null;
    lateMinutes: number | null;
    earlyMinutes: number | null;
    workingHours: number | null;
    overtimeMinutes: number | null;
    note: string;
    source: string;
  },
  userName: string,
): AttendanceT {
  return {
    id: r.id,
    userId: r.userId,
    userName,
    date: r.date.toISOString().slice(0, 10),
    status: r.status as AttendanceStatus,
    inTime: r.inTime,
    outTime: r.outTime,
    // AT-B02/B03 (S2) — the derived timing facts ride along; the client
    // renders badges/tooltips from them (never re-derives).
    lateMinutes: r.lateMinutes ?? null,
    earlyMinutes: r.earlyMinutes ?? null,
    workingHours: r.workingHours ?? null,
    // P9 (PR-B26) — the derived overtime fact (the payroll bridge's input).
    overtimeMinutes: r.overtimeMinutes ?? null,
    note: r.note,
    source: r.source as AttendanceSource,
  };
}

/** The HR console Attendance tab payload: roster + everyone's records for
 * one month + the month's holiday entries (the grid shades non-working
 * columns). PR-21 hard caps on both roster reads (a 500+ workspace is a
 * paginated-list concern, not a single-grid concern). */
export async function getAttendanceMonth(
  yearInput?: number,
  monthInput?: number,
): Promise<ActionResult<AttendanceMonthT>> {
  return toResult(async () => {
    await requirePermission("attendance:manage");
    const { year, month } = normalizeMonth(yearInput, monthInput);
    const { start, end } = monthBounds(year, month);

    const [users, records, holidays] = await Promise.all([
      db.user.findMany({
        where: { deletedAt: null },
        select: { id: true, name: true },
        orderBy: { name: "asc" },
        take: 500,
      }),
      db.attendanceRecord.findMany({
        where: { date: { gte: start, lte: end } },
        orderBy: { date: "asc" },
      }),
      db.holidayCalendarEntry.findMany({
        where: { date: { gte: start, lte: end } },
        select: { date: true, label: true },
        orderBy: { date: "asc" },
      }),
    ]);
    const names = new Map(users.map((u) => [u.id, u.name]));

    // AT-B02/B03 (S2) — the reference day rides on the month payload so the
    // grid/marking modal can explain what "late" means here.
    const config = await getWorkspaceConfig();

    return {
      year,
      month,
      members: users.map((u) => ({ userId: u.id, userName: u.name })),
      records: records.map((r) => serializeAttendance(r, names.get(r.userId) ?? "(former user)")),
      holidays: holidays.map((h) => ({ date: h.date.toISOString().slice(0, 10), label: h.label })),
      dayStart: config.workspace.attendanceDayStart,
      dayEnd: config.workspace.attendanceDayEnd,
    };
  });
}

/** Create or update one record. `id` present → update (the date may move);
 * absent → create. Editing a DERIVED row converts it to MANUAL — an explicit
 * HR decision always outranks the derivation. */
export async function upsertAttendanceRecord(input: {
  id?: string;
  userId: string;
  date: string;
  status: "PRESENT" | "ABSENT" | "HALF_DAY" | "WFH";
  inTime?: string | null;
  outTime?: string | null;
  note?: string;
}): Promise<ActionResult<{ id: string }>> {
  return toResult(async () => {
    const auth = await requirePermission("attendance:manage");
    const data = parseOrThrow(attendanceRecordSchema, input);

    const target = await db.user.findUnique({
      where: { id: data.userId },
      select: { id: true, name: true, deletedAt: true },
    });
    if (!target || target.deletedAt) throw new AuthorizationError("Member not found.");

    const date = parseDay(data.date);
    // F-R15 (S3) — the server-side half of the grid-shading honesty: marks
    // on non-working days are REJECTED (weekends + full holidays; half-day
    // holidays stay markable — they are working half-days). The pure rule
    // lives in lib/hr/working-days.ts; this is the friendly-error writer.
    // The leave→ON_LEAVE derivation bypasses this guard BY DESIGN (it is
    // server-driven and LOP never charges non-working days either way).
    const holiday = await db.holidayCalendarEntry.findFirst({
      where: { date },
      select: { label: true, isHalfDay: true },
    });
    const reason = nonWorkingDayReason(date, holiday);
    if (reason) {
      throw new AuthorizationError(
        `${data.date} is ${reason} — attendance is not marked on non-working days (they never charge loss-of-pay either).`,
      );
    }
    // AT-B02/B03 (S2) — derive the timing facts from the times against the
    // workspace default day at WRITE time (derived-statuses discipline;
    // pure kernel, no clock, no I/O beyond the config read).
    const config = await getWorkspaceConfig();
    const timing: AttendanceTimingFacts = deriveAttendanceTiming({
      inTime: data.inTime ?? null,
      outTime: data.outTime ?? null,
      dayStart: config.workspace.attendanceDayStart,
      dayEnd: config.workspace.attendanceDayEnd,
    });
    const payload = {
      userId: data.userId,
      date,
      status: data.status,
      inTime: data.inTime ?? null,
      outTime: data.outTime ?? null,
      lateMinutes: timing.lateMinutes,
      earlyMinutes: timing.earlyMinutes,
      workingHours: timing.workingHours,
      overtimeMinutes: timing.overtimeMinutes,
      note: data.note,
      // An explicit HR save is MANUAL by definition — including when it
      // overwrites a DERIVED row (source is part of the edit, never a
      // form input).
      source: "MANUAL" as const,
    };

    if (data.id) {
      const existing = await db.attendanceRecord.findUnique({ where: { id: data.id } });
      if (!existing) throw new AuthorizationError("Attendance record not found.");
      if (existing.userId !== data.userId) {
        throw new AuthorizationError(
          "An attendance record cannot move between people — delete it and mark the other member instead.",
        );
      }
      try {
        const updated = await db.attendanceRecord.update({ where: { id: data.id }, data: payload });
        await logAudit({
          actor: auth,
          action: "hr.attendance_updated",
          entityType: "ATTENDANCE_RECORD",
          entityId: updated.id,
          entityLabel: `${target.name} · ${data.date} · ${data.status}`,
          detail: `${auth.name} updated ${target.name}'s attendance on ${data.date} to ${data.status}.${data.note ? ` — ${data.note}` : ""}`,
        });
        revalidatePath("/");
        return { id: updated.id };
      } catch (e) {
        if (isUniqueConstraintError(e)) {
          throw new AuthorizationError(
            `${target.name} already has an attendance record for ${data.date} — one record per person per day. Edit the existing record instead.`,
          );
        }
        throw e;
      }
    }

    try {
      const created = await db.attendanceRecord.create({ data: payload });
      await logAudit({
        actor: auth,
        action: "hr.attendance_marked",
        entityType: "ATTENDANCE_RECORD",
        entityId: created.id,
        entityLabel: `${target.name} · ${data.date} · ${data.status}`,
        detail: `${auth.name} marked ${target.name} ${data.status} on ${data.date}.${data.note ? ` — ${data.note}` : ""}`,
      });
      revalidatePath("/");
      return { id: created.id };
    } catch (e) {
      if (isUniqueConstraintError(e)) {
        throw new AuthorizationError(
          `${target.name} already has an attendance record for ${data.date} — one record per person per day. Edit the existing record instead.`,
        );
      }
      throw e;
    }
  });
}

/** Remove one record. Deleting a DERIVED ON_LEAVE row is allowed — HR is
 * explicitly overriding the derivation for that day (re-approving/re-deriving
 * is NOT undone; a future approval would simply re-derive). */
export async function deleteAttendanceRecord(input: {
  id: string;
}): Promise<ActionResult<{ ok: true }>> {
  return toResult(async () => {
    const auth = await requirePermission("attendance:manage");
    const data = parseOrThrow(deleteAttendanceRecordSchema, input);

    const existing = await db.attendanceRecord.findUnique({ where: { id: data.id } });
    if (!existing) throw new AuthorizationError("Attendance record not found.");
    const owner = await db.user.findUnique({
      where: { id: existing.userId },
      select: { name: true },
    });

    await db.attendanceRecord.delete({ where: { id: data.id } });
    await logAudit({
      actor: auth,
      action: "hr.attendance_deleted",
      entityType: "ATTENDANCE_RECORD",
      entityId: data.id,
      entityLabel: `${owner?.name ?? "(former user)"} · ${existing.date.toISOString().slice(0, 10)} · ${existing.status}`,
      detail: `${auth.name} removed ${owner?.name ?? "a former user"}'s ${existing.status} record for ${existing.date.toISOString().slice(0, 10)}.`,
    });
    revalidatePath("/");
    return { ok: true };
  });
}

/** Self-scoped month read — the member side of F1.3. Zero member inputs:
 * the user comes from the session and the WHERE clause is scoped by
 * construction (getMyPayslips convention). Invalid month input falls back to
 * the current UTC month. */
export async function getMyAttendance(
  yearInput?: number,
  monthInput?: number,
): Promise<ActionResult<{ year: number; month: number; records: AttendanceT[] }>> {
  return toResult(async () => {
    const auth = await getSessionOrThrow();
    const { year, month } = normalizeMonth(yearInput, monthInput);
    const { start, end } = monthBounds(year, month);

    const rows = await db.attendanceRecord.findMany({
      where: { userId: auth.userId, date: { gte: start, lte: end } },
      orderBy: { date: "asc" },
      // PR-21 — hard cap; one person's month cannot exceed 31 rows, this
      // guards a runaway client loop.
      take: 400,
    });
    return { year, month, records: rows.map((r) => serializeAttendance(r, auth.name)) };
  });
}

// ---------------------------------------------------------------------------
// P32 (AT-R01) — the monthly attendance sheet export
// ---------------------------------------------------------------------------

/**
 * The monthly attendance sheet report (benchmark: hrms
 * monthly_attendance_sheet): the HR console's own month grid rendered as
 * CSV — one row per live member (all-blank months included, the grid's
 * roster), one column per day-of-month coded P/A/HD/W/L for records and
 * WO/H for unmarked weekends/full holidays, eight summary columns closing
 * each row. attendance:manage (the grid's own gate). Audited like every
 * report export (the P20 payroll-csv discipline).
 */
export async function exportAttendanceSheetCsv(input?: {
  year?: number;
  month?: number;
}): Promise<ActionResult<{ filename: string; csv: string; mime: string }>> {
  return toResult(async () => {
    const auth = await requirePermission("attendance:manage");
    const { year, month } = normalizeMonth(input?.year, input?.month);
    const { start, end } = monthBounds(year, month);
    const monthKey = `${year}-${String(month).padStart(2, "0")}`;

    // The grid's own reads (roster + records + calendar) + the employee
    // numbers the sheet's identity column needs. PR-21 caps on the roster
    // reads; the records/holidays of one month are bounded by construction.
    const [users, records, holidays, profiles] = await Promise.all([
      db.user.findMany({
        where: { deletedAt: null },
        select: { id: true, name: true },
        orderBy: { name: "asc" },
        take: 500,
      }),
      db.attendanceRecord.findMany({
        where: { date: { gte: start, lte: end } },
        select: { userId: true, date: true, status: true },
        orderBy: { date: "asc" },
      }),
      db.holidayCalendarEntry.findMany({
        where: { date: { gte: start, lte: end } },
        select: { date: true, label: true, isHalfDay: true },
        orderBy: { date: "asc" },
      }),
      db.employeeProfile.findMany({
        select: { userId: true, employeeNumber: true },
      }),
    ]);
    const employeeNoByUser = new Map(profiles.map((p) => [p.userId, p.employeeNumber]));

    const csv = monthlyAttendanceSheetCsv({
      year,
      month,
      members: users.map((u) => ({
        userId: u.id,
        userName: u.name,
        employeeNumber: employeeNoByUser.get(u.id) ?? null,
      })),
      records: records.map((r) => ({
        userId: r.userId,
        date: r.date.toISOString().slice(0, 10),
        status: r.status,
      })),
      holidays: holidays.map((h) => ({
        date: h.date.toISOString().slice(0, 10),
        label: h.label,
        isHalfDay: h.isHalfDay,
      })),
    });

    await logAudit({
      actor: auth,
      action: "attendance.report_exported",
      entityType: "ATTENDANCE_MONTH",
      entityId: monthKey,
      entityLabel: `attendance sheet ${monthKey}`,
      detail: `${auth.name} exported the monthly attendance sheet for ${monthKey} (${users.length} member row(s)).`,
    });
    return {
      filename: `attendance-sheet-${monthKey}.csv`,
      csv,
      mime: "text/csv; charset=utf-8",
    };
  });
}
