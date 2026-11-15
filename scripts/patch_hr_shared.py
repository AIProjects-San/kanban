#!/usr/bin/env python3
"""F1.2 — patch hr-shared.ts: transactional GRANT co-write in getOrCreateBalance,
batch GRANT co-write in getOrCreateBalancesBatch, and the new ledger helpers
(ledgerProjectionFor + materializeLeaveBalanceTx). Applied as precise string
replacements; fails loudly if an anchor is missing."""

from pathlib import Path

F = Path("/home/z/my-project/kanban/src/server-actions/hr-shared.ts")
src = F.read_text(encoding="utf-8")

# --- Patch 1: getOrCreateBalance — create balance + GRANT ledger row in one tx ---
OLD1 = """  if (existing) return existing;
  // No row yet — materialize the entitlement from the policy default.
  await db.leaveBalance.create({
    data: { userId, leaveTypeId, year, entitled: defaultEntitled, carriedOver: 0, used: 0 },
  }).catch((err) => {
    // Unique-trio race with a concurrent reader: read the winner's row.
    // PR-22 — this catch was previously completely silent; log it so a
    // persistent (non-race) failure is visible in the log stream.
    logError("[hr-shared] leave balance materialize raced with a concurrent create:", err);
  });"""
NEW1 = """  if (existing) return existing;
  // No row yet — materialize the entitlement from the policy default AND
  // the GRANT ledger row that explains it, in ONE transaction (F1.2: a
  // balance row must never exist without its ledger rows).
  await db
    .$transaction(async (tx) => {
      await tx.leaveBalance.create({
        data: { userId, leaveTypeId, year, entitled: defaultEntitled, carriedOver: 0, used: 0 },
      });
      if (defaultEntitled !== 0) {
        await tx.leaveLedgerEntry.create({
          data: {
            userId,
            leaveTypeId,
            year,
            delta: defaultEntitled,
            entryType: "GRANT",
            sourceType: "POLICY",
            sourceId: leaveTypeId,
            note: `Entitlement materialized (${defaultEntitled} days)`,
            isReversal: false,
          },
        });
      }
    })
    .catch((err) => {
      // Unique-trio race with a concurrent reader: read the winner's row
      // (the winner's transaction wrote its GRANT row too — both-or-neither
      // is the point of the shared transaction).
      // PR-22 — log it so a persistent (non-race) failure is visible.
      logError("[hr-shared] leave balance materialize raced with a concurrent create:", err);
    });"""

assert src.count(OLD1) == 1, f"anchor 1 count = {src.count(OLD1)}"
src = src.replace(OLD1, NEW1)

# --- Patch 2: getOrCreateBalancesBatch — balance createMany + GRANT createMany in one tx ---
OLD2 = """  const missing = types.filter((t) => !byType.has(t.id));
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
    });"""
NEW2 = """  const missing = types.filter((t) => !byType.has(t.id));
  if (missing.length > 0) {
    // Materialize missing rows TOGETHER with their GRANT ledger rows in one
    // transaction (F1.2 — a cache row without its ledger explanation must
    // never exist). createMany without skipDuplicates (unsupported on
    // SQLite) — a unique-trio race with a concurrent reader loses the whole
    // transaction and is handled by the re-read below (same contract as
    // getOrCreateBalance).
    await db
      .$transaction(async (tx) => {
        await tx.leaveBalance.createMany({
          data: missing.map((t) => ({
            userId, leaveTypeId: t.id, year, entitled: t.entitled, carriedOver: 0, used: 0,
          })),
        });
        const grants = missing.filter((t) => t.entitled !== 0);
        if (grants.length > 0) {
          await tx.leaveLedgerEntry.createMany({
            data: grants.map((t) => ({
              userId,
              leaveTypeId: t.id,
              year,
              delta: t.entitled,
              entryType: "GRANT",
              sourceType: "POLICY",
              sourceId: t.id,
              note: `Entitlement materialized (${t.entitled} days)`,
              isReversal: false,
            })),
          });
        }
      })
      .catch((err) => {
        logError("[hr-shared] balance batch materialize raced with a concurrent create:", err);
      });"""
assert src.count(OLD2) == 1, f"anchor 2 count = {src.count(OLD2)}"
src = src.replace(OLD2, NEW2)

# --- Patch 3: append the F1.2 ledger helpers after getOrCreateBalancesBatch ---
# Anchor: the end of getOrCreateBalancesBatch (its final return + closing brace)
OLD3 = """  for (const t of types) {
    const row = byType.get(t.id);
    result.set(t.id, row ?? { entitled: t.entitled, carriedOver: 0, used: 0 });
  }
  return result;
}
"""
NEW3 = """  for (const t of types) {
    const row = byType.get(t.id);
    result.set(t.id, row ?? { entitled: t.entitled, carriedOver: 0, used: 0 });
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
  "leaveBalance" | "leaveLedgerEntry" | "leavePolicy"
>;

/**
 * Materialize the balance row + its GRANT ledger row INSIDE the caller's
 * transaction when the row is missing (the approve path's fail-closed
 * default, mirroring the old inline logic's semantics). Deliberately NOT
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
  const policy = await tx.leavePolicy.findUnique({
    where: { leaveTypeId },
    select: { annualDays: true },
  });
  const entitled = policy?.annualDays ?? 0;
  await tx.leaveBalance.create({
    data: { userId, leaveTypeId, year, entitled, carriedOver: 0, used: 0 },
  });
  if (entitled !== 0) {
    await tx.leaveLedgerEntry.create({
      data: {
        userId,
        leaveTypeId,
        year,
        delta: entitled,
        entryType: "GRANT",
        sourceType: "POLICY",
        sourceId: leaveTypeId,
        note: `Entitlement materialized (${entitled} days)`,
        isReversal: false,
      },
    });
  }
}
"""
assert src.count(OLD3) == 1, f"anchor 3 count = {src.count(OLD3)}"
src = src.replace(OLD3, NEW3)

F.write_text(src, encoding="utf-8")
print("patched hr-shared.ts OK —", len(src), "bytes")
