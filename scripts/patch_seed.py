#!/usr/bin/env python3
"""F1.2 — patch scripts/seed.js: ledger cleanup, GRANT rows for materialized
entitlements, and the CONSUME/reversal story for the seeded leave requests
("seed mirrors production math"). Precise string replacements."""

from pathlib import Path

F = Path("/home/z/my-project/kanban/scripts/seed.js")
src = F.read_text(encoding="utf-8")

# --- Patch 1: cleanup list — ledger rows go with the leave rows ---
OLD1 = """  await db.leaveRequest.deleteMany();
  await db.leaveBalance.deleteMany();"""
NEW1 = """  await db.leaveRequest.deleteMany();
  await db.leaveBalance.deleteMany();
  await db.leaveLedgerEntry.deleteMany();"""
assert src.count(OLD1) == 1, f"anchor 1 count = {src.count(OLD1)}"
src = src.replace(OLD1, NEW1)

# --- Patch 1b: Yuki's APPROVED 1-day request must show in her cache `used`
# (the request comment says "1 day used" but the value was never set —
# F1.2's used == -ΣCONSUME invariant makes the omission a real violation). ---
OLD1B = """  const rafaelId = userByName.get("Rafael Costa");
  if (rafaelId) {
    await db.leaveBalance.update({
      where: { userId_leaveTypeId_year: { userId: rafaelId, leaveTypeId: annualType.id, year: YEAR } },
      data: { used: 5 },
    });
  }
"""
NEW1B = """  const rafaelId = userByName.get("Rafael Costa");
  if (rafaelId) {
    await db.leaveBalance.update({
      where: { userId_leaveTypeId_year: { userId: rafaelId, leaveTypeId: annualType.id, year: YEAR } },
      data: { used: 5 },
    });
  }
  // Yuki's APPROVED single day (below) consumes 1 — the cache `used` must
  // match the request rows the F1.2 ledger backfills from (invariant:
  // used == -Σ CONSUME deltas).
  const yukiId = userByName.get("Yuki Tanaka");
  if (yukiId) {
    await db.leaveBalance.update({
      where: { userId_leaveTypeId_year: { userId: yukiId, leaveTypeId: annualType.id, year: YEAR } },
      data: { used: 1 },
    });
  }
"""
assert src.count(OLD1B) == 1, f"anchor 1b count = {src.count(OLD1B)}"
src = src.replace(OLD1B, NEW1B)

# --- Patch 2: after the request rows exist, write the ledger story ---
OLD2 = """  console.log(`  ✓ HR leave: 3 types + policies, balances for ${allUsers.length} users, ${leaveRequests.length} requests across all statuses (YEAR ${YEAR})`);"""
NEW2 = """  // -------------------------------------------------------------------------
  // F1.2 — leave ledger seed (docs/Fernly_HR_Payroll_Enhancement_Plan.md
  // §7.1). Mirrors the production write paths exactly ("seed mirrors
  // production math"):
  //   • one GRANT row per materialized nonzero entitlement (the
  //     getOrCreateBalance/getOrCreateBalancesBatch twin);
  //   • one CONSUME row per APPROVED request (the approve-path twin);
  //   • Amara's cancelled-after-approval request gets BOTH the original
  //     consumption and its isReversal sibling (the cancel-path twin) —
  //     net zero, same as her seeded used=0.
  // Rafael's used=5 and Yuki's used=1 are reproduced by their CONSUME rows,
  // not by a cache-only update: the ledger IS the story.
  // -------------------------------------------------------------------------
  const grantRows = [];
  const grant = (userId, type, entitled) => {
    if (entitled === 0) return;
    grantRows.push({
      userId, leaveTypeId: type.id, year: YEAR, delta: entitled,
      entryType: "GRANT", sourceType: "POLICY", sourceId: type.id,
      note: `Annual entitlement ${YEAR} (${entitled} days)`, isReversal: false,
    });
  };
  for (const u of allUsers) {
    grant(u.id, annualType, 20);
    grant(u.id, sickType, 10);
    grant(u.id, unpaidType, 0);
  }
  const consumeRows = [];
  for (const r of leaveRequests) {
    if (r.status !== "APPROVED" && r.status !== "CANCELLED") continue;
    // Only requests that were APPROVED at some point consume (the seed's
    // CANCELLED rows are all cancelled-after-approval — decidedBy set).
    if (!r.decidedById) continue;
    consumeRows.push({
      userId: r.userId, leaveTypeId: r.leaveTypeId, year: YEAR, delta: -r.days,
      entryType: "CONSUME", sourceType: "LEAVE_REQUEST", sourceId: r.id,
      note: `Seeded approved request (${r.days} d)`, isReversal: false,
    });
    if (r.status === "CANCELLED") {
      consumeRows.push({
        userId: r.userId, leaveTypeId: r.leaveTypeId, year: YEAR, delta: r.days,
        entryType: "CONSUME", sourceType: "LEAVE_REQUEST", sourceId: r.id,
        note: `Reversal: approved request cancelled (${r.days} d returned)`,
        isReversal: true,
      });
    }
  }
  if (grantRows.length || consumeRows.length) {
    await db.leaveLedgerEntry.createMany({
      data: [...grantRows, ...consumeRows],
    });
  }

  console.log(`  ✓ HR leave: 3 types + policies, balances for ${allUsers.length} users, ${leaveRequests.length} requests across all statuses (YEAR ${YEAR}); ledger: ${grantRows.length} GRANT + ${consumeRows.length} CONSUME/reversal rows`);"""
assert src.count(OLD2) == 1, f"anchor 2 count = {src.count(OLD2)}"
src = src.replace(OLD2, NEW2)

F.write_text(src, encoding="utf-8")
print("patched seed.js OK —", len(src), "bytes")
