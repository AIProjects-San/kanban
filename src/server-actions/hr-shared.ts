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
import { projectLeaveBalance, type LeaveLedgerProjection } from "@/lib/leave-ledger";
import { formatEmployeeNumber, parseEmployeeNumber } from "@/lib/employment";
import { resolveLeaveApprover } from "@/lib/hierarchy";
import {
  resolveLeavePolicy,
  dueGrantOps,
  type EmploymentFacts,
  type GrantOp,
  type LeavePolicyRow,
} from "@/lib/leave-policy";
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
  // S14 (EM-B04/LV-B13) — the employee's explicit override outranks the
  // reporting manager (resolveLeaveApprover); the pure rule lives in
  // lib/hierarchy.ts, this is its one DB-backed reader.
  const [user, profile] = await Promise.all([
    db.user.findUnique({
      where: { id: userId },
      select: { managerId: true },
    }),
    db.employeeProfile.findUnique({
      where: { userId },
      select: { leaveApproverId: true },
    }),
  ]);
  const resolved = resolveLeaveApprover({
    leaveApproverId: profile?.leaveApproverId ?? null,
    managerId: user?.managerId ?? null,
  });
  if (resolved.approverId) return [resolved.approverId];
  // No manager and no override on record — every ADMIN may decide.
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
// has never taken leave still sees their entitlement. F2.4: for strategy
// types (ANNUAL_LUMP_SUM / EARNED / AFTER_SERVICE) the materialization
// grants everything ALREADY DUE under the strategy (the same dueGrantOps
// rule the cron advances); MANUAL keeps the pre-F2.4 single-grant path
// byte-for-byte.
// ---------------------------------------------------------------------------

/** The policy-shaped input the strategy materializers need — what the
 * callers already have in hand from `include: { policy: true }`. */
export type LeavePolicyInput = LeavePolicyRow | null | undefined;

/** Employment facts for one user (profile row projected to day keys). */
async function employmentFactsFor(
  userId: string,
): Promise<EmploymentFacts | null> {
  const profile = await db.employeeProfile.findUnique({
    where: { userId },
    select: { hireDate: true, employmentStatus: true, probationEndsAt: true },
  });
  if (!profile) return null;
  return {
    hireDate: profile.hireDate ? dayKey(profile.hireDate) : null,
    employmentStatus: profile.employmentStatus,
    probationEndsAt: profile.probationEndsAt ? dayKey(profile.probationEndsAt) : null,
  };
}

/** The strategy grants due at materialization time (MANUAL → the legacy
 * single full-year grant op with the legacy sourceId). Pure rule + a
 * facts read; called only when the balance row is missing. */
async function materializationGrantOps(
  userId: string,
  policyRow: LeavePolicyInput,
  year: number,
): Promise<GrantOp[]> {
  const policy = resolveLeavePolicy(policyRow);
  if (policy.allocationStrategy === "MANUAL") {
    // Legacy path, unchanged: one GRANT of annualDays, sourceId = the type
    // id (the F1.2 convention existing rows and tests pin).
    if (policy.annualDays === 0) return [];
    return [{
      periodKey: "", // caller writes the legacy sourceId (leaveTypeId)
      delta: policy.annualDays,
      dueDate: `${year}-01-01`,
      note: `Entitlement materialized (${policy.annualDays} days)`,
    }];
  }
  return dueGrantOps({
    policy,
    employment: await employmentFactsFor(userId),
    year,
    asOf: dayKey(new Date()), // "now" at materialization time (documented)
    grantedSoFar: 0,
    availableNow: 0,
    existingPeriodKeys: new Set<string>(), // no balance row ⇒ no POLICY rows
  });
}

export async function getOrCreateBalance(
  userId: string,
  leaveTypeId: string,
  year: number,
  policyRow: LeavePolicyInput,
): Promise<{ entitled: number; carriedOver: number; used: number }> {
  const existing = await db.leaveBalance.findUnique({
    where: { userId_leaveTypeId_year: { userId, leaveTypeId, year } },
    select: { entitled: true, carriedOver: true, used: true },
  });
  if (existing) return existing;
  // No row yet — materialize the entitlement from the policy AND its
  // ledger GRANT row(s) that explain it, in ONE transaction (F1.2: a
  // balance row must never exist without its ledger rows).
  const ops = await materializationGrantOps(userId, policyRow, year);
  const entitled = ops.reduce((s, o) => s + o.delta, 0);
  const legacySourceId = resolveLeavePolicy(policyRow).allocationStrategy === "MANUAL";
  await db
    .$transaction(async (tx) => {
      await tx.leaveBalance.create({
        data: { userId, leaveTypeId, year, entitled, carriedOver: 0, used: 0 },
      });
      if (legacySourceId) {
        // Legacy MANUAL path, byte-identical to pre-F2.4: a single GRANT
        // row with sourceId = the type id (the F1.2 convention).
        if (ops.length === 1) {
          await tx.leaveLedgerEntry.create({
            data: {
              userId,
              leaveTypeId,
              year,
              delta: ops[0].delta,
              entryType: "GRANT",
              sourceType: "POLICY",
              sourceId: leaveTypeId,
              note: ops[0].note,
              isReversal: false,
            },
          });
        }
      } else if (ops.length > 0) {
        // Strategy types: one GRANT row per due period (sourceId = the
        // deterministic period key — the cron job's idempotency input).
        await tx.leaveLedgerEntry.createMany({
          data: ops.map((op) => ({
            userId,
            leaveTypeId,
            year,
            delta: op.delta,
            entryType: "GRANT",
            sourceType: "POLICY",
            sourceId: op.periodKey,
            note: op.note,
            isReversal: false,
          })),
        });
      }
    })
    .catch((err) => {
      // Unique-trio race with a concurrent reader: read the winner's row
      // (the winner's transaction wrote its GRANT rows too — both-or-neither
      // is the point of the shared transaction).
      // PR-22 — log it so a persistent (non-race) failure is visible.
      logError("[hr-shared] leave balance materialize raced with a concurrent create:", err);
    });
  const row = await db.leaveBalance.findUnique({
    where: { userId_leaveTypeId_year: { userId, leaveTypeId, year } },
    select: { entitled: true, carriedOver: true, used: true },
  });
  const fallback = { entitled, carriedOver: 0, used: 0 };
  return row ?? fallback;
}

/**
 * PR-19 (production-readiness audit) — batched variant of the above for read
 * paths that need balances for EVERY leave type (the Leave view's header).
 * The per-type loop was a true query N+1 (3 queries per type, including a
 * WRITE on a read path); steady-state is now exactly 2 queries, and the
 * lazy-materialize write only happens for types missing a row (first ever
 * view, or a newly created type). F2.4: materialization is strategy-aware
 * (one facts read per user when anything is missing). Not exported as a
 * server action — helper.
 */
export async function getOrCreateBalancesBatch(
  userId: string,
  types: Array<{ id: string; policy: LeavePolicyInput }>,
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
    // Employment facts for the strategy types among the missing rows (one
    // read — MANUAL missing rows never need it).
    const anyStrategy = missing.some(
      (t) => resolveLeavePolicy(t.policy).allocationStrategy !== "MANUAL",
    );
    let facts: EmploymentFacts | null = null;
    if (anyStrategy) {
      const profile = await db.employeeProfile.findUnique({
        where: { userId },
        select: { hireDate: true, employmentStatus: true, probationEndsAt: true },
      });
      facts = profile
        ? {
            hireDate: profile.hireDate ? dayKey(profile.hireDate) : null,
            employmentStatus: profile.employmentStatus,
            probationEndsAt: profile.probationEndsAt ? dayKey(profile.probationEndsAt) : null,
          }
        : null;
    }
    const asOf = dayKey(new Date());
    const opsByType = missing.map((t) => {
      const policy = resolveLeavePolicy(t.policy);
      if (policy.allocationStrategy === "MANUAL") {
        return policy.annualDays === 0
          ? []
          : [{
              periodKey: "", // legacy sourceId (the type id) — see below
              delta: policy.annualDays,
              dueDate: `${year}-01-01`,
              note: `Entitlement materialized (${policy.annualDays} days)`,
            }];
      }
      return dueGrantOps({
        policy,
        employment: facts,
        year,
        asOf,
        grantedSoFar: 0,
        availableNow: 0,
        existingPeriodKeys: new Set<string>(),
      });
    });
    const entitledByType = opsByType.map((ops) => ops.reduce((s, o) => s + o.delta, 0));

    // Materialize missing rows TOGETHER with their GRANT ledger rows in one
    // transaction (F1.2 — a cache row without its ledger explanation must
    // never exist). createMany without skipDuplicates (unsupported on
    // SQLite) — a unique-trio race with a concurrent reader loses the whole
    // transaction and is handled by the re-read below (same contract as
    // getOrCreateBalance).
    await db
      .$transaction(async (tx) => {
        await tx.leaveBalance.createMany({
          data: missing.map((t, i) => ({
            userId, leaveTypeId: t.id, year, entitled: entitledByType[i], carriedOver: 0, used: 0,
          })),
        });
        const ledgerRows = missing.flatMap((t, i) => {
          const legacy = resolveLeavePolicy(t.policy).allocationStrategy === "MANUAL";
          return opsByType[i].map((op) => ({
            userId,
            leaveTypeId: t.id,
            year,
            delta: op.delta,
            entryType: "GRANT",
            sourceType: "POLICY",
            sourceId: legacy ? t.id : op.periodKey,
            note: op.note,
            isReversal: false,
          }));
        });
        if (ledgerRows.length > 0) {
          await tx.leaveLedgerEntry.createMany({ data: ledgerRows });
        }
      })
      .catch((err) => {
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
    // The facts-free fallback is the legacy flat entitlement (what the
    // pre-F2.4 code fell back to when the re-read still lost the race).
    result.set(
      t.id,
      row ?? { entitled: resolveLeavePolicy(t.policy).annualDays, carriedOver: 0, used: 0 },
    );
  }
  return result;
}

// ---------------------------------------------------------------------------
// F1.2 — leave-ledger access (docs/Fernly_HR_Payroll_Enhancement_Plan.md
// §7.1). The append-only LeaveLedgerEntry is the source of truth for every
// balance mutation; these helpers read/project it for the guards, and the
// action code re-syncs the LeaveBalance cache from the same projection
// inside every ledger-writing transaction.
// ---------------------------------------------------------------------------

/** Transaction-client surface the ledger read helper needs — both the
 * db.$transaction callback parameter and the plain client satisfy it
 * structurally (same pattern as AttendanceTx below). */
type LedgerReadTx = Pick<Prisma.TransactionClient, "leaveLedgerEntry">;

/**
 * Project the (userId, leaveTypeId, year) balance from the LEDGER — one
 * groupBy aggregate; `available` is the number every overdraft guard
 * compares against. Called inside the approve/cancel transactions so the
 * guard reads truth, not the cache it is about to write.
 */
export async function ledgerProjectionFor(
  tx: LedgerReadTx,
  userId: string,
  leaveTypeId: string,
  year: number,
): Promise<LeaveLedgerProjection> {
  const groups = await tx.leaveLedgerEntry.groupBy({
    by: ["entryType"],
    where: { userId, leaveTypeId, year },
    _sum: { delta: true },
  });
  return projectLeaveBalance(
    groups.map((g) => ({ entryType: g.entryType, delta: g._sum.delta ?? 0 })),
  );
}

/** Transaction-client surface the balance materialize helper needs. */
type BalanceWriteTx = Pick<
  Prisma.TransactionClient,
  "leaveBalance" | "leaveLedgerEntry" | "leavePolicy" | "employeeProfile"
>;

/**
 * Materialize the balance row + its GRANT ledger row(s) INSIDE the caller's
 * transaction when the row is missing (the approve path's fail-closed
 * default, mirroring the old inline logic's semantics). F2.4:
 * strategy-aware — non-MANUAL types grant everything due under the strategy
 * as of today; MANUAL keeps the legacy single-grant shape. Deliberately NOT
 * the try/catch-re-read pattern of the read-path helpers: inside a
 * Postgres transaction an INSERT unique-violation aborts the transaction,
 * so a lost race must fail loudly (a retryable error to the decider)
 * instead of swallowing into an aborted transaction state.
 */
export async function materializeLeaveBalanceTx(
  tx: BalanceWriteTx,
  userId: string,
  leaveTypeId: string,
  year: number,
): Promise<void> {
  const existing = await tx.leaveBalance.findUnique({
    where: { userId_leaveTypeId_year: { userId, leaveTypeId, year } },
    select: { id: true },
  });
  if (existing) return;
  const policyRow = await tx.leavePolicy.findUnique({ where: { leaveTypeId } });
  const policy = resolveLeavePolicy(policyRow);

  let ops: GrantOp[];
  let legacySourceId: boolean;
  if (policy.allocationStrategy === "MANUAL") {
    legacySourceId = true;
    ops =
      policy.annualDays === 0
        ? []
        : [{
            periodKey: "",
            delta: policy.annualDays,
            dueDate: `${year}-01-01`,
            note: `Entitlement materialized (${policy.annualDays} days)`,
          }];
  } else {
    legacySourceId = false;
    const profile = await tx.employeeProfile.findUnique({
      where: { userId },
      select: { hireDate: true, employmentStatus: true, probationEndsAt: true },
    });
    const facts: EmploymentFacts | null = profile
      ? {
          hireDate: profile.hireDate ? dayKey(profile.hireDate) : null,
          employmentStatus: profile.employmentStatus,
          probationEndsAt: profile.probationEndsAt ? dayKey(profile.probationEndsAt) : null,
        }
      : null;
    ops = dueGrantOps({
      policy,
      employment: facts,
      year,
      asOf: dayKey(new Date()),
      grantedSoFar: 0,
      availableNow: 0,
      existingPeriodKeys: new Set<string>(),
    });
  }

  const entitled = ops.reduce((s, o) => s + o.delta, 0);
  await tx.leaveBalance.create({
    data: { userId, leaveTypeId, year, entitled, carriedOver: 0, used: 0 },
  });
  if (legacySourceId) {
    // Legacy MANUAL path, byte-identical to pre-F2.4: one GRANT row via
    // .create with sourceId = the type id (the F1.2 convention).
    if (ops.length === 1) {
      await tx.leaveLedgerEntry.create({
        data: {
          userId,
          leaveTypeId,
          year,
          delta: ops[0].delta,
          entryType: "GRANT",
          sourceType: "POLICY",
          sourceId: leaveTypeId,
          note: ops[0].note,
          isReversal: false,
        },
      });
    }
  } else if (ops.length > 0) {
    // Strategy types: one GRANT row per due period (sourceId = the
    // deterministic period key — the cron job's idempotency input).
    await tx.leaveLedgerEntry.createMany({
      data: ops.map((op) => ({
        userId,
        leaveTypeId,
        year,
        delta: op.delta,
        entryType: "GRANT",
        sourceType: "POLICY",
        sourceId: op.periodKey,
        note: op.note,
        isReversal: false,
      })),
    });
  }
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

// ---------------------------------------------------------------------------
// EM-B01 (S13) — the employee-number series' ONE assignment helper
// ---------------------------------------------------------------------------

/** The next employee number (EMP-XXXX) inside the caller's transaction:
 * max existing sequence + 1, formatted by the pure kernel. Lexicographic
 * max works because the zero-padded series sorts numerically; the parsed
 * suffix keeps working past EMP-9999. */
export async function nextEmployeeNumber(
  tx: Pick<Prisma.TransactionClient, "employeeProfile">,
): Promise<string> {
  const last = await tx.employeeProfile.findFirst({
    orderBy: { employeeNumber: "desc" },
    select: { employeeNumber: true },
  });
  const seq = parseEmployeeNumber(last?.employeeNumber) ?? 0;
  return formatEmployeeNumber(seq + 1);
}
