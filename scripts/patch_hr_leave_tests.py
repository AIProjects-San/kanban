#!/usr/bin/env python3
"""F1.2 — patch hr-leave.test.ts: mock the ledger model + groupBy, retarget
the approve/cancel assertions at the ledger writes, rewrite the
approve-path race test for the new fail-loud semantics, and add the F1.2
invariant + F-R4 notice tests. Anchors are verified against file bytes."""

from pathlib import Path

F = Path("/home/z/my-project/kanban/src/server-actions/__tests__/hr-leave.test.ts")
src = F.read_text(encoding="utf-8")


def rep(old: str, new: str, label: str, count: int = 1) -> None:
    global src
    assert src.count(old) == count, f"{label}: anchor count = {src.count(old)} (expected {count})"
    src = src.replace(old, new)


# --- T1: mock models list — the ledger model ---
rep(
    '''  const models = [
    "leaveRequest", "leaveType", "leavePolicy", "leaveBalance",
    "user", "auditLog", "notification", "holidayCalendarEntry",
    "attendanceRecord",
  ];''',
    '''  const models = [
    "leaveRequest", "leaveType", "leavePolicy", "leaveBalance",
    "leaveLedgerEntry",
    "user", "auditLog", "notification", "holidayCalendarEntry",
    "attendanceRecord",
  ];''',
    "T1 models",
)

# --- T2: mock methods list — groupBy for the ledger aggregate ---
rep(
    '''  const methods = [
    "findMany", "findUnique", "findFirst", "create", "createMany", "update",
    "updateMany", "delete", "deleteMany", "upsert", "count", "aggregate",
  ];''',
    '''  const methods = [
    "findMany", "findUnique", "findFirst", "create", "createMany", "update",
    "updateMany", "delete", "deleteMany", "upsert", "count", "aggregate",
    "groupBy",
  ];''',
    "T2 methods",
)

# --- T3: beforeEach defaults — the ledger aggregate + ledger writes ---
rep(
    '''  db.leaveBalance.create.mockResolvedValue({});
  db.leaveBalance.createMany.mockResolvedValue({ count: 0 });
  db.leaveBalance.update.mockResolvedValue({});''',
    '''  db.leaveBalance.create.mockResolvedValue({});
  db.leaveBalance.createMany.mockResolvedValue({ count: 0 });
  db.leaveBalance.update.mockResolvedValue({});
  // F1.2 — the ledger aggregate the approve-time guard reads (one groupBy:
  // entryType + summed delta). Default: a plain 20-day GRANT, nothing
  // consumed — individual tests seed GRANT + CONSUME groups to pin the
  // guard math.
  db.leaveLedgerEntry.groupBy.mockResolvedValue([
    { entryType: "GRANT", _sum: { delta: 20 } },
  ]);
  db.leaveLedgerEntry.create.mockResolvedValue({ id: "lle-1" });
  db.leaveLedgerEntry.createMany.mockResolvedValue({ count: 0 });''',
    "T3 defaults",
)

# --- T4: approve happy test — ledger row + absolute cache set ---
rep(
    '''  it("approves: flips status and increments used inside a transaction", async () => {
    requirePermissionMock.mockResolvedValue(MANAGER_AUTH);
    db.leaveRequest.findUnique.mockResolvedValue(PENDING_REQUEST);
    db.user.findUnique.mockResolvedValue({ managerId: "u-mgr" }); // requester's manager
    db.leaveBalance.findUnique.mockResolvedValue({ entitled: 20, carriedOver: 0, used: 0 });

    const res = await decideLeaveRequest({ requestId: "lr-1", decision: "APPROVE", note: "Enjoy" });
    expect(res.ok).toBe(true);
    // Atomic increment (QA-1b): the value is computed by the DB, not by a
    // read-modify-write outside the transaction (lost-update race).
    expect(db.leaveBalance.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { used: { increment: 2 } } }),
    );''',
    '''  it("approves: flips status, writes a CONSUME ledger row, and syncs the cache inside a transaction", async () => {
    requirePermissionMock.mockResolvedValue(MANAGER_AUTH);
    db.leaveRequest.findUnique.mockResolvedValue(PENDING_REQUEST);
    db.user.findUnique.mockResolvedValue({ managerId: "u-mgr" }); // requester's manager
    db.leaveBalance.findUnique.mockResolvedValue({ entitled: 20, carriedOver: 0, used: 0 });

    const res = await decideLeaveRequest({ requestId: "lr-1", decision: "APPROVE", note: "Enjoy" });
    expect(res.ok).toBe(true);
    // F1.2 — the consumption row: append-only truth, one per approval,
    // double-book-proof via the guarded status flip.
    expect(db.leaveLedgerEntry.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: "u-theo",
          leaveTypeId: "lt-annual",
          delta: -2,
          entryType: "CONSUME",
          sourceType: "LEAVE_REQUEST",
          sourceId: "lr-1",
          isReversal: false,
        }),
      }),
    );
    // Cache sync — ABSOLUTE set from the ledger projection (QA-1b's atomic
    // increment, superseded): 0 used + 2 days = 2, and any drift heals.
    expect(db.leaveBalance.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { used: 2 } }),
    );''',
    "T4 approve happy",
)

# --- T5: QA-1 overdraft — the guard reads the ledger aggregate now ---
rep(
    '''    // Entitled 20, 15 already used by a previously approved request → 5 left.
    db.leaveBalance.findUnique.mockResolvedValue({ entitled: 20, carriedOver: 0, used: 15 });

    const res = await decideLeaveRequest({ requestId: "lr-1", decision: "APPROVE" });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/insufficient balance/i);
    expect(res.ok === false && res.error).toMatch(/5 day/i);
    // Neither the balance nor the request may change on the refused path —
    // the guarded flip inside the transaction is rolled back with it
    // (QA-16), so no debit ever lands.
    expect(db.leaveBalance.update).not.toHaveBeenCalled();''',
    '''    // Entitled 20, 15 already consumed by previously approved requests →
    // 5 left. F1.2: the guard reads the LEDGER aggregate (GRANT 20,
    // CONSUME −15 → available 5), not the cache it is about to write.
    db.leaveLedgerEntry.groupBy.mockResolvedValue([
      { entryType: "GRANT", _sum: { delta: 20 } },
      { entryType: "CONSUME", _sum: { delta: -15 } },
    ]);

    const res = await decideLeaveRequest({ requestId: "lr-1", decision: "APPROVE" });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/insufficient balance/i);
    expect(res.ok === false && res.error).toMatch(/5 day/i);
    // Neither the ledger nor the cache may change on the refused path —
    // the guarded flip inside the transaction is rolled back with it
    // (QA-16), so no debit ever lands.
    expect(db.leaveLedgerEntry.create).not.toHaveBeenCalled();
    expect(db.leaveBalance.update).not.toHaveBeenCalled();''',
    "T5 QA-1 overdraft",
)

# --- T6: QA-1 boundary — ledger aggregate + absolute set ---
rep(
    '''    db.leaveBalance.findUnique.mockResolvedValue({ entitled: 20, carriedOver: 0, used: 15 });

    const res = await decideLeaveRequest({ requestId: "lr-1", decision: "APPROVE" });
    expect(res.ok).toBe(true);
    expect(db.leaveBalance.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { used: { increment: 5 } } }),
    );
  });''',
    '''    db.leaveLedgerEntry.groupBy.mockResolvedValue([
      { entryType: "GRANT", _sum: { delta: 20 } },
      { entryType: "CONSUME", _sum: { delta: -15 } },
    ]);

    const res = await decideLeaveRequest({ requestId: "lr-1", decision: "APPROVE" });
    expect(res.ok).toBe(true);
    expect(db.leaveLedgerEntry.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ delta: -5, entryType: "CONSUME" }),
      }),
    );
    expect(db.leaveBalance.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { used: 20 } }),
    );
  });''',
    "T6 QA-1 boundary",
)

# --- T7: QA-1 materialize — GRANT row + ledger-guard numbers ---
rep(
    '''    db.leaveBalance.findUnique.mockResolvedValue(null); // never materialized
    db.leavePolicy.findUnique.mockResolvedValue({ annualDays: 10 });
    db.leaveBalance.create.mockResolvedValue({});

    const res = await decideLeaveRequest({ requestId: "lr-1", decision: "APPROVE" });
    expect(res.ok).toBe(true);
    expect(db.leaveBalance.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ entitled: 10, used: 0 }) }),
    );
    expect(db.leaveBalance.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { used: { increment: 2 } } }),
    );
  });''',
    '''    db.leaveBalance.findUnique.mockResolvedValue(null); // never materialized
    db.leavePolicy.findUnique.mockResolvedValue({ annualDays: 10 });
    db.leaveBalance.create.mockResolvedValue({});
    // The ledger the post-materialize guard projects: GRANT 10, nothing
    // consumed → 10 available for the 2-day request.
    db.leaveLedgerEntry.groupBy.mockResolvedValue([
      { entryType: "GRANT", _sum: { delta: 10 } },
    ]);

    const res = await decideLeaveRequest({ requestId: "lr-1", decision: "APPROVE" });
    expect(res.ok).toBe(true);
    expect(db.leaveBalance.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ entitled: 10, used: 0 }) }),
    );
    // The materialization also wrote its GRANT ledger row (F1.2: a balance
    // row must never exist without the ledger rows that explain it).
    expect(db.leaveLedgerEntry.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: "u-theo",
          leaveTypeId: "lt-annual",
          delta: 10,
          entryType: "GRANT",
          sourceType: "POLICY",
          isReversal: false,
        }),
      }),
    );
    // ...then the consumption row and the cache sync.
    expect(db.leaveLedgerEntry.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ delta: -2, entryType: "CONSUME", sourceId: "lr-1" }),
      }),
    );
    expect(db.leaveBalance.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { used: 2 } }),
    );
  });''',
    "T7 QA-1 materialize",
)

# --- T8: QA-16 concurrent approve — no ledger write either ---
rep(
    '''    const res = await decideLeaveRequest({ requestId: "lr-1", decision: "APPROVE" });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.code).toBe("AUTH");
    expect(res.ok === false && res.error).toMatch(/no longer pending|already/i);
    // The transaction aborted before the debit — used was never incremented.
    expect(db.leaveBalance.update).not.toHaveBeenCalled();
  });''',
    '''    const res = await decideLeaveRequest({ requestId: "lr-1", decision: "APPROVE" });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.code).toBe("AUTH");
    expect(res.ok === false && res.error).toMatch(/no longer pending|already/i);
    // The transaction aborted before the debit — no ledger row, no cache
    // write (F1.2 makes "no debit" two assertions, not one).
    expect(db.leaveLedgerEntry.create).not.toHaveBeenCalled();
    expect(db.leaveBalance.update).not.toHaveBeenCalled();
  });''',
    "T8 QA-16 approve race",
)

# --- T9: cancel APPROVED — reversal row + absolute set ---
rep(
    '''  it("cancelling an APPROVED request restores the balance", async () => {
    requirePermissionMock.mockResolvedValue(MEMBER_AUTH);
    db.leaveRequest.findUnique.mockResolvedValue({ ...PENDING_REQUEST, status: "APPROVED" });
    db.leaveBalance.findUnique.mockResolvedValue({ entitled: 20, carriedOver: 0, used: 2 });
    const res = await cancelLeaveRequest({ requestId: "lr-1" });
    expect(res.ok).toBe(true);
    // Atomic decrement (QA-1b) — the restore mirrors the approve increment.
    expect(db.leaveBalance.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { used: { decrement: 2 } } }),
    );''',
    '''  it("cancelling an APPROVED request writes the reversal row and restores the balance", async () => {
    requirePermissionMock.mockResolvedValue(MEMBER_AUTH);
    db.leaveRequest.findUnique.mockResolvedValue({ ...PENDING_REQUEST, status: "APPROVED" });
    db.leaveBalance.findUnique.mockResolvedValue({ entitled: 20, carriedOver: 0, used: 2 });
    // Post-reversal ledger: the −2 consumption and its +2 reversal net to
    // zero → the projection says used 0.
    db.leaveLedgerEntry.groupBy.mockResolvedValue([
      { entryType: "GRANT", _sum: { delta: 20 } },
      { entryType: "CONSUME", _sum: { delta: 0 } },
    ]);
    const res = await cancelLeaveRequest({ requestId: "lr-1" });
    expect(res.ok).toBe(true);
    // F1.2 — the reversal row: append-only undo of the approval's CONSUME
    // entry (the pair nets to zero; both events survive as rows).
    expect(db.leaveLedgerEntry.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: "u-theo",
          leaveTypeId: "lt-annual",
          delta: 2,
          entryType: "CONSUME",
          sourceType: "LEAVE_REQUEST",
          sourceId: "lr-1",
          isReversal: true,
        }),
      }),
    );
    // Cache sync — absolute set from the post-reversal projection.
    expect(db.leaveBalance.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { used: 0 } }),
    );''',
    "T9 cancel restore",
)

# --- T10: QA-1 floors — ledger projection clamps at zero ---
rep(
    '''    db.leaveRequest.findUnique.mockResolvedValue({ ...PENDING_REQUEST, status: "APPROVED" });
    db.leaveBalance.findUnique.mockResolvedValue({ entitled: 20, carriedOver: 0, used: 1 });
    const res = await cancelLeaveRequest({ requestId: "lr-1" });
    expect(res.ok).toBe(true);
    expect(db.leaveBalance.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { used: { decrement: 1 } } }),
    );
  });''',
    '''    db.leaveRequest.findUnique.mockResolvedValue({ ...PENDING_REQUEST, status: "APPROVED" });
    db.leaveBalance.findUnique.mockResolvedValue({ entitled: 20, carriedOver: 0, used: 1 });
    // Post-reversal ledger nets to +1 CONSUME (−1 drift + 2 reversal) —
    // the projection says used −1, and the clamp floors the cache at 0.
    db.leaveLedgerEntry.groupBy.mockResolvedValue([
      { entryType: "GRANT", _sum: { delta: 20 } },
      { entryType: "CONSUME", _sum: { delta: 1 } },
    ]);
    const res = await cancelLeaveRequest({ requestId: "lr-1" });
    expect(res.ok).toBe(true);
    expect(db.leaveBalance.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { used: 0 } }),
    );
  });''',
    "T10 floors",
)

# --- T11: QA-16 concurrent cancel — no reversal row either ---
rep(
    '''    const res = await cancelLeaveRequest({ requestId: "lr-1" });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.code).toBe("AUTH");
    expect(res.ok === false && res.error).toMatch(/no longer|already/i);
    expect(db.leaveBalance.update).not.toHaveBeenCalled();
  });''',
    '''    const res = await cancelLeaveRequest({ requestId: "lr-1" });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.code).toBe("AUTH");
    expect(res.ok === false && res.error).toMatch(/no longer|already/i);
    // Aborted before the reversal — no ledger row, no cache write.
    expect(db.leaveLedgerEntry.create).not.toHaveBeenCalled();
    expect(db.leaveBalance.update).not.toHaveBeenCalled();
  });''',
    "T11 QA-16 cancel race",
)

# --- T12: getOrCreateBalance materialize — the GRANT row rides along ---
rep(
    '''    const b = await getOrCreateBalance("u-theo", "lt-annual", 2026, 20);
    expect(db.leaveBalance.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ entitled: 20, year: 2026 }) }),
    );
    expect(b).toEqual({ entitled: 20, carriedOver: 0, used: 0 });
  });''',
    '''    const b = await getOrCreateBalance("u-theo", "lt-annual", 2026, 20);
    expect(db.leaveBalance.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ entitled: 20, year: 2026 }) }),
    );
    // F1.2 — the GRANT ledger row is written in the SAME transaction: a
    // balance row must never exist without the ledger rows that explain it.
    expect(db.leaveLedgerEntry.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: "u-theo",
          leaveTypeId: "lt-annual",
          year: 2026,
          delta: 20,
          entryType: "GRANT",
          sourceType: "POLICY",
          isReversal: false,
        }),
      }),
    );
    expect(b).toEqual({ entitled: 20, carriedOver: 0, used: 0 });
  });''',
    "T12 getOrCreateBalance GRANT",
)

# --- T13: rewrite the approve-path materialize race test (fail-loud now) ---
rep(
    '''  it("pins hr-leave.ts:428-435 — a unique-trio race on materialize re-reads the winner's balance row", async () => {
    requirePermissionMock.mockResolvedValue(MANAGER_AUTH);
    db.leaveRequest.findUnique.mockResolvedValue(PENDING_REQUEST);
    // Same where.id serves both the chain walk and the requester-name lookup.
    db.user.findUnique.mockResolvedValue({ managerId: "u-mgr", name: "Theo" });
    // 1st read: no row → materialize from the policy; the create then LOSES
    // the unique-trio race; the 2nd read returns the concurrent winner's row.
    db.leaveBalance.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ entitled: 20, carriedOver: 2, used: 3 });
    // Policy default of 1 day would NOT cover the 2-day request — only the
    // winner's numbers (20 + 2 − 3 = 19 available) let the approval through,
    // so res.ok === true proves the winner re-read (432-434) actually ran.
    db.leavePolicy.findUnique.mockResolvedValue({ annualDays: 1 });
    db.leaveBalance.create.mockRejectedValue({ code: "P2002" });

    const res = await decideLeaveRequest({ requestId: "lr-1", decision: "APPROVE" });
    expect(res.ok).toBe(true);
    expect(db.leaveBalance.findUnique).toHaveBeenCalledTimes(2); // initial read + winner re-read
    expect(db.leaveBalance.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ entitled: 1 }) }),
    );
    expect(db.leaveBalance.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { used: { increment: 2 } } }),
    );
  });''',
    '''  it("F1.2: a unique-trio race on the approve-path materialize aborts loudly (retryable), never silently", async () => {
    requirePermissionMock.mockResolvedValue(MANAGER_AUTH);
    db.leaveRequest.findUnique.mockResolvedValue(PENDING_REQUEST);
    // Same where.id serves both the chain walk and the requester-name lookup.
    db.user.findUnique.mockResolvedValue({ managerId: "u-mgr", name: "Theo" });
    // No row → materialize from the policy; the create then LOSES the
    // unique-trio race. The old try/catch-re-read swallowed this inside the
    // transaction — on Postgres an INSERT unique-violation aborts the whole
    // transaction, so the "re-read" ran in an aborted state. F1.2's
    // check-then-create lets the approval fail with a retryable error
    // instead; the decider refreshes and retries (fail closed, loudly).
    db.leaveBalance.findUnique.mockResolvedValue(null);
    db.leavePolicy.findUnique.mockResolvedValue({ annualDays: 1 });
    db.leaveBalance.create.mockRejectedValue({ code: "P2002" });

    const res = await decideLeaveRequest({ requestId: "lr-1", decision: "APPROVE" });
    expect(res.ok).toBe(false);
    // The aborted approval touched nothing — no GRANT row, no CONSUME row,
    // no cache write.
    expect(db.leaveLedgerEntry.create).not.toHaveBeenCalled();
    expect(db.leaveBalance.update).not.toHaveBeenCalled();
  });''',
    "T13 approve race rewrite",
)

# --- T14: new F1.2 + F-R4 describes, inserted before the Types & policies block ---
ANCHOR = '''// ---------------------------------------------------------------------------
// Types & policies (hr:admin)
// ---------------------------------------------------------------------------
'''
ADD = '''// ---------------------------------------------------------------------------
// F1.2 — leave-ledger semantics on the action surface (the pure projection
// matrix lives in lib/__tests__/leave-ledger.test.ts).
// ---------------------------------------------------------------------------

describe("F1.2 leave ledger", () => {
  it("an approve/cancel pair writes CONSUME rows that net to zero", async () => {
    requirePermissionMock.mockResolvedValue(MANAGER_AUTH);
    db.user.findUnique.mockResolvedValue({ managerId: "u-mgr", name: "Theo" });

    // Approve the pending request (ledger: GRANT 20, nothing consumed).
    db.leaveRequest.findUnique.mockResolvedValue(PENDING_REQUEST);
    let res = await decideLeaveRequest({ requestId: "lr-1", decision: "APPROVE" });
    expect(res.ok).toBe(true);

    // Cancel it as the requester (post-reversal ledger nets the pair).
    requirePermissionMock.mockResolvedValue(MEMBER_AUTH);
    db.leaveRequest.findUnique.mockResolvedValue({ ...PENDING_REQUEST, status: "APPROVED" });
    db.leaveLedgerEntry.groupBy.mockResolvedValue([
      { entryType: "GRANT", _sum: { delta: 20 } },
      { entryType: "CONSUME", _sum: { delta: 0 } },
    ]);
    res = await cancelLeaveRequest({ requestId: "lr-1" });
    expect(res.ok).toBe(true);

    // Exactly two ledger rows were written: the consumption and its undo.
    const rows = db.leaveLedgerEntry.create.mock.calls.map((c) => c[0].data);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ delta: -2, entryType: "CONSUME", isReversal: false, sourceId: "lr-1" });
    expect(rows[1]).toMatchObject({ delta: 2, entryType: "CONSUME", isReversal: true, sourceId: "lr-1" });
    // The invariant the projection pins: the pair cancels, `used` is 0.
    const net = projectLeaveBalance([
      { entryType: "GRANT", delta: 20 },
      { entryType: "CONSUME", delta: -2 },
      { entryType: "CONSUME", delta: 2 },
    ]);
    expect(net.used).toBe(0);
    expect(net.available).toBe(20);
  });

  it("the approve guard reads Σ(all deltas) — adjustments count toward availability", async () => {
    requirePermissionMock.mockResolvedValue(MANAGER_AUTH);
    db.user.findUnique.mockResolvedValue({ managerId: "u-mgr" });
    db.leaveRequest.findUnique.mockResolvedValue({ ...PENDING_REQUEST, days: 5 });
    // Entitled 20, 16 consumed, and a −1 EXPIRE adjustment: available is
    // 3, not 4 — expiry burns real days the guard must respect.
    db.leaveLedgerEntry.groupBy.mockResolvedValue([
      { entryType: "GRANT", _sum: { delta: 20 } },
      { entryType: "CONSUME", _sum: { delta: -16 } },
      { entryType: "EXPIRE", _sum: { delta: -1 } },
    ]);
    const res = await decideLeaveRequest({ requestId: "lr-1", decision: "APPROVE" });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/3 day/i);
    expect(db.leaveLedgerEntry.create).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// F-R4 — notice counts WORKING days (Mon–Fri, holiday-aware), as the
// LeavePolicy.minNoticeDays contract has always promised.
// ---------------------------------------------------------------------------

describe("F-R4 working-day notice", () => {
  it("a weekend start inside the notice window fails on working-day notice", async () => {
    db.leaveType.findUnique.mockResolvedValue({
      ...ANNUAL_TYPE,
      policy: { ...ANNUAL_TYPE.policy, minNoticeDays: 6 },
    });
    // First Saturday at least 1 day out (gap 2..7 — always inside the
    // 3N+1 = 19-day near window). The calendar gap can reach 7 ≥ 6, but the
    // working days in (today, Saturday] never reach 6 — the request must be
    // refused by the NOTICE rail specifically (not by day count, balance,
    // or overlap: Sat..following Mon contains 1 working day, 20 available).
    const sat = new Date();
    sat.setUTCHours(0, 0, 0, 0);
    do {
      sat.setUTCDate(sat.getUTCDate() + 1);
    } while (sat.getUTCDay() !== 6);
    const mon = new Date(sat);
    mon.setUTCDate(mon.getUTCDate() + 2);
    const res = await createLeaveRequest({
      leaveTypeId: "lt-annual",
      startDate: sat.toISOString().slice(0, 10),
      endDate: mon.toISOString().slice(0, 10),
    });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/notice/i);
    expect(db.leaveRequest.create).not.toHaveBeenCalled();
  });

  it("a far start passes a large notice minimum without a precise count", async () => {
    db.leaveType.findUnique.mockResolvedValue({
      ...ANNUAL_TYPE,
      policy: { ...ANNUAL_TYPE.policy, minNoticeDays: 30 },
    });
    // 2027-06-07 is months out — the calendar gap alone guarantees the
    // 30-working-day minimum (the 3N+1 window), so the holiday-aware count
    // is unnecessary and the read stays scoped to the request's range.
    const res = await createLeaveRequest({
      leaveTypeId: "lt-annual",
      startDate: "2027-06-07",
      endDate: "2027-06-08",
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.days).toBe(2);
  });

  it("holidays inside the notice window shrink the working-day notice", async () => {
    db.leaveType.findUnique.mockResolvedValue({
      ...ANNUAL_TYPE,
      policy: { ...ANNUAL_TYPE.policy, minNoticeDays: 2 },
    });
    // Find the next Tue/Wed/Thu/Fri pair exactly 2 and 3 days out whose
    // window (today, start] holds exactly 2 working days — then blanketing
    // one of them with a holiday drops the notice to 1 < 2.
    // Build robustly: take "next Tuesday at least 2 days out" — the
    // working days in (today, next-Tuesday] are 1..5 depending on the run
    // day, so pin BOTH candidate days as holidays: whatever the run day,
    // the two weekdays after today (if both fall in the window) are gone.
    const d1 = new Date();
    d1.setUTCHours(0, 0, 0, 0);
    d1.setUTCDate(d1.getUTCDate() + 2);
    const d2 = new Date();
    d2.setUTCHours(0, 0, 0, 0);
    d2.setUTCDate(d2.getUTCDate() + 3);
    db.holidayCalendarEntry.findMany.mockResolvedValue([
      { date: d1, isHalfDay: false },
      { date: d2, isHalfDay: false },
    ]);
    // The start: Friday 4 days out (gap 4 ≤ 3*2+1 — near window). The
    // notice window (today, start] spans 3 weekdays; two of them are
    // holidays → 1 working day of notice < 2 → refused by the notice rail.
    const fri = new Date();
    fri.setUTCHours(0, 0, 0, 0);
    fri.setUTCDate(fri.getUTCDate() + 4);
    while (fri.getUTCDay() !== 5) fri.setUTCDate(fri.getUTCDate() + 1);
    const res = await createLeaveRequest({
      leaveTypeId: "lt-annual",
      startDate: fri.toISOString().slice(0, 10),
      endDate: fri.toISOString().slice(0, 10),
    });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/notice/i);
    expect(db.leaveRequest.create).not.toHaveBeenCalled();
  });
});

'''
assert src.count(ANCHOR) == 1, f"T14 anchor count = {src.count(ANCHOR)}"
src = src.replace(ANCHOR, ADD + ANCHOR)

# --- T15: import projectLeaveBalance for the netting check ---
rep(
    '''import {
  createLeaveRequest,
  decideLeaveRequest,
  cancelLeaveRequest,
  createLeaveType,
  updateLeaveType,
  getMyLeaveData,
  getLeaveQueue,
} from "../hr-leave";''',
    '''import {
  createLeaveRequest,
  decideLeaveRequest,
  cancelLeaveRequest,
  createLeaveType,
  updateLeaveType,
  getMyLeaveData,
  getLeaveQueue,
} from "../hr-leave";
import { projectLeaveBalance } from "@/lib/leave-ledger";''',
    "T15 import",
)

F.write_text(src, encoding="utf-8")
print("patched hr-leave.test.ts OK —", len(src), "bytes")
