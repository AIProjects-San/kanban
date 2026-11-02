// SERVER-ONLY shared helpers for the HR module action files.
//
// NOTE: This file intentionally does NOT have "use server" — it exports
// non-async values and is imported by the hr-* action modules, never by
// client components.

import { db } from "@/lib/db";
import { AuthorizationError } from "./auth-guard";

// ---------------------------------------------------------------------------
// Working-day math. Dates travel as "yyyy-mm-dd" strings from the client
// and are normalized to UTC midnight so day arithmetic is timezone-stable
// regardless of the server's TZ. Weekends (Sat/Sun) never count as leave.
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
 * Count Mon–Fri days in [start, end] inclusive. The canonical leave "days"
 * number — denormalized onto the request at creation and never re-derived.
 */
export function workingDays(start: Date, end: Date): number {
  let count = 0;
  const cursor = new Date(start.getTime());
  while (cursor.getTime() <= end.getTime()) {
    const dow = cursor.getUTCDay(); // 0 Sun … 6 Sat
    if (dow !== 0 && dow !== 6) count += 1;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return count;
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
  const admins = await db.user.findMany({
    where: { role: "ADMIN", deletedAt: null },
    select: { id: true },
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
  }).catch(() => {
    // Unique-trio race with a concurrent reader: read the winner's row.
  });
  const row = await db.leaveBalance.findUnique({
    where: { userId_leaveTypeId_year: { userId, leaveTypeId, year } },
    select: { entitled: true, carriedOver: true, used: true },
  });
  return row ?? { entitled: defaultEntitled, carriedOver: 0, used: 0 };
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
