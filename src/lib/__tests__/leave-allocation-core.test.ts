import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// F2.4 — leave-allocation job core tests (the cron's three writers).
// Grants advance strategies idempotently; the year-end rollover writes the
// CARRY/EXPIRE pair once; the carry lapse expires unspent carry once; one
// failing pair never fails the pass. db is mocked (the hr-leave.test.ts
// harness pattern — the rule itself is fully covered in leave-policy.test).
// ---------------------------------------------------------------------------

const db = vi.hoisted(() => {
  const models = ["leaveType", "leaveBalance", "leaveLedgerEntry", "employeeProfile"];
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

const logErrorSpy = vi.fn();
const logInfoSpy = vi.fn();
vi.mock("@/lib/observability", () => ({
  logError: (...a: unknown[]) => logErrorSpy(...a),
  logInfo: (...a: unknown[]) => logInfoSpy(...a),
  captureError: vi.fn(),
}));

import { runLeaveAllocationJob } from "@/lib/leave-allocation-core";

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

describe("runLeaveAllocationJob — carry lapse phase", () => {
  const LAPSING_TYPE = {
    ...EARNED_TYPE,
    id: "lt-lapse",
    policy: { ...EARNED_TYPE.policy, id: "lp-3", leaveTypeId: "lt-lapse", allocationStrategy: "MANUAL", carryExpiresAfterMonths: 3 },
  };

  it("expires the unspent carry once N months elapsed (FIFO)", async () => {
    db.leaveType.findMany.mockResolvedValue([LAPSING_TYPE]);
    db.leaveBalance.findMany.mockImplementation(async (args: { where?: { year?: number } }) =>
      args?.where?.year === 2026 ? [{ userId: "u1" }] : [],
    );
    // 5 carried, 2 consumed → 3 unspent → EXPIRE −3 on April 1st or later.
    groupsBy({ CARRY: 5, CONSUME: -2 });

    const before = await runLeaveAllocationJob(new Date("2026-03-31T00:00:00Z"));
    expect(before.expireRowsWritten).toBe(0); // March: only 2 complete months

    const report = await runLeaveAllocationJob(new Date("2026-04-01T00:00:00Z"));
    expect(report.expireRowsWritten).toBe(1);
    expect(db.leaveLedgerEntry.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ entryType: "EXPIRE", delta: -3, sourceType: "POLICY", sourceId: "carry-lapse" }),
      }),
    );
  });

  it("never lapses when the type has no carryExpiresAfterMonths", async () => {
    db.leaveType.findMany.mockResolvedValue([MANUAL_TYPE]);
    db.leaveBalance.findMany.mockImplementation(async (args: { where?: { year?: number } }) =>
      args?.where?.year === 2026 ? [{ userId: "u1" }] : [],
    );
    groupsBy({ CARRY: 5 });
    const report = await runLeaveAllocationJob(new Date("2026-12-31T00:00:00Z"));
    expect(report.expireRowsWritten).toBe(0);
  });
});
