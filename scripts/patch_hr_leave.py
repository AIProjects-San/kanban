#!/usr/bin/env python3
"""F1.2 — patch hr-leave.ts: F-R4 working-day notice (holiday-aware), the
approve path's ledger-truth guard + CONSUME row + cache sync, and the cancel
path's reversal row + cache sync. Precise string replacements; fails loudly
on a missing anchor."""

from pathlib import Path

F = Path("/home/z/my-project/kanban/src/server-actions/hr-leave.ts")
src = F.read_text(encoding="utf-8")

# --- Patch 1: imports — the two new hr-shared helpers ---
OLD1 = """  getApproverIdsFor,
  assertLeaveDecider,
  getOrCreateBalance,
  getOrCreateBalancesBatch,
  findOverlappingActiveRequest,
  getHolidayLookup,
  getHolidayRows,
  deriveOnLeaveAttendance,
  removeDerivedOnLeaveAttendance,
} from "./hr-shared";"""
NEW1 = """  getApproverIdsFor,
  assertLeaveDecider,
  getOrCreateBalance,
  getOrCreateBalancesBatch,
  findOverlappingActiveRequest,
  getHolidayLookup,
  getHolidayRows,
  ledgerProjectionFor,
  materializeLeaveBalanceTx,
  deriveOnLeaveAttendance,
  removeDerivedOnLeaveAttendance,
} from "./hr-shared";"""
assert src.count(OLD1) == 1, f"anchor 1 count = {src.count(OLD1)}"
src = src.replace(OLD1, NEW1)

# --- Patch 2: F-R4 — working-day notice, holiday-aware ---
OLD2 = """    // F1.1 — holiday-aware count: weekends never count, holiday-calendar
    // entries on weekdays are excluded (half-days count 0.5). Denormalized
    // onto the request below and never re-derived.
    const holidays = await getHolidayLookup(start, end);
    const days = workingDaysBetween(start, end, holidays);
    if (days <= 0) {
      throw new AuthorizationError("That range contains no working days (Mon–Fri, holidays excluded).");
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
      }"""
NEW2 = """    // F1.1 — holiday-aware count: weekends never count, holiday-calendar
    // entries on weekdays are excluded (half-days count 0.5). Denormalized
    // onto the request below and never re-derived.
    // F-R4 — the notice window needs the same holiday awareness, so a NEAR
    // start (within the notice window below) widens this one read to include
    // today→start; a far start keeps the read scoped to the request's own
    // range (the read contract the F1.1 tests pin).
    const today = todayUTC();
    const noticeFrom = new Date(today.getTime() + 86_400_000);
    const gap = daysBetween(today, start);
    // 3N+1 calendar days always contain at least N working days — beyond
    // this window the calendar gap alone guarantees the notice minimum, so
    // the precise (holiday-aware) count is unnecessary.
    const noticeWindow =
      type.policy && type.policy.minNoticeDays > 0 ? type.policy.minNoticeDays * 3 + 1 : 0;
    const nearStart = gap >= 1 && gap <= noticeWindow;
    const holidays = await getHolidayLookup(nearStart ? noticeFrom : start, end);
    const days = workingDaysBetween(start, end, holidays);
    if (days <= 0) {
      throw new AuthorizationError("That range contains no working days (Mon–Fri, holidays excluded).");
    }

    // Policy guard rails — each check rejects with a specific message so the
    // UI can tell the member exactly which rail they hit.
    const policy = type.policy;
    if (policy) {
      // F-R4 — notice counts WORKING days (Mon–Fri, holiday-aware), as the
      // LeavePolicy.minNoticeDays contract has always promised: working days
      // in (today, start] — today itself is the day the request is filed,
      // not a day of notice. Far starts skip the precise count (the calendar
      // gap already exceeds the window above); past/today starts read as a
      // non-positive gap and fail exactly as they always have.
      const notice = nearStart
        ? workingDaysBetween(noticeFrom, start, holidays)
        : gap;
      if (notice < policy.minNoticeDays) {
        throw new AuthorizationError(
          `${type.name} requires at least ${policy.minNoticeDays} working day(s) of notice — the start date is too soon.`,
        );
      }"""
assert src.count(OLD2) == 1, f"anchor 2 count = {src.count(OLD2)}"
src = src.replace(OLD2, NEW2)

# --- Patch 3: approve path — header comment rewrite ---
OLD3 = """    if (data.decision === "APPROVE") {
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
      // message the UI can show as a normal (retryable) failure."""
NEW3 = """    if (data.decision === "APPROVE") {
      // F1.2 — `used` changes here and in cancel, transactionally, through
      // an append-only CONSUME ledger row (never a cache mutation on its
      // own): the LeaveLedgerEntry is the source of truth, and the
      // LeaveBalance cache is re-synced from the ledger projection inside
      // the same transaction.
      //
      // QA-1 (overdraft guard): the balance is re-validated at approval
      // time, INSIDE the transaction, against the LEDGER aggregate — not the
      // cache this write is about to update. At submission each of two
      // non-overlapping requests can individually pass the check, so the
      // second approval must refuse (not blindly debit) once the first one
      // has consumed the remaining days.
      //
      // QA-16: the PENDING precheck above runs BEFORE this write. Two tabs
      // (or two deciders) can both pass it; without a status guard in the
      // WHERE clause both "win" and the balance is debited TWICE (or an
      // approve/reject interleave leaves a REJECTED row with debited days).
      // The guarded updateMany flips the row atomically; a zero count means
      // someone else won the race — abort BEFORE any ledger write, with a
      // message the UI can show as a normal (retryable) failure."""
assert src.count(OLD3) == 1, f"anchor 3 count = {src.count(OLD3)}"
src = src.replace(OLD3, NEW3)

# --- Patch 4: approve path — the ledger body (replaces the read-then-write) ---
OLD4 = """        const row = await tx.leaveBalance.findUnique({
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
        });"""
NEW4 = """        // F1.2 — materialize the balance row + its GRANT ledger row when
        // missing (check-then-create: a unique-trio race aborts the
        // transaction loudly — the decider retries — instead of the old
        // try/catch-re-read, which silently swallowed into a Postgres
        // aborted-transaction state; a materialized row without its ledger
        // explanation can never exist).
        await materializeLeaveBalanceTx(
          tx, request.userId, request.leaveTypeId, year,
        );

        // QA-1: the guard reads the LEDGER projection (one groupBy
        // aggregate). `available` is Σ(all deltas) — entitlement, carry,
        // adjustments and consumption in one number the cache cannot lie
        // about.
        const projection = await ledgerProjectionFor(
          tx, request.userId, request.leaveTypeId, year,
        );
        if (request.days > projection.available) {
          throw new AuthorizationError(
            `Insufficient balance: ${request.days} day(s) requested, only ${projection.available} day(s) left for ${type?.name ?? "this leave type"}.`,
          );
        }

        // The consumption row — append-only (F1.2). One row per approval,
        // double-book-proof via the guarded status flip above; its undo (a
        // cancel) will be a sibling reversal row, never an edit or delete.
        await tx.leaveLedgerEntry.create({
          data: {
            userId: request.userId,
            leaveTypeId: request.leaveTypeId,
            year,
            delta: -request.days,
            entryType: "CONSUME",
            sourceType: "LEAVE_REQUEST",
            sourceId: request.id,
            note: `${type?.name ?? "Leave"} ${request.startDate.toISOString().slice(0, 10)} → ${request.endDate.toISOString().slice(0, 10)} (${request.days} d)`,
            isReversal: false,
          },
        });

        // Cache sync — an ABSOLUTE set from the projection (QA-1b's atomic
        // increment, superseded): the ledger row above is the truth, and an
        // absolute set also heals any drift the cache row carried.
        await tx.leaveBalance.update({
          where: { userId_leaveTypeId_year: { userId: request.userId, leaveTypeId: request.leaveTypeId, year } },
          data: { used: projection.used + request.days },
        });"""
assert src.count(OLD4) == 1, f"anchor 4 count = {src.count(OLD4)}"
src = src.replace(OLD4, NEW4)

# --- Patch 5: cancel APPROVED path — comment header ---
OLD5 = """      // Give the days back — transactional with the status flip, and atomic
      // (QA-1b): decrement by at most what is actually used so a drifted
      // balance can never go below zero.
      // QA-16: the status precheck above ran BEFORE this write — two tabs
      // cancelling the same APPROVED request both passed it and the second
      // restore was a double refund. The guarded updateMany makes a stale
      // cancel a zero-row update that aborts BEFORE the decrement."""
NEW5 = """      // Give the days back — transactional with the status flip. F1.2: the
      // refund is an append-only CONSUME reversal row (the approval row's
      // undo — the pair nets to zero in the ledger), and the cache sync
      // below clamps at zero so a drifted cache can never go below it.
      // QA-16: the status precheck above ran BEFORE this write — two tabs
      // cancelling the same APPROVED request both passed it and the second
      // restore was a double refund. The guarded updateMany makes a stale
      // cancel a zero-row update that aborts BEFORE the reversal."""
assert src.count(OLD5) == 1, f"anchor 5 count = {src.count(OLD5)}"
src = src.replace(OLD5, NEW5)

# --- Patch 6: cancel APPROVED path — reversal row + cache sync ---
OLD6 = """        const balance = await tx.leaveBalance.findUnique({
          where: { userId_leaveTypeId_year: { userId: request.userId, leaveTypeId: request.leaveTypeId, year } },
        });
        if (balance) {
          await tx.leaveBalance.update({
            where: { userId_leaveTypeId_year: { userId: request.userId, leaveTypeId: request.leaveTypeId, year } },
            data: { used: { decrement: Math.min(request.days, balance.used) } },
          });
        }"""
NEW6 = """        // F1.2 — the reversal row: append-only undo of the approval's
        // CONSUME entry. `used` lands exactly where the old decrement put
        // it (the pair nets to zero), but now BOTH events survive as rows —
        // the ledger's story of "approved then cancelled" is auditable.
        await tx.leaveLedgerEntry.create({
          data: {
            userId: request.userId,
            leaveTypeId: request.leaveTypeId,
            year,
            delta: request.days,
            entryType: "CONSUME",
            sourceType: "LEAVE_REQUEST",
            sourceId: request.id,
            note: `Reversal: approved request cancelled (${request.days} d returned)`,
            isReversal: true,
          },
        });

        // Cache sync — absolute set from the post-reversal projection,
        // clamped at zero (the old min() decrement's guarantee, kept).
        const projection = await ledgerProjectionFor(
          tx, request.userId, request.leaveTypeId, year,
        );
        await tx.leaveBalance.update({
          where: { userId_leaveTypeId_year: { userId: request.userId, leaveTypeId: request.leaveTypeId, year } },
          data: { used: Math.max(0, projection.used) },
        });"""
assert src.count(OLD6) == 1, f"anchor 6 count = {src.count(OLD6)}"
src = src.replace(OLD6, NEW6)

F.write_text(src, encoding="utf-8")
print("patched hr-leave.ts OK —", len(src), "bytes")
