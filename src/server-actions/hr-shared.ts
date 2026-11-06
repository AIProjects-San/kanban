// SERVER-ONLY shared helpers for the HR module action files.
//
// NOTE: This file intentionally does NOT have "use server" — it exports
// non-async values and is imported by the hr-* action modules, never by
// client components.

import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { logError } from "@/lib/observability";
import type { HolidayT } from "@/lib/types";
import {
  dayKey,
  holidayLookupFrom,
  workingDaysBetween,
  type HolidayLookup,
} from "@/lib/working-days";
import { AuthorizationError } from "./auth-guard";

// ---------------------------------------------------------------------------
// Working-day math. Dates travel as "yyyy-mm-dd" strings from the client
// and are normalized to UTC midnight so day arithmetic is timezone-stable
// regardless of the server's TZ. Weekends (Sat/Sun) never count as leave;
// holiday-calendar entries remove weekdays too (F1.1) — see
// lib/working-days.ts for the exact semantics.
// ---------------------------------------------------------------------------

export function parseDay(s: string): Date {
  // Validate the shape first — a bad string must throw, not silently
  // become Invalid Date arithmetic (NaN days).
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new Error(`Invalid date: ${s}`);
  }
  const d = new Date(`${s}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Invalid date: ${s}`);
  }
  return d;
}

/** Whole calendar days from a (inclusive) to b (exclusive). */
export function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}

/**
 * Count Mon–Fri days in [start, end] inclusive. Holiday-free variant kept
 * for call sites with no range lookup (and for the unit tests that pin the
 * plain weekend rule) — the canonical leave "days" number is denormalized
 * onto the request at creation and never re-derived.
 */
export function workingDays(start: Date, end: Date): number {
  return workingDaysBetween(start, end);
}

// ---------------------------------------------------------------------------
// F1.1 — holiday-calendar access. One read per range; the lookup feeds
// workingDaysBetween (leave counting) and workingDaysInPeriod (payroll
// denominators). Rows are date-only UTC-midnight values, so inclusive
// gte/lte bounds on the same convention match exactly.
// ---------------------------------------------------------------------------

export async function getHolidayLookup(start: Date, end: Date): Promise<HolidayLookup> {
  const rows = await db.holidayCalendarEntry.findMany({
    where: { date: { gte: start, lte: end } },
    select: { date: true, isHalfDay: true },
  });
  return holidayLookupFrom(rows);
}

/** Holiday entries as client-shaped rows ("yyyy-mm-dd" + label), used by the
 * Leave view's live preview. Returns the compact projection, not Dates. */
export async function getHolidayRows(start: Date, end: Date): Promise<HolidayT[]> {
  const rows = await db.holidayCalendarEntry.findMany({
    where: { date: { gte: start, lte: end } },
    orderBy: { date: "asc" },
  });
  return rows.map((r) => ({
    id: r.id,
    date: dayKey(r.date),
    label: r.label,
    kind: r.kind as HolidayT["kind"],
    isHalfDay: r.isHalfDay,
  }));
}

/** Today at UTC midnight — the reference point for notice checks. */
export function todayUTC(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

// ---------------------------------------------------------------------------
// Approver resolution — single-approver flow (docs/HR_MODULE_PLAN.md §1):
// the requester's manager (User.managerId chain); fallback any ADMIN when
// the requester has no manager (root / unmanaged users).
// ---------------------------------------------------------------------------

export async function getApproverIdsFor(userId: string): Promise<string[]> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { managerId: true },
  });
  if (user?.managerId) return [user.managerId];
  // No manager on record — every ADMIN may decide.
  // PR-21 — take 50: a workspace with >50 admins is a config smell; the cap
  // just bounds the IN-clause built from this list.
  const admins = await db.user.findMany({
    where: { role: "ADMIN", deletedAt: null },
    select: { id: true },
    take: 50,
  });
  return admins.map((a) => a.id);
}

/**
 * Assert the caller may decide (approve/reject) a leave request: they must
 * be the requester's manager OR an ADMIN. HR/MANAGER roles that are not in
 * the requester's chain are explicitly NOT deciders (scoping decision —
 * leave reasons are personal data).
 */
export async function assertLeaveDecider(
  auth: { userId: string; role: string },
  requesterId: string,
): Promise<void> {
  if (auth.role === "ADMIN") return;
  const approvers = await getApproverIdsFor(requesterId);
  if (!approvers.includes(auth.userId)) {
    throw new AuthorizationError(
      "Only the requester's manager (or an admin) can decide this leave request.",
    );
  }
}

// ---------------------------------------------------------------------------
// Balance access — lazily materialized from the type's policy so a user who
// has never taken leave still sees their entitlement.
// ---------------------------------------------------------------------------

export async function getOrCreateBalance(
  userId: string,
  leaveTypeId: string,
  year: number,
  defaultEntitled: number,
): Promise<{ entitled: number; carriedOver: number; used: number }> {
  const existing = await db.leaveBalance.findUnique({
    where: { userId_leaveTypeId_year: { userId, leaveTypeId, year } },
    select: { entitled: true, carriedOver: true, used: true },
  });
  if (existing) return existing;
  // No row yet — materialize the entitlement from the policy default.
  await db.leaveBalance.create({
    data: { userId, leaveTypeId, year, entitled: defaultEntitled, carriedOver: 0, used: 0 },
  }).catch((err) => {
    // Unique-trio race with a concurrent reader: read the winner's row.
    // PR-22 — this catch was previously completely silent; log it so a
    // persistent (non-race) failure is visible in the log stream.
    logError("[hr-shared] leave balance materialize raced with a concurrent create:", err);
  });
  const row = await db.leaveBalance.findUnique({
    where: { userId_leaveTypeId_year: { userId, leaveTypeId, year } },
    select: { entitled: true, carriedOver: true, used: true },
  });
  return row ?? { entitled: defaultEntitled, carriedOver: 0, used: 0 };
}

/**
 * PR-19 (production-readiness audit) — batched variant of the above for read
 * paths that need balances for EVERY leave type (the Leave view's header).
 * The per-type loop was a true query N+1 (3 queries per type, including a
 * WRITE on a read path); steady-state is now exactly 2 queries, and the
 * lazy-materialize write only happens for types missing a row (first ever
 * view, or a newly created type). Not exported as a server action — helper.
 */
export async function getOrCreateBalancesBatch(
  userId: string,
  types: Array<{ id: string; entitled: number }>,
  year: number,
): Promise<Map<string, { entitled: number; carriedOver: number; used: number }>> {
  const result = new Map<string, { entitled: number; carriedOver: number; used: number }>();
  if (types.length === 0) return result;

  const rows = await db.leaveBalance.findMany({
    where: { userId, year, leaveTypeId: { in: types.map((t) => t.id) } },
    select: { leaveTypeId: true, entitled: true, carriedOver: true, used: true },
  });
  const byType = new Map(rows.map((r) => [r.leaveTypeId, r]));

  const missing = types.filter((t) => !byType.has(t.id));
  if (missing.length > 0) {
    // Materialize missing rows. createMany without skipDuplicates (unsupported
    // on SQLite) — a unique-trio race with a concurrent reader is handled by
    // re-reading below (same contract as getOrCreateBalance).
    await db.leaveBalance.createMany({
      data: missing.map((t) => ({
        userId, leaveTypeId: t.id, year, entitled: t.entitled, carriedOver: 0, used: 0,
      })),
    }).catch((err) => {
      logError("[hr-shared] balance batch materialize raced with a concurrent create:", err);
    });
    const retry = await db.leaveBalance.findMany({
      where: { userId, year, leaveTypeId: { in: missing.map((t) => t.id) } },
      select: { leaveTypeId: true, entitled: true, carriedOver: true, used: true },
    });
    for (const r of retry) byType.set(r.leaveTypeId, r);
  }

  for (const t of types) {
    const row = byType.get(t.id);
    result.set(t.id, row ?? { entitled: t.entitled, carriedOver: 0, used: 0 });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Time guard — one source of truth for "is this user on approved leave on
// date D?", used by both time-entry actions (logTime / logTaskTime) and the
// leave actions' overlap checks.
// ---------------------------------------------------------------------------

export async function findApprovedLeaveOn(
  userId: string,
  date: Date,
): Promise<{ id: string; typeName: string } | null> {
  // Leave dates are stored as UTC-midnight date-only values, so an exact
  // day match is simply start <= day <= end.
  const dayStart = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const rows = await db.leaveRequest.findMany({
    where: {
      userId,
      status: "APPROVED",
      startDate: { lte: dayStart },
      endDate: { gte: dayStart },
    },
    select: { id: true, leaveTypeId: true },
    take: 1,
  });
  if (rows.length === 0) return null;
  const type = await db.leaveType.findUnique({
    where: { id: rows[0].leaveTypeId },
    select: { name: true },
  });
  return { id: rows[0].id, typeName: type?.name ?? "Leave" };
}

/**
 * Overlap guard — a user may not have two PENDING/APPROVED requests whose
 * [start, end] ranges intersect. CANCELLED/REJECTED history is ignored.
 */
export async function findOverlappingActiveRequest(
  userId: string,
  startDate: Date,
  endDate: Date,
  excludeId?: string,
): Promise<{ id: string } | null> {
  const rows = await db.leaveRequest.findFirst({
    where: {
      userId,
      status: { in: ["PENDING", "APPROVED"] },
      startDate: { lte: endDate },
      endDate: { gte: startDate },
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
    select: { id: true },
  });
  return rows;
}

// ---------------------------------------------------------------------------
// F1.3 — attendance derivation (docs/Fernly_HR_Payroll_Enhancement_Plan.md
// §7.1, ADR-009 virtual-event precedent). Approved leave auto-marks ON_LEAVE
// attendance rows; cancelling that leave removes them again unless another
// approved request still covers the date. Runs INSIDE the caller's
// transaction so a rolled-back approval/cancel never leaves phantom rows.
// An explicit HR record (MANUAL/IMPORT) always wins and is never touched.
// ---------------------------------------------------------------------------

/** Transaction-client surface the derivation helpers need — both the
 * db.$transaction callback parameter and the plain client satisfy it
 * structurally (the seed re-implements the same logic without a
 * transaction). */
type AttendanceTx = Pick<Prisma.TransactionClient, "attendanceRecord" | "leaveRequest">;

/** Every calendar day in [start, end] inclusive, as UTC-midnight Dates. */
function eachDay(start: Date, end: Date): Date[] {
  const days: Date[] = [];
  for (let d = new Date(start); d <= end; d = new Date(d.getTime() + 86_400_000)) {
    days.push(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())));
  }
  return days;
}

/** Derive ON_LEAVE rows for an approved leave request. Idempotent: dates
 * that already have ANY record (an explicit HR mark, or a previously
 * derived row) are skipped — one record per user per day. Returns how many
 * rows were created (0 on re-approval — the leave.approved audit entry is
 * the single source of truth for the decision; rows are just state). */
export async function deriveOnLeaveAttendance(
  tx: AttendanceTx,
  request: { userId: string; startDate: Date; endDate: Date },
  leaveTypeName: string,
): Promise<number> {
  const existing = await tx.attendanceRecord.findMany({
    where: { userId: request.userId, date: { gte: request.startDate, lte: request.endDate } },
    select: { date: true },
  });
  const taken = new Set(existing.map((r) => dayKey(r.date)));
  const rows = eachDay(request.startDate, request.endDate)
    .filter((d) => !taken.has(dayKey(d)))
    .map((d) => ({
      userId: request.userId,
      date: d,
      status: "ON_LEAVE",
      note: `Derived from approved ${leaveTypeName} leave`,
      source: "DERIVED",
    }));
  if (rows.length === 0) return 0;
  await tx.attendanceRecord.createMany({ data: rows });
  return rows.length;
}

/** Remove the DERIVED ON_LEAVE rows of a cancelled approved request — but
 * only for dates no OTHER approved request still covers (overlapping
 * approved requests of different types are legal; their derived rows must
 * survive). MANUAL/IMPORT records are never touched. Returns how many rows
 * were removed. */
export async function removeDerivedOnLeaveAttendance(
  tx: AttendanceTx,
  request: { userId: string; startDate: Date; endDate: Date },
): Promise<number> {
  // Other approved requests overlapping the cancelled range.
  const others = await tx.leaveRequest.findMany({
    where: {
      userId: request.userId,
      status: "APPROVED",
      startDate: { lte: request.endDate },
      endDate: { gte: request.startDate },
    },
    select: { startDate: true, endDate: true },
  });
  const stillCovered = new Set<string>();
  for (const o of others) {
    for (const d of eachDay(o.startDate, o.endDate)) stillCovered.add(dayKey(d));
  }
  const derived = await tx.attendanceRecord.findMany({
    where: {
      userId: request.userId,
      source: "DERIVED",
      status: "ON_LEAVE",
      date: { gte: request.startDate, lte: request.endDate },
    },
    select: { date: true },
  });
  const doomed = derived.filter((r) => !stillCovered.has(dayKey(r.date))).map((r) => r.date);
  if (doomed.length === 0) return 0;
  await tx.attendanceRecord.deleteMany({
    where: { userId: request.userId, source: "DERIVED", status: "ON_LEAVE", date: { in: doomed } },
  });
  return doomed.length;
}
