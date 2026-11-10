// F2.4 — leave-allocation job core (the scheduled writer of the leave
// policy engine). docs/Fernly_HR_Payroll_Enhancement_Plan.md §7.2 F2.4;
// docs/Fernly_Policy_Engine_Design.md §4.5.
//
// Three writers, one truth (the append-only LeaveLedgerEntry, F1.2):
//   1. LAZY MATERIALIZATION (request/read paths — hr-shared.ts): the first
//      touch of a missing balance row grants everything already due.
//   2. THIS JOB's GRANT phase: for every non-MANUAL strategy type, appends
//      the due-but-missing GRANT rows (idempotent via deterministic
//      sourceId period keys — LV-J03, the benchmark's daily
//      allocate_earned_leaves).
//   3. THIS JOB's ROLLOVER + LAPSE phases: the year-end CARRY/EXPIRE pair
//      (capped by maxCarryOver) and, when carryExpiresAfterMonths is set,
//      the mid-year EXPIRE of still-unspent carried days.
//
// Writer discipline (the no-race contract):
//   • the LAZY writer only ever runs when the balance row is MISSING (its
//     unique-trio creation is the race guard — F1.2's pattern);
//   • THIS JOB only ever appends when the balance row EXISTS (and creates
//     year rows itself in the rollover phase);
//   ⇒ the two writers can never target the same missing-row state, and the
//   job's own re-runs are idempotent through the ledger's sourceId keys.
//
// Each (user, type) pair advances in its OWN transaction (savepoint-per-
// item, house pattern §7.0): one bad pair logs and skips, never fails the
// run. The route (/api/cron/leave-allocation) holds the cross-instance
// LEAVE_ALLOCATION_LOCK_KEY maintenance lock; the job itself stays
// idempotent regardless (double-run ⇒ no new rows).
//
// MANUAL types are skipped by the grant phase (materialization is their
// only writer) but DO ride the rollover/lapse phases — carry-over is a
// property of every leave type with a policy, exactly like the benchmark.

import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { logError, logInfo } from "@/lib/observability";
import { dayKey } from "@/lib/working-days";
import { projectLeaveBalance, type LeaveLedgerProjection } from "@/lib/leave-ledger";
import { queueOutboxMail, deliverOutboxMail } from "@/server-actions/shared";
import { leaveJobFailureEmailSubject, leaveJobFailureEmailText, leaveEmailHtml } from "@/lib/leave-email";
import {
  resolveLeavePolicy,
  dueGrantOps,
  rolloverOps,
  carryLapseDelta,
  type EmploymentFacts,
  type GrantOp,
} from "@/lib/leave-policy";
// P27 (LV-08) — the named allocation windows. No rows = the implicit
// calendar year, byte-identical to the pre-P27 pass.
import {
  resolveActiveWindow,
  carrySourceBucket,
  monthsIntoWindow,
  type LeavePeriodInput,
  type LeaveWindow,
} from "@/lib/leave-period";

/** DB row → the kernel's plain-data shape (day keys). */
function toPeriodInput(row: { id: string; name: string; startDate: Date; endDate: Date }): LeavePeriodInput {
  return { id: row.id, name: row.name, startDate: dayKey(row.startDate), endDate: dayKey(row.endDate) };
}

export interface LeaveAllocationJobReport {
  asOf: string;
  typesConsidered: number;
  manualTypesSkipped: number;
  /** (user, type) pairs examined by the grant phase. */
  grantPairsConsidered: number;
  grantsWritten: number;
  /** Year-end CARRY rows written. */
  carryRowsWritten: number;
  /** EXPIRE rows written (rollover cap + carry lapse). */
  expireRowsWritten: number;
  failures: number;
  /** P21 (LV-B18) — the failure-reason records: one per failed pair with
   * the phase and the humanized reason (the benchmark's Earned Leave
   * Schedule failure_reason column, journaled per pass instead of per
   * allocation row — the next daily pass retries the pair idempotently,
   * which IS the benchmark's retry loop minus the attempted flag). */
  failuresDetail: LeaveAllocationFailure[];
}

export interface LeaveAllocationFailure {
  userId: string;
  leaveTypeId: string;
  leaveTypeName: string;
  phase: "GRANT" | "ROLLOVER" | "LAPSE";
  reason: string;
}

/** Ledger rows this job writes — the writer half of the idempotency
 * contract (sourceType "POLICY", sourceId = the deterministic period/carry
 * key the rule produced). */
type LedgerWriteTx = Pick<Prisma.TransactionClient, "leaveBalance" | "leaveLedgerEntry">;
type LedgerReadTx = Pick<Prisma.TransactionClient, "leaveLedgerEntry">;

/** Day key for a possibly-null Date ("" when absent). */
function dateKey(d: Date | null | undefined): string | null {
  return d ? dayKey(d) : null;
}

async function ledgerProjection(
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

/** Append grant rows + re-sync the cache absolutely from the projection —
 * inside the caller's transaction. */
async function appendGrantsTx(
  tx: LedgerWriteTx,
  userId: string,
  leaveTypeId: string,
  year: number,
  ops: GrantOp[],
): Promise<void> {
  if (ops.length === 0) return;
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
  const projection = await ledgerProjection(tx, userId, leaveTypeId, year);
  await tx.leaveBalance.update({
    where: { userId_leaveTypeId_year: { userId, leaveTypeId, year } },
    data: {
      entitled: projection.entitled,
      carriedOver: projection.carriedOver,
      used: Math.max(0, projection.used),
    },
  });
}

/** The cron job: advance every strategy to `asOf` (default today UTC).
 * Idempotent; savepoint-per-pair; never throws (failures are counted and
 * logged — a cron pass must report, not crash).
 * P27 (LV-08): the pass advances the ACTIVE allocation window — the named
 * period containing asOf (its ledger bucket = the period's start year),
 * or the implicit calendar year when the period table is empty
 * (byte-identical to the pre-P27 pass). When periods EXIST but asOf
 * precedes the first one (the migration gap), the pass is an honest
 * no-op: implicit grants stop the moment the table is non-empty, so a
 * half-migrated workspace can never double-grant. */
export async function runLeaveAllocationJob(asOfDate?: Date): Promise<LeaveAllocationJobReport> {
  const asOfD = asOfDate ?? new Date();
  const asOf = dayKey(asOfD);

  const periods = (
    await db.leavePeriod.findMany({ orderBy: { startDate: "asc" } })
  ).map(toPeriodInput);
  const active = resolveActiveWindow(periods, asOf);
  const namedWindow = active.periodId !== null ? { start: active.start, end: active.end } : undefined;
  const year = active.bucketYear;

  const report: LeaveAllocationJobReport = {
    asOf,
    typesConsidered: 0,
    manualTypesSkipped: 0,
    grantPairsConsidered: 0,
    grantsWritten: 0,
    carryRowsWritten: 0,
    expireRowsWritten: 0,
    failures: 0,
    failuresDetail: [],
  };

  const types = await db.leaveType.findMany({
    where: { active: true },
    include: { policy: true },
  });
  report.typesConsidered = types.length;

  if (periods.length > 0 && active.periodId === null) {
    // Pre-first-period migration gap: no window covers asOf and none has
    // ended yet — nothing to advance. The first period's own pass (once
    // asOf enters it) grants its window and rolls startYear − 1 into it.
    logInfo(
      `[leave-allocation] pass skipped: ${asOf} precedes the first named period (${periods[0].name}, ${periods[0].startDate}) — no implicit grants while periods exist`,
    );
    return report;
  }

  // ROLLOVER + LAPSE first (they create the new-bucket balance rows the
  // grant phase then advances), then GRANTS.
  for (const type of types) {
    if (!type.policy) continue;
    const policy = resolveLeavePolicy(type.policy);
    await runRolloverForType(type.id, type.name, policy, active, periods, report);
    await runLapseForType(type.id, type.name, policy, active, report);
  }

  // GRANTS — every non-MANUAL strategy (MANUAL's only writer is the lazy
  // materializer; skipping it here also keeps the legacy sourceId
  // convention untouched).
  for (const type of types) {
    if (!type.policy) continue;
    const policy = resolveLeavePolicy(type.policy);
    if (policy.allocationStrategy === "MANUAL") {
      report.manualTypesSkipped += 1;
      continue;
    }
    // Only pairs whose CURRENT-bucket balance row exists (the no-race
    // contract above). Profile-less users stay on the lazy path.
    const balances = await db.leaveBalance.findMany({
      where: { leaveTypeId: type.id, year },
      select: { userId: true },
    });
    if (balances.length === 0) continue;
    report.grantPairsConsidered += balances.length;

    const profiles = await db.employeeProfile.findMany({
      where: { userId: { in: balances.map((b) => b.userId) } },
      select: { userId: true, hireDate: true, employmentStatus: true, probationEndsAt: true },
    });
    const factsByUser = new Map<string, EmploymentFacts>(
      profiles.map((p) => [
        p.userId,
        {
          hireDate: dateKey(p.hireDate),
          employmentStatus: p.employmentStatus,
          probationEndsAt: dateKey(p.probationEndsAt),
        },
      ]),
    );

    for (const b of balances) {
      try {
        // Idempotency input: the POLICY-sourced keys already on the ledger.
        const existing = await db.leaveLedgerEntry.findMany({
          where: { userId: b.userId, leaveTypeId: type.id, year, sourceType: "POLICY" },
          select: { sourceId: true },
        });
        const existingKeys = new Set(existing.map((r) => r.sourceId));
        const projection = await ledgerProjection(db, b.userId, type.id, year);
        const ops = dueGrantOps({
          policy,
          employment: factsByUser.get(b.userId) ?? null,
          year,
          asOf,
          window: namedWindow,
          grantedSoFar: projection.entitled,
          availableNow: projection.available,
          existingPeriodKeys: existingKeys,
        });
        if (ops.length === 0) continue;
        await db.$transaction(async (tx) => {
          await appendGrantsTx(tx, b.userId, type.id, year, ops);
        });
        report.grantsWritten += ops.length;
      } catch (err) {
        report.failures += 1;
        const reason = err instanceof Error ? err.message : String(err);
        report.failuresDetail.push({
          userId: b.userId,
          leaveTypeId: type.id,
          leaveTypeName: type.name,
          phase: "GRANT",
          reason,
        });
        logError(`[leave-allocation] grant pair failed (user ${b.userId}, type ${type.name}):`, err);
      }
    }
  }

  logInfo(
    `[leave-allocation] pass complete (${active.name ?? `calendar year ${year}`}): ${report.grantsWritten} grant(s), ` +
      `${report.carryRowsWritten} carry row(s), ${report.expireRowsWritten} expire row(s), ` +
      `${report.failures} failure(s) at ${asOf}`,
  );
  return report;
}

/** Window-boundary rollover for one type: carry min(prevAvailable,
 * maxCarryOver) from the active window's SOURCE bucket into the active
 * window's bucket, expire the excess. Idempotent: any CARRY row already in
 * the target bucket (any source — engine or backfill) means the pair is
 * done. The source bucket: the chain predecessor's bucket (a named
 * window), else target − 1 (the implicit calendar year — the pre-P27
 * behavior, byte-identical). */
async function runRolloverForType(
  leaveTypeId: string,
  leaveTypeName: string,
  policy: ReturnType<typeof resolveLeavePolicy>,
  active: LeaveWindow,
  periods: ReadonlyArray<LeavePeriodInput>,
  report: LeaveAllocationJobReport,
): Promise<void> {
  const year = active.bucketYear;
  const sourceBucket = carrySourceBucket(periods, active) ?? year - 1;
  const prevBalances = await db.leaveBalance.findMany({
    where: { leaveTypeId, year: sourceBucket },
    select: { userId: true },
  });
  if (prevBalances.length === 0) return;

  for (const b of prevBalances) {
    try {
      const carryRow = await db.leaveLedgerEntry.findFirst({
        where: { userId: b.userId, leaveTypeId, year, entryType: "CARRY" },
        select: { id: true },
      });
      if (carryRow) continue; // already rolled over (idempotent)

      const prev = await ledgerProjection(db, b.userId, leaveTypeId, sourceBucket);
      const { carry, expire } = rolloverOps(prev.available, policy.maxCarryOver);
      if (carry <= 0 && expire >= 0) continue; // nothing to carry or expire

      await db.$transaction(async (tx) => {
        // The target-bucket cache row (create-if-missing; a unique-trio
        // race with a concurrent lazy materialization loses loudly and
        // retries on the next daily pass — never a half-written state).
        await tx.leaveBalance.upsert({
          where: { userId_leaveTypeId_year: { userId: b.userId, leaveTypeId, year } },
          create: { userId: b.userId, leaveTypeId, year, entitled: 0, carriedOver: 0, used: 0 },
          update: {},
        });
        const rows: Array<{ delta: number; entryType: string; sourceId: string; note: string }> = [];
        if (carry > 0) {
          rows.push({
            delta: carry,
            entryType: "CARRY",
            sourceId: "carry",
            note: `Carried over ${carry} day(s) from ${sourceBucket}${active.name ? ` (${active.name})` : ""} (cap ${policy.maxCarryOver})`,
          });
        }
        if (expire < 0) {
          rows.push({
            delta: expire,
            entryType: "EXPIRE",
            sourceId: "carry-expire",
            note: `Expired ${-expire} day(s) above the ${policy.maxCarryOver}-day carry cap at the window's end`,
          });
        }
        await tx.leaveLedgerEntry.createMany({
          data: rows.map((r) => ({
            userId: b.userId,
            leaveTypeId,
            year,
            delta: r.delta,
            entryType: r.entryType,
            sourceType: "POLICY",
            sourceId: r.sourceId,
            note: r.note,
            isReversal: false,
          })),
        });
        const projection = await ledgerProjection(tx, b.userId, leaveTypeId, year);
        await tx.leaveBalance.update({
          where: { userId_leaveTypeId_year: { userId: b.userId, leaveTypeId, year } },
          data: {
            entitled: projection.entitled,
            carriedOver: projection.carriedOver,
            used: Math.max(0, projection.used),
          },
        });
      });
      report.carryRowsWritten += carry > 0 ? 1 : 0;
      report.expireRowsWritten += expire < 0 ? 1 : 0;
    } catch (err) {
      report.failures += 1;
      const reason = err instanceof Error ? err.message : String(err);
      report.failuresDetail.push({ userId: b.userId, leaveTypeId, leaveTypeName, phase: "ROLLOVER", reason });
      logError(`[leave-allocation] rollover pair failed (user ${b.userId}, type ${leaveTypeId}):`, err);
    }
  }
}

/** Carry lapse for one type (carryExpiresAfterMonths): once N complete
 * months of the ACTIVE WINDOW elapsed, expire the still-unspent carried
 * days (FIFO). Idempotent: the "carry-lapse" EXPIRE row is written once.
 * P27 (LV-08): the clock counts months into the window (its start), not
 * the calendar year — identical when the window IS the calendar year. */
async function runLapseForType(
  leaveTypeId: string,
  leaveTypeName: string,
  policy: ReturnType<typeof resolveLeavePolicy>,
  active: LeaveWindow,
  report: LeaveAllocationJobReport,
): Promise<void> {
  if (policy.carryExpiresAfterMonths === null) return;
  const asOf = report.asOf;
  if (monthsIntoWindow(active.start, asOf) < policy.carryExpiresAfterMonths) return;

  const year = active.bucketYear;
  const balances = await db.leaveBalance.findMany({
    where: { leaveTypeId, year },
    select: { userId: true },
  });
  for (const b of balances) {
    try {
      const lapsed = await db.leaveLedgerEntry.findFirst({
        where: { userId: b.userId, leaveTypeId, year, sourceType: "POLICY", sourceId: "carry-lapse" },
        select: { id: true },
      });
      if (lapsed) continue;

      const projection = await ledgerProjection(db, b.userId, leaveTypeId, year);
      const delta = carryLapseDelta(projection.carriedOver, projection.used);
      if (delta >= 0) continue;

      await db.$transaction(async (tx) => {
        await tx.leaveLedgerEntry.create({
          data: {
            userId: b.userId,
            leaveTypeId,
            year,
            delta,
            entryType: "EXPIRE",
            sourceType: "POLICY",
            sourceId: "carry-lapse",
            note: `Carried days lapsed after ${policy.carryExpiresAfterMonths} month(s) of ${active.name ?? year}`,
            isReversal: false,
          },
        });
        const after = await ledgerProjection(tx, b.userId, leaveTypeId, year);
        await tx.leaveBalance.update({
          where: { userId_leaveTypeId_year: { userId: b.userId, leaveTypeId, year } },
          data: {
            entitled: after.entitled,
            carriedOver: after.carriedOver,
            used: Math.max(0, after.used),
          },
        });
      });
      report.expireRowsWritten += 1;
    } catch (err) {
      report.failures += 1;
      const reason = err instanceof Error ? err.message : String(err);
      report.failuresDetail.push({ userId: b.userId, leaveTypeId, leaveTypeName, phase: "LAPSE", reason });
      logError(`[leave-allocation] lapse pair failed (user ${b.userId}, type ${leaveTypeId}):`, err);
    }
  }
}

// ---------------------------------------------------------------------------
// P21 (LV-B18) — the failure alarm, lifted here from the standalone route
// (P26: the daily dispatcher carries the leave pass beside its own route,
// so both callers must reach the same alarm; route files may not export
// non-handler functions under Next.js's strict route typing).
//
// When a pass recorded failures, ONE LEAVE_JOB_FAILURE outbox row per
// ADMIN+HR user carries every per-pair reason (the row IS the retained
// failure record; delivery is best-effort — an unconfigured mailer leaves
// the auditable row). Unconditional by design: a failure alarm is
// operational telemetry, not a routine mail side effect (the F-R17 posture
// is scoped to the request/decision notifications). NEVER throws into the
// caller — every step is best-effort, the report already told the
// scheduler the truth and this row makes the failure durable and visible
// to HR.
// ---------------------------------------------------------------------------

export async function sendLeaveJobFailureAlarm(report: LeaveAllocationJobReport): Promise<void> {
  const recipients = await db.user.findMany({
    where: { role: { in: ["ADMIN", "HR"] }, deletedAt: null, NOT: { email: "" } },
    select: { email: true },
    take: 50, // a workspace with >50 admins+HR is a config smell; bounds the fan-out
  });
  const text = leaveJobFailureEmailText(report.asOf, report.failuresDetail);
  const rowIds: string[] = [];
  for (const r of recipients) {
    const row = await queueOutboxMail(db, {
      kind: "LEAVE_JOB_FAILURE",
      toAddress: r.email,
      subject: leaveJobFailureEmailSubject(),
      text,
      sentById: "cron:leave-allocation",
    });
    rowIds.push(row.id);
  }
  for (const id of rowIds) {
    const row = await db.mailOutbox.findUnique({
      where: { id },
      select: { toAddress: true, subject: true, body: true },
    });
    if (!row) continue;
    await deliverOutboxMail(id, {
      toAddress: row.toAddress,
      subject: row.subject,
      html: leaveEmailHtml(row.body),
      text: row.body,
    }).catch((err: unknown) => logError("[leave-allocation] alarm delivery failed:", err));
  }
}
