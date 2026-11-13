import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// F2.4 — leave-allocation job core tests (the cron's three writers).
// Grants advance strategies idempotently; the year-end rollover writes the
// CARRY/EXPIRE pair once; the carry lapse expires unspent carry once; one
// failing pair never fails the pass. db is mocked (the hr-leave.test.ts
// harness pattern — the rule itself is fully covered in leave-policy.test).
// ---------------------------------------------------------------------------

const db = vi.hoisted(() => {
  const models = ["leaveType", "leaveBalance", "leaveLedgerEntry", "employeeProfile", "user", "mailOutbox", "leavePeriod", "leavePolicySet", "leavePolicySetItem", "leavePolicyAssignment"];
  const methods = ["findMany", "findUnique", "findFirst", "create", "createMany", "update", "upsert", "groupBy"];
  const obj: Record<string, Record<string, ReturnType<typeof vi.fn>>> = {};
  for (const m of models) {
    obj[m] = {};
    for (const meth of methods) obj[m][meth] = vi.fn();
  }
  (obj as Record<string, unknown>).$transaction = vi.fn(
    async (fn: unknown) => (typeof fn === "function" ? fn(obj) : Promise.resolve(fn)),
  );
  return obj;
});

vi.mock("@/lib/db", () => ({ db }));

// P26 — the failure alarm (moved into the core module so the daily
// dispatcher reaches it) rides the outbox helpers; mock them at the
// client boundary like employee-reminders.test.ts does (the real module
// transitively constructs the auth stack, which a unit test must not).
const queueOutboxMailMock = vi.fn();
const deliverOutboxMailMock = vi.fn();
vi.mock("@/lib/server/mail-outbox", () => ({
  queueOutboxMail: (...a: unknown[]) => queueOutboxMailMock(...a),
  deliverOutboxMail: (...a: unknown[]) => deliverOutboxMailMock(...a),
}));

// P28 (LV-03) — the assignment override resolver, mocked at the same
// boundary (the real hr-shared transitively constructs the auth stack).
// The RESOLVER's own matrix (row-level override, orphan degradation) is
// pinned in hr-leave.test.ts, which runs the real helper against the db
// mock.
const assignmentOverridesForUsersMock = vi.fn();
vi.mock("@/lib/server/leave-overrides", () => ({
  assignmentOverridesForUsers: (...a: unknown[]) => assignmentOverridesForUsersMock(...a),
}));

const logErrorSpy = vi.fn();
const logInfoSpy = vi.fn();
vi.mock("@/lib/observability", () => ({
  logError: (...a: unknown[]) => logErrorSpy(...a),
  logInfo: (...a: unknown[]) => logInfoSpy(...a),
  captureError: vi.fn(),
}));

import { runLeaveAllocationJob, sendLeaveJobFailureAlarm } from "@/lib/leave-allocation-core";

const EARNED_TYPE = {
  id: "lt-earned",
  name: "Annual (Earned)",
  active: true,
  policy: {
    id: "lp-1",
    leaveTypeId: "lt-earned",
    annualDays: 24,
    maxCarryOver: 5,
    minNoticeDays: 1,
    maxConsecutiveDays: 15,
    allocationStrategy: "EARNED",
    accrualFrequency: "MONTHLY",
    allocateOnDay: "FIRST",
    accrualRounding: "FLOOR_QUARTER",
    accrualCap: null,
    grantOn: "PERIOD_START",
    prorateForJoiners: true,
    minServiceMonths: 0,
    accrueDuringProbation: true,
    allowNegative: false,
    negativeFloor: 0,
    carryExpiresAfterMonths: null,
    countHolidaysInLeave: false,
  },
};

const MANUAL_TYPE = {
  id: "lt-annual",
  name: "Annual Leave",
  active: true,
  policy: { ...EARNED_TYPE.policy, id: "lp-2", leaveTypeId: "lt-annual", allocationStrategy: "MANUAL" },
};

/** groupBy impl from a {entryType → delta} record. */
function groupsBy(deltaByType: Record<string, number>) {
  return db.leaveLedgerEntry.groupBy.mockImplementation(async () =>
    Object.entries(deltaByType).map(([entryType, delta]) => ({ entryType, _sum: { delta } })),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  db.leaveLedgerEntry.findMany.mockResolvedValue([]);
  db.leaveLedgerEntry.findFirst.mockResolvedValue(null);
  db.leaveBalance.findMany.mockResolvedValue([]);
  db.employeeProfile.findMany.mockResolvedValue([]);
  // P27 (LV-08) — the period table defaults EMPTY (the implicit
  // calendar-year windows; every pre-P27 expectation below stays the
  // byte-identical pin).
  db.leavePeriod.findMany.mockResolvedValue([]);
  // P28 (LV-02/LV-03) — the assignment table defaults EMPTY (no policy
  // sets, no overrides: every pre-P28 grant expectation stays pinned;
  // the P28 describe blocks below seed overrides explicitly).
  db.leavePolicyAssignment.findMany.mockResolvedValue([]);
  db.leavePolicySet.findMany.mockResolvedValue([]);
  db.leavePolicySetItem.findMany.mockResolvedValue([]);
  assignmentOverridesForUsersMock.mockResolvedValue(new Map());
});

describe("runLeaveAllocationJob — grant phase", () => {
  it("advances an EARNED type: due periods appended, cache re-synced", async () => {
    db.leaveType.findMany.mockResolvedValue([EARNED_TYPE]);
    db.leaveBalance.findMany.mockImplementation(async (args: { where?: { year?: number } }) =>
      args?.where?.year === 2026 ? [{ userId: "u1" }] : [],
    );
    db.employeeProfile.findMany.mockResolvedValue([
      { userId: "u1", hireDate: new Date("2023-03-15T00:00:00Z"), employmentStatus: "ACTIVE", probationEndsAt: null },
    ]);
    groupsBy({ GRANT: 0 });

    const report = await runLeaveAllocationJob(new Date("2026-03-05T00:00:00Z"));

    expect(report.grantsWritten).toBe(3); // Jan + Feb + Mar at 2/day
    expect(db.leaveLedgerEntry.createMany).toHaveBeenCalledTimes(1);
    const rows = db.leaveLedgerEntry.createMany.mock.calls[0][0].data;
    expect(rows.map((r: { sourceId: string; delta: number }) => [r.sourceId, r.delta])).toEqual([
      ["2026-01", 2],
      ["2026-02", 2],
      ["2026-03", 2],
    ]);
    expect(rows.every((r: { sourceType: string; entryType: string }) => r.sourceType === "POLICY" && r.entryType === "GRANT")).toBe(true);
    // Cache re-sync rides the same transaction.
    expect(db.leaveBalance.update).toHaveBeenCalled();
  });

  it("is idempotent: periods already on the ledger are not re-granted", async () => {
    db.leaveType.findMany.mockResolvedValue([EARNED_TYPE]);
    db.leaveBalance.findMany.mockImplementation(async (args: { where?: { year?: number } }) =>
      args?.where?.year === 2026 ? [{ userId: "u1" }] : [],
    );
    db.leaveLedgerEntry.findMany.mockResolvedValue([
      { sourceId: "2026-01" }, { sourceId: "2026-02" }, { sourceId: "2026-03" },
    ]);
    groupsBy({ GRANT: 6 });

    const report = await runLeaveAllocationJob(new Date("2026-03-05T00:00:00Z"));
    expect(report.grantsWritten).toBe(0);
    expect(db.leaveLedgerEntry.createMany).not.toHaveBeenCalled();
  });

  it("skips MANUAL types (materialization is their only writer)", async () => {
    db.leaveType.findMany.mockResolvedValue([MANUAL_TYPE]);
    const report = await runLeaveAllocationJob(new Date("2026-06-01T00:00:00Z"));
    expect(report.manualTypesSkipped).toBe(1);
    expect(report.grantsWritten).toBe(0);
    expect(db.leaveLedgerEntry.createMany).not.toHaveBeenCalled();
  });

  it("a failing pair is counted and logged, the pass survives", async () => {
    db.leaveType.findMany.mockResolvedValue([EARNED_TYPE]);
    db.leaveBalance.findMany.mockImplementation(async (args: { where?: { year?: number } }) =>
      args?.where?.year === 2026 ? [{ userId: "u1" }, { userId: "u2" }] : [],
    );
    groupsBy({ GRANT: 0 });
    // The first pair's transaction explodes; the second still lands.
    let calls = 0;
    (db.$transaction as unknown as { mockImplementation: (impl: (fn: unknown) => Promise<unknown>) => void }).mockImplementation(
      async (fn: unknown) => {
        calls += 1;
        if (calls === 1) throw new Error("pair exploded");
        return typeof fn === "function" ? (fn as (tx: unknown) => Promise<unknown>)(db) : Promise.resolve(fn);
      },
    );

    const report = await runLeaveAllocationJob(new Date("2026-02-01T00:00:00Z"));
    expect(report.failures).toBe(1);
    expect(report.grantsWritten).toBe(2); // u2's Jan + Feb
    expect(logErrorSpy).toHaveBeenCalled();
    // P21 (LV-B18) — the failure-reason record: phase + type + humanized
    // reason ride the report (the route turns these into the HR alarm).
    expect(report.failuresDetail).toHaveLength(1);
    expect(report.failuresDetail[0]).toMatchObject({
      userId: "u1",
      leaveTypeId: "lt-earned",
      leaveTypeName: "Annual (Earned)",
      phase: "GRANT",
      reason: "pair exploded",
    });
  });
});

describe("runLeaveAllocationJob — P28 (LV-03): assignment-driven grants", () => {
  /** The resolver's output shape for one assigned user. */
  const overridesFor = (userId: string, byType: Record<string, number>) =>
    new Map([
      [userId, { setId: "s-1", setName: "Standard 2027", annualDaysByType: new Map(Object.entries(byType)) }],
    ]);

  it("an assigned user WITHOUT a balance row joins the pairs and accrues at the SET's allocation (the assignment is the trigger)", async () => {
    db.leaveType.findMany.mockResolvedValue([EARNED_TYPE]); // global: 24 days → 2/day monthly
    db.leaveBalance.findMany.mockResolvedValue([]); // nobody has rows
    assignmentOverridesForUsersMock.mockResolvedValue(overridesFor("u-a", { "lt-earned": 12 })); // the set: 12 → 1/day
    db.employeeProfile.findMany.mockResolvedValue([
      { userId: "u-a", hireDate: new Date("2023-03-15T00:00:00Z"), employmentStatus: "ACTIVE", probationEndsAt: null },
    ]);
    groupsBy({ GRANT: 0 });

    const report = await runLeaveAllocationJob(new Date("2026-03-05T00:00:00Z"));

    // Three monthly periods at the SET's 1/day each — the same deterministic
    // period keys, the overridden number.
    expect(report.grantsWritten).toBe(3);
    expect(db.leaveBalance.upsert).toHaveBeenCalled(); // the row the assignment created
    const rows = db.leaveLedgerEntry.createMany.mock.calls[0][0].data;
    expect(rows.map((r: { sourceId: string; delta: number }) => [r.sourceId, r.delta])).toEqual([
      ["2026-01", 1],
      ["2026-02", 1],
      ["2026-03", 1],
    ]);
    expect(report.grantPairsConsidered).toBe(1);
  });

  it("an assigned user and a global-policy user advance side by side — each at their own number", async () => {
    db.leaveType.findMany.mockResolvedValue([EARNED_TYPE]);
    db.leaveBalance.findMany.mockImplementation(async (args: { where?: { year?: number } }) =>
      args?.where?.year === 2026 ? [{ userId: "u-plain" }] : [],
    );
    assignmentOverridesForUsersMock.mockResolvedValue(overridesFor("u-a", { "lt-earned": 12 }));
    db.employeeProfile.findMany.mockResolvedValue([
      { userId: "u-plain", hireDate: new Date("2023-03-15T00:00:00Z"), employmentStatus: "ACTIVE", probationEndsAt: null },
      { userId: "u-a", hireDate: new Date("2023-03-15T00:00:00Z"), employmentStatus: "ACTIVE", probationEndsAt: null },
    ]);
    groupsBy({ GRANT: 0 });

    const report = await runLeaveAllocationJob(new Date("2026-02-01T00:00:00Z"));

    expect(report.grantPairsConsidered).toBe(2);
    expect(report.grantsWritten).toBe(4); // u-plain: Jan+Feb at 2; u-a: Jan+Feb at 1
    // The balance-row holder's transaction never upserts (the row exists);
    // the assigned user's does (their first advance creates it).
    const upsertWhere = db.leaveBalance.upsert.mock.calls.map(
      (c: unknown[]) => (c[0] as { where: { userId_leaveTypeId_year: { userId: string } } }).where.userId_leaveTypeId_year.userId,
    );
    expect(upsertWhere).toEqual(["u-a"]);
    // First createMany call = u-plain (2/day), second = u-a (1/day).
    const plainRows = db.leaveLedgerEntry.createMany.mock.calls[0][0].data;
    const assignedRows = db.leaveLedgerEntry.createMany.mock.calls[1][0].data;
    expect(plainRows.every((r: { delta: number }) => r.delta === 2)).toBe(true);
    expect(assignedRows.every((r: { delta: number }) => r.delta === 1)).toBe(true);
  });

  it("a set NOT covering the type never pulls the user into the pair set", async () => {
    db.leaveType.findMany.mockResolvedValue([EARNED_TYPE]);
    db.leaveBalance.findMany.mockResolvedValue([]); // no balance rows either
    assignmentOverridesForUsersMock.mockResolvedValue(
      overridesFor("u-a", { "lt-other": 12 }), // the set covers a DIFFERENT type
    );
    groupsBy({ GRANT: 0 });

    const report = await runLeaveAllocationJob(new Date("2026-02-01T00:00:00Z"));
    expect(report.grantPairsConsidered).toBe(0);
    expect(report.grantsWritten).toBe(0);
    expect(db.leaveLedgerEntry.createMany).not.toHaveBeenCalled();
  });
});

describe("runLeaveAllocationJob — year-end rollover phase", () => {
  it("carries min(prevAvailable, cap) and expires the excess into the new year", async () => {
    db.leaveType.findMany.mockResolvedValue([MANUAL_TYPE]);
    db.leaveBalance.findMany.mockImplementation(async (args: { where?: { year?: number } }) =>
      args?.where?.year === 2025 ? [{ userId: "u1" }] : [],
    );
    groupsBy({ GRANT: 8 }); // 2025 final available: 8

    const report = await runLeaveAllocationJob(new Date("2026-01-02T00:00:00Z"));

    expect(report.carryRowsWritten).toBe(1);
    expect(report.expireRowsWritten).toBe(1);
    expect(db.leaveBalance.upsert).toHaveBeenCalled(); // the 2026 cache row
    const rows = db.leaveLedgerEntry.createMany.mock.calls[0][0].data;
    expect(rows).toEqual([
      expect.objectContaining({ entryType: "CARRY", delta: 5, sourceType: "POLICY", sourceId: "carry" }),
      expect.objectContaining({ entryType: "EXPIRE", delta: -3, sourceType: "POLICY", sourceId: "carry-expire" }),
    ]);
    // P29 (LV-04) — a knob-null policy stamps NO expiry (never lapses).
    expect(rows[0].expiryAt).toBeNull();
    expect(rows[0].note).not.toContain("lapses");
  });

  it("P29/LV-04: the rollover stamps the CARRY row's frozen expiry day (window start + knob months)", async () => {
    const lapsing = {
      ...EARNED_TYPE,
      id: "lt-stamp",
      policy: { ...EARNED_TYPE.policy, id: "lp-stamp", leaveTypeId: "lt-stamp", allocationStrategy: "MANUAL", carryExpiresAfterMonths: 3 },
    };
    db.leaveType.findMany.mockResolvedValue([lapsing]);
    db.leaveBalance.findMany.mockImplementation(async (args: { where?: { year?: number } }) =>
      args?.where?.year === 2025 ? [{ userId: "u1" }] : [],
    );
    groupsBy({ GRANT: 8 });

    const report = await runLeaveAllocationJob(new Date("2026-01-02T00:00:00Z"));

    expect(report.carryRowsWritten).toBe(1);
    const rows = db.leaveLedgerEntry.createMany.mock.calls[0][0].data;
    expect(rows[0]).toMatchObject({ entryType: "CARRY", delta: 5, sourceId: "carry" });
    // 2026-01-01 + 3 months, UTC-midnight — the frozen lapse day.
    expect(rows[0].expiryAt).toEqual(new Date("2026-04-01T00:00:00.000Z"));
    expect(rows[0].note).toContain("— lapses 2026-04-01");
  });

  it("writes nothing when the prior balance is non-positive", async () => {
    db.leaveType.findMany.mockResolvedValue([MANUAL_TYPE]);
    db.leaveBalance.findMany.mockImplementation(async (args: { where?: { year?: number } }) =>
      args?.where?.year === 2025 ? [{ userId: "u1" }] : [],
    );
    groupsBy({ GRANT: 2, CONSUME: -2 }); // available 0
    const report = await runLeaveAllocationJob(new Date("2026-01-02T00:00:00Z"));
    expect(report.carryRowsWritten).toBe(0);
    expect(db.leaveLedgerEntry.createMany).not.toHaveBeenCalled();
  });

  it("is idempotent: an existing CARRY row (any source) skips the pair", async () => {
    db.leaveType.findMany.mockResolvedValue([MANUAL_TYPE]);
    db.leaveBalance.findMany.mockImplementation(async (args: { where?: { year?: number } }) =>
      args?.where?.year === 2025 ? [{ userId: "u1" }] : [],
    );
    groupsBy({ GRANT: 8 });
    db.leaveLedgerEntry.findFirst.mockResolvedValue({ id: "already" });

    const report = await runLeaveAllocationJob(new Date("2026-01-02T00:00:00Z"));
    expect(report.carryRowsWritten).toBe(0);
    expect(db.leaveLedgerEntry.createMany).not.toHaveBeenCalled();
  });
});

describe("runLeaveAllocationJob — carry lapse phase (P29/LV-04: per-row expiry)", () => {
  const LAPSING_TYPE = {
    ...EARNED_TYPE,
    id: "lt-lapse",
    policy: { ...EARNED_TYPE.policy, id: "lp-3", leaveTypeId: "lt-lapse", allocationStrategy: "MANUAL", carryExpiresAfterMonths: 3 },
  };

  /** Ledger rows for one bucket, the shape the lapse phase reads. */
  const carryRow = (delta: number, expiryAt: Date | null) => ({
    id: "c1",
    delta,
    entryType: "CARRY",
    sourceType: "POLICY",
    sourceId: "carry",
    expiryAt,
    createdAt: new Date("2026-01-01T00:00:00Z"),
  });
  const consumeRow = (delta: number) => ({
    id: "k1",
    delta,
    entryType: "CONSUME",
    sourceType: "LEAVE_REQUEST",
    sourceId: "lr-1",
    expiryAt: null,
    createdAt: new Date("2026-02-01T00:00:00Z"),
  });

  it("unstamped rows (pre-P29 data) bridge on the knob: unspent carry expires once N months elapsed", async () => {
    db.leaveType.findMany.mockResolvedValue([LAPSING_TYPE]);
    db.leaveBalance.findMany.mockImplementation(async (args: { where?: { year?: number } }) =>
      args?.where?.year === 2026 ? [{ userId: "u1" }] : [],
    );
    // 5 carried (NO stamp), 2 consumed → 3 unspent → EXPIRE −3 on April 1st.
    groupsBy({ CARRY: 5, CONSUME: -2 });
    db.leaveLedgerEntry.findMany.mockResolvedValue([carryRow(5, null), consumeRow(-2)]);

    const before = await runLeaveAllocationJob(new Date("2026-03-31T00:00:00Z"));
    expect(before.expireRowsWritten).toBe(0); // March: only 2 complete months

    const report = await runLeaveAllocationJob(new Date("2026-04-01T00:00:00Z"));
    expect(report.expireRowsWritten).toBe(1);
    expect(db.leaveLedgerEntry.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [expect.objectContaining({ entryType: "EXPIRE", delta: -3, sourceType: "POLICY", sourceId: "carry-lapse#c1" })],
      }),
    );
    // The cache re-sync rides the same transaction.
    expect(db.leaveBalance.update).toHaveBeenCalled();
  });

  it("a STAMPED row lapses on its frozen day — even when the policy knob was since removed", async () => {
    const unstampedPolicy = {
      ...LAPSING_TYPE,
      policy: { ...LAPSING_TYPE.policy, carryExpiresAfterMonths: null }, // HR nulled the knob AFTER the rollover stamped the row
    };
    db.leaveType.findMany.mockResolvedValue([unstampedPolicy]);
    db.leaveBalance.findMany.mockImplementation(async (args: { where?: { year?: number } }) =>
      args?.where?.year === 2026 ? [{ userId: "u1" }] : [],
    );
    groupsBy({ CARRY: 5 });
    db.leaveLedgerEntry.findMany.mockResolvedValue([carryRow(5, new Date("2026-04-01T00:00:00Z"))]);

    const before = await runLeaveAllocationJob(new Date("2026-03-31T00:00:00Z"));
    expect(before.expireRowsWritten).toBe(0); // the frozen day hasn't passed

    const report = await runLeaveAllocationJob(new Date("2026-04-01T00:00:00Z"));
    expect(report.expireRowsWritten).toBe(1);
    expect(db.leaveLedgerEntry.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [expect.objectContaining({ delta: -5, sourceId: "carry-lapse#c1" })],
      }),
    );
  });

  it("a stamped row does NOT lapse on the knob's clock (the stamp, not the live policy, governs)", async () => {
    db.leaveType.findMany.mockResolvedValue([LAPSING_TYPE]); // knob says Apr 1
    db.leaveBalance.findMany.mockImplementation(async (args: { where?: { year?: number } }) =>
      args?.where?.year === 2026 ? [{ userId: "u1" }] : [],
    );
    groupsBy({ CARRY: 5 });
    db.leaveLedgerEntry.findMany.mockResolvedValue([carryRow(5, new Date("2026-06-01T00:00:00Z"))]); // stamp says Jun 1

    const report = await runLeaveAllocationJob(new Date("2026-04-01T00:00:00Z"));
    expect(report.expireRowsWritten).toBe(0);
    expect(db.leaveLedgerEntry.createMany).not.toHaveBeenCalled();
  });

  it("never lapses when there is no stamp and no knob", async () => {
    db.leaveType.findMany.mockResolvedValue([MANUAL_TYPE]);
    db.leaveBalance.findMany.mockImplementation(async (args: { where?: { year?: number } }) =>
      args?.where?.year === 2026 ? [{ userId: "u1" }] : [],
    );
    groupsBy({ CARRY: 5 });
    db.leaveLedgerEntry.findMany.mockResolvedValue([carryRow(5, null)]);
    const report = await runLeaveAllocationJob(new Date("2026-12-31T00:00:00Z"));
    expect(report.expireRowsWritten).toBe(0);
    expect(db.leaveLedgerEntry.createMany).not.toHaveBeenCalled();
  });

  it("idempotency: a legacy aggregate 'carry-lapse' row retires the pair — never double-lapse", async () => {
    db.leaveType.findMany.mockResolvedValue([LAPSING_TYPE]);
    db.leaveBalance.findMany.mockImplementation(async (args: { where?: { year?: number } }) =>
      args?.where?.year === 2026 ? [{ userId: "u1" }] : [],
    );
    groupsBy({ CARRY: 5, CONSUME: -2, EXPIRE: -3 });
    db.leaveLedgerEntry.findMany.mockResolvedValue([
      carryRow(5, null),
      consumeRow(-2),
      { id: "e0", delta: -3, entryType: "EXPIRE", sourceType: "POLICY", sourceId: "carry-lapse", expiryAt: null, createdAt: new Date("2026-04-01T00:00:00Z") },
    ]);

    const report = await runLeaveAllocationJob(new Date("2026-04-02T00:00:00Z"));
    expect(report.expireRowsWritten).toBe(0);
    expect(db.leaveLedgerEntry.createMany).not.toHaveBeenCalled();
  });

  it("idempotency: a 'carry-lapse#<id>' row retires only its own CARRY row", async () => {
    db.leaveType.findMany.mockResolvedValue([LAPSING_TYPE]);
    db.leaveBalance.findMany.mockImplementation(async (args: { where?: { year?: number } }) =>
      args?.where?.year === 2026 ? [{ userId: "u1" }] : [],
    );
    groupsBy({ CARRY: 5 });
    db.leaveLedgerEntry.findMany.mockResolvedValue([
      { id: "c1", delta: 3, entryType: "CARRY", sourceType: "POLICY", sourceId: "carry", expiryAt: new Date("2026-04-01T00:00:00Z"), createdAt: new Date("2026-01-01T00:00:00Z") },
      { id: "c2", delta: 2, entryType: "CARRY", sourceType: "POLICY", sourceId: "carry", expiryAt: new Date("2026-04-01T00:00:00Z"), createdAt: new Date("2026-01-01T00:05:00Z") },
      { id: "e1", delta: -3, entryType: "EXPIRE", sourceType: "POLICY", sourceId: "carry-lapse#c1", expiryAt: null, createdAt: new Date("2026-04-01T00:00:00Z") },
    ]);

    const report = await runLeaveAllocationJob(new Date("2026-04-02T00:00:00Z"));
    expect(report.expireRowsWritten).toBe(1);
    expect(db.leaveLedgerEntry.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [expect.objectContaining({ delta: -2, sourceId: "carry-lapse#c2" })],
      }),
    );
  });

  it("P29/LV-05: split consume rows attribute FIFO — the carry part eats the carry before any lapse", async () => {
    db.leaveType.findMany.mockResolvedValue([LAPSING_TYPE]);
    db.leaveBalance.findMany.mockImplementation(async (args: { where?: { year?: number } }) =>
      args?.where?.year === 2026 ? [{ userId: "u1" }] : [],
    );
    groupsBy({ CARRY: 5, CONSUME: -5 });
    // The approval split its 5 days as 3 carry + 2 new (both stamped rows
    // are CONSUME): the carry is FULLY spent → nothing left to lapse.
    db.leaveLedgerEntry.findMany.mockResolvedValue([
      carryRow(5, new Date("2026-04-01T00:00:00Z")),
      { id: "k1", delta: -3, entryType: "CONSUME", sourceType: "LEAVE_REQUEST", sourceId: "lr-1", expiryAt: null, createdAt: new Date("2026-02-01T00:00:00Z") },
      { id: "k2", delta: -2, entryType: "CONSUME", sourceType: "LEAVE_REQUEST", sourceId: "lr-1", expiryAt: null, createdAt: new Date("2026-02-01T00:05:00Z") },
    ]);

    const report = await runLeaveAllocationJob(new Date("2026-04-01T00:00:00Z"));
    expect(report.expireRowsWritten).toBe(0);
    expect(db.leaveLedgerEntry.createMany).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// P26 — sendLeaveJobFailureAlarm (moved from the standalone route so the
// daily dispatcher reaches the same alarm; behavior byte-identical).
// ---------------------------------------------------------------------------

describe("P26 — sendLeaveJobFailureAlarm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("queues one LEAVE_JOB_FAILURE outbox row per ADMIN/HR user with an email", async () => {
    db.user.findMany.mockResolvedValue([
      { email: "admin@fernly.app" },
      { email: "hr@fernly.app" },
    ]);
    queueOutboxMailMock.mockImplementation(async (_tx: unknown, input: { toAddress: string }) => ({
      id: `row-${input.toAddress}`,
    }));
    db.mailOutbox.findUnique.mockImplementation(async (args: { where: { id: string } }) => ({
      toAddress: args.where.id.replace("row-", ""),
      subject: "Leave policy job — failures need attention",
      body: "detail",
    }));
    deliverOutboxMailMock.mockResolvedValue({ status: "SENT", providerMessageId: "x", error: "" });

    const report = {
      asOf: "2026-11-10",
      typesConsidered: 2,
      manualTypesSkipped: 1,
      grantPairsConsidered: 1,
      grantsWritten: 1,
      carryRowsWritten: 0,
      expireRowsWritten: 0,
      failures: 1,
      failuresDetail: [{ userId: "u1", leaveTypeId: "lt-x", leaveTypeName: "X", phase: "GRANT", reason: "boom" }],
    };
    await sendLeaveJobFailureAlarm(report as never);

    // Recipients: exactly the ADMIN+HR users the query asked for.
    expect(db.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ role: { in: ["ADMIN", "HR"] } }),
      }),
    );
    expect(queueOutboxMailMock).toHaveBeenCalledTimes(2);
    expect(queueOutboxMailMock).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ kind: "LEAVE_JOB_FAILURE", toAddress: "admin@fernly.app", sentById: "cron:leave-allocation" }),
    );
    expect(deliverOutboxMailMock).toHaveBeenCalledTimes(2);
  });

  it("a delivery failure never throws — the outbox row is the durable record", async () => {
    db.user.findMany.mockResolvedValue([{ email: "admin@fernly.app" }]);
    queueOutboxMailMock.mockResolvedValue({ id: "row-1" });
    db.mailOutbox.findUnique.mockResolvedValue({ toAddress: "admin@fernly.app", subject: "s", body: "b" });
    deliverOutboxMailMock.mockRejectedValue(new Error("provider down"));

    await expect(
      sendLeaveJobFailureAlarm({ asOf: "2026-11-10", failures: 2, failuresDetail: [] } as never),
    ).resolves.toBeUndefined();
    expect(logErrorSpy).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// P27 (LV-08) — the pass under NAMED allocation windows. The period table
// mocked non-empty switches the job onto the active window (bucket = the
// period's start year); the migration gap is an honest no-op. The suite
// above with leavePeriod.findMany → [] IS the byte-identical implicit pin.
// ---------------------------------------------------------------------------

const FISCAL_27_ROW = {
  id: "p27-1",
  name: "FY 2027/28 (Apr → Mar)",
  startDate: new Date("2027-04-01T00:00:00.000Z"),
  endDate: new Date("2028-03-31T00:00:00.000Z"),
};

describe("runLeaveAllocationJob — named windows (P27/LV-08)", () => {
  it("advances the ACTIVE window: EARNED grants land in the period's bucket with Apr→Mar keys", async () => {
    db.leavePeriod.findMany.mockResolvedValue([FISCAL_27_ROW]);
    db.leaveType.findMany.mockResolvedValue([EARNED_TYPE]);
    // Balance row exists in the window's bucket (2027 = the start year).
    db.leaveBalance.findMany.mockImplementation(async (args: { where?: { year?: number } }) =>
      args?.where?.year === 2027 ? [{ userId: "u1" }] : [],
    );
    db.employeeProfile.findMany.mockResolvedValue([{ userId: "u1", hireDate: new Date("2023-03-15T00:00:00.000Z"), employmentStatus: "ACTIVE", probationEndsAt: null }]);
    groupsBy({}); // nothing granted yet

    const report = await runLeaveAllocationJob(new Date("2027-06-15T00:00:00Z"));

    expect(report.grantsWritten).toBe(3); // Apr, May, Jun — 2 days each
    const rows = db.leaveLedgerEntry.createMany.mock.calls[0][0].data;
    expect(rows.map((r: { sourceId: string }) => r.sourceId)).toEqual(["2027-04", "2027-05", "2027-06"]);
    expect(rows.every((r: { year: number }) => r.year === 2027)).toBe(true);
    expect(rows.every((r: { delta: number }) => r.delta === 2)).toBe(true);
  });

  it("the FIRST window's rollover carries startYear − 1 (the last calendar bucket with history)", async () => {
    db.leavePeriod.findMany.mockResolvedValue([FISCAL_27_ROW]);
    db.leaveType.findMany.mockResolvedValue([MANUAL_TYPE]);
    db.leaveBalance.findMany.mockImplementation(async (args: { where?: { year?: number } }) =>
      args?.where?.year === 2026 ? [{ userId: "u1" }] : [],
    );
    groupsBy({ GRANT: 8 }); // 2026 final available: 8

    const report = await runLeaveAllocationJob(new Date("2027-04-02T00:00:00Z"));

    expect(report.carryRowsWritten).toBe(1);
    expect(report.expireRowsWritten).toBe(1);
    const rows = db.leaveLedgerEntry.createMany.mock.calls[0][0].data;
    expect(rows.every((r: { year: number }) => r.year === 2027)).toBe(true); // the window's bucket
    expect(rows).toEqual([
      expect.objectContaining({ entryType: "CARRY", delta: 5, sourceId: "carry" }),
      expect.objectContaining({ entryType: "EXPIRE", delta: -3, sourceId: "carry-expire" }),
    ]);
    // The cache row upserted into 2027 (not a calendar-year guess).
    expect(db.leaveBalance.upsert.mock.calls[0][0].where.userId_leaveTypeId_year.year).toBe(2027);
  });

  it("a LATER window's rollover carries its chain predecessor's bucket", async () => {
    db.leavePeriod.findMany.mockResolvedValue([
      FISCAL_27_ROW,
      {
        id: "p27-2",
        name: "FY 2028/29 (Apr → Mar)",
        startDate: new Date("2028-04-01T00:00:00.000Z"),
        endDate: new Date("2029-03-31T00:00:00.000Z"),
      },
    ]);
    db.leaveType.findMany.mockResolvedValue([MANUAL_TYPE]);
    db.leaveBalance.findMany.mockImplementation(async (args: { where?: { year?: number } }) =>
      args?.where?.year === 2027 ? [{ userId: "u1" }] : [],
    );
    groupsBy({ GRANT: 4 });

    const report = await runLeaveAllocationJob(new Date("2028-04-02T00:00:00Z"));

    expect(report.carryRowsWritten).toBe(1);
    const rows = db.leaveLedgerEntry.createMany.mock.calls[0][0].data;
    expect(rows.every((r: { year: number }) => r.year === 2028)).toBe(true);
    expect(rows[0]).toMatchObject({ entryType: "CARRY", delta: 4, sourceId: "carry" });
  });

  it("the carry lapse counts months INTO the window (Apr start ⇒ July lapse for N=3)", async () => {
    db.leavePeriod.findMany.mockResolvedValue([FISCAL_27_ROW]);
    const lapsing = {
      ...EARNED_TYPE,
      id: "lt-lapse-w",
      policy: { ...EARNED_TYPE.policy, id: "lp-w", leaveTypeId: "lt-lapse-w", allocationStrategy: "MANUAL", carryExpiresAfterMonths: 3 },
    };
    db.leaveType.findMany.mockResolvedValue([lapsing]);
    db.leaveBalance.findMany.mockImplementation(async (args: { where?: { year?: number } }) =>
      args?.where?.year === 2027 ? [{ userId: "u1" }] : [],
    );
    groupsBy({ CARRY: 4, CONSUME: -1 }); // unspent carry 3
    db.leaveLedgerEntry.findMany.mockResolvedValue([
      { id: "c1", delta: 4, entryType: "CARRY", sourceType: "POLICY", sourceId: "carry", expiryAt: null, createdAt: new Date("2027-04-01T00:00:00Z") },
      { id: "k1", delta: -1, entryType: "CONSUME", sourceType: "LEAVE_REQUEST", sourceId: "lr-1", expiryAt: null, createdAt: new Date("2027-05-01T00:00:00Z") },
    ]);

    const report = await runLeaveAllocationJob(new Date("2027-07-02T00:00:00Z"));

    expect(report.expireRowsWritten).toBe(1);
    expect(db.leaveLedgerEntry.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [expect.objectContaining({ year: 2027, delta: -3, entryType: "EXPIRE", sourceId: "carry-lapse#c1" })],
      }),
    );
  });

  it("P29/LV-04: a named window's rollover stamps the expiry from the WINDOW's start", async () => {
    db.leavePeriod.findMany.mockResolvedValue([FISCAL_27_ROW]);
    const lapsing = {
      ...EARNED_TYPE,
      id: "lt-stamp-w",
      policy: { ...EARNED_TYPE.policy, id: "lp-sw", leaveTypeId: "lt-stamp-w", allocationStrategy: "MANUAL", carryExpiresAfterMonths: 3 },
    };
    db.leaveType.findMany.mockResolvedValue([lapsing]);
    db.leaveBalance.findMany.mockImplementation(async (args: { where?: { year?: number } }) =>
      args?.where?.year === 2026 ? [{ userId: "u1" }] : [],
    );
    groupsBy({ GRANT: 4 });

    const report = await runLeaveAllocationJob(new Date("2027-04-02T00:00:00Z"));

    expect(report.carryRowsWritten).toBe(1);
    const rows = db.leaveLedgerEntry.createMany.mock.calls[0][0].data;
    expect(rows[0]).toMatchObject({ entryType: "CARRY", delta: 4, year: 2027 });
    // The window starts 2027-04-01 → the frozen expiry is 2027-07-01, not a
    // calendar-year guess.
    expect(rows[0].expiryAt).toEqual(new Date("2027-07-01T00:00:00.000Z"));
    expect(rows[0].note).toContain("— lapses 2027-07-01");
  });

  it("the migration gap (asOf precedes the first period): the pass is an honest no-op", async () => {
    db.leavePeriod.findMany.mockResolvedValue([FISCAL_27_ROW]);
    db.leaveType.findMany.mockResolvedValue([EARNED_TYPE]);

    const report = await runLeaveAllocationJob(new Date("2027-01-15T00:00:00Z"));

    expect(report).toMatchObject({
      grantsWritten: 0,
      carryRowsWritten: 0,
      expireRowsWritten: 0,
      failures: 0,
    });
    expect(db.leaveBalance.findMany).not.toHaveBeenCalled();
    expect(db.leaveLedgerEntry.createMany).not.toHaveBeenCalled();
    expect(db.leaveLedgerEntry.create).not.toHaveBeenCalled();
  });
});
