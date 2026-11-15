import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// G5 — the reconcile engine: matched → AttendanceRecord, unmatched → the
// exception queue, duplicates never double-record, partial windows
// re-derive the same record, manual marks outrank the engine, the F-R15
// non-working-day rule, and idempotency (the same window twice → the
// same records, zero writes the second time).
// ---------------------------------------------------------------------------

const db = vi.hoisted(() => {
  const models = ["biometricDevice", "deviceUserMapping", "punch", "attendanceRecord", "holidayCalendarEntry"];
  const methods = [
    "findMany", "findUnique", "findFirst", "create", "createMany", "update",
    "updateMany", "delete", "deleteMany", "upsert", "count", "aggregate", "groupBy",
  ];
  const obj: Record<string, Record<string, ReturnType<typeof vi.fn>>> = {};
  for (const m of models) {
    obj[m] = {};
    for (const meth of methods) obj[m][meth] = vi.fn();
  }
  (obj as Record<string, unknown>).$transaction = vi.fn(
    async (fn: unknown) => (typeof fn === "function" ? fn(obj) : Promise.all(fn as unknown[])),
  );
  return obj;
});
vi.mock("@/lib/infra/db", () => ({ db }));

const getWorkspaceConfigMock = vi.fn();
vi.mock("@/lib/infra/config-loader", () => ({
  getWorkspaceConfig: (...a: unknown[]) => getWorkspaceConfigMock(...a),
}));

import { reconcilePunches } from "../reconcile";

// --- fixtures ---------------------------------------------------------------
// NZ Tuesday 2026-11-10 (NZDT, UTC+13).
const AT_IN_0900 = "2026-11-09T20:00:00.000Z"; // 09:00 NZ
const AT_IN_0905 = "2026-11-09T20:05:00.000Z"; // 09:05 NZ
const AT_IN_0901 = "2026-11-09T20:01:00.000Z"; // 09:01 NZ (double-tap)
const AT_OUT_1730 = "2026-11-10T04:30:00.000Z"; // 17:30 NZ
const AT_OUT_1735 = "2026-11-10T04:35:00.000Z"; // 17:35 NZ
const WEEK_WINDOW: [Date, Date] = [new Date("2026-11-08T00:00:00Z"), new Date("2026-11-12T00:00:00Z")];

function deviceRow(config: unknown = { breakMinutes: 30 }) {
  return {
    id: "dev1",
    name: "Front door scanner",
    vendor: "ZKTECO",
    protocol: "ADMS_PUSH",
    serial: null,
    location: null,
    lastSyncAt: null,
    isActive: true,
    config,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function punchRow(o: {
  id: string;
  punchedAt: string;
  direction?: string;
  deviceUserId?: string;
  employeeId?: string | null;
  reconciliationStatus?: string;
  attendanceRecordId?: string | null;
}) {
  return {
    id: o.id,
    deviceId: "dev1",
    deviceUserId: o.deviceUserId ?? "1001",
    employeeId: o.employeeId ?? null,
    punchedAt: new Date(o.punchedAt),
    direction: o.direction ?? "UNKNOWN",
    verifyMethod: null,
    rawPayload: null,
    matchedAt: null,
    reconciliationStatus: o.reconciliationStatus ?? "PENDING",
    attendanceRecordId: o.attendanceRecordId ?? null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

const MAPPINGS = [
  { id: "m1", deviceId: "dev1", deviceUserId: "1001", employeeId: "u-yuki", createdAt: new Date(), updatedAt: new Date() },
];

function setup(opts: {
  device?: ReturnType<typeof deviceRow> | null;
  mappings?: typeof MAPPINGS;
  windowPunches?: ReturnType<typeof punchRow>[];
  attendedByDay?: ReturnType<typeof punchRow>[];
  existingRecord?: Record<string, unknown> | null;
} = {}) {
  db.biometricDevice.findUnique.mockResolvedValue(opts.device === undefined ? deviceRow() : opts.device);
  db.deviceUserMapping.findMany.mockResolvedValue(opts.mappings === undefined ? MAPPINGS : opts.mappings);
  db.holidayCalendarEntry.findMany.mockResolvedValue([]);
  const windowPunches = opts.windowPunches ?? [];
  const attendedByDay = opts.attendedByDay ?? [];
  let findManyCalls = 0;
  db.punch.findMany.mockImplementation(async () => {
    findManyCalls++;
    return findManyCalls === 1 ? windowPunches : attendedByDay;
  });
  db.attendanceRecord.findUnique.mockResolvedValue(opts.existingRecord ?? null);
  db.attendanceRecord.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: "rec1",
    ...data,
  }));
  db.attendanceRecord.update.mockResolvedValue({ id: "recX" });
  db.punch.updateMany.mockResolvedValue({ count: 1 });
  getWorkspaceConfigMock.mockResolvedValue({
    workspace: { attendanceDayStart: "09:00", attendanceDayEnd: "17:30" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("reconcilePunches — the derivation pass", () => {
  it("derives an AttendanceRecord from matched punches (break deducted, S2 facts, links)", async () => {
    setup({
      windowPunches: [
        punchRow({ id: "p1", punchedAt: AT_IN_0905, direction: "IN" }),
        punchRow({ id: "p2", punchedAt: AT_OUT_1735, direction: "OUT" }),
      ],
    });
    const report = await reconcilePunches("dev1", ...WEEK_WINDOW);

    // The record: NZ day 2026-11-10, 09:05 → 17:35, 30m break → 8.00h.
    expect(db.attendanceRecord.create).toHaveBeenCalledTimes(1);
    const data = db.attendanceRecord.create.mock.calls[0][0].data;
    expect(data.userId).toBe("u-yuki");
    expect(data.date.toISOString()).toBe("2026-11-10T00:00:00.000Z");
    expect(data.status).toBe("PRESENT");
    expect(data.source).toBe("BIOMETRIC");
    expect(data.inTime).toBe("09:05");
    expect(data.outTime).toBe("17:35");
    expect(data.workingHours).toBe(8); // 8h30m span − 30m break
    expect(data.lateMinutes).toBe(5); // vs the 09:00 day start
    expect(data.earlyMinutes).toBe(0);
    expect(data.overtimeMinutes).toBe(5); // past the 17:30 day end
    expect(data.note).toContain("Front door scanner");
    expect(data.note).toContain("30m break deducted");

    // The punches: ATTENDED + employee + the record link.
    expect(db.punch.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["p1", "p2"] } },
      data: expect.objectContaining({
        employeeId: "u-yuki",
        reconciliationStatus: "ATTENDED",
        attendanceRecordId: "rec1",
      }),
    });
    expect(report).toMatchObject({
      deviceId: "dev1",
      processed: 2,
      matched: 2,
      attended: 2,
      unmatched: 0,
      duplicates: 0,
      recordsCreated: 1,
      recordsUpdated: 0,
      recordsSkippedExisting: 0,
      daysSkippedNonWorking: 0,
      missingOutDays: 0,
      missingInDays: 0,
    });
  });

  it("leaves punches UNMATCHED when no mapping exists (the exception queue's input)", async () => {
    setup({
      mappings: [],
      windowPunches: [punchRow({ id: "p1", punchedAt: AT_IN_0905, direction: "IN" })],
    });
    const report = await reconcilePunches("dev1", ...WEEK_WINDOW);
    expect(db.punch.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["p1"] } },
      data: { reconciliationStatus: "UNMATCHED", employeeId: null, matchedAt: null },
    });
    expect(db.attendanceRecord.create).not.toHaveBeenCalled();
    expect(report).toMatchObject({ processed: 1, matched: 0, unmatched: 1, recordsCreated: 0 });
  });

  it("collapses near-duplicate double-taps — one record, the duplicate never re-records", async () => {
    setup({
      windowPunches: [
        punchRow({ id: "p1", punchedAt: AT_IN_0900, direction: "IN" }),
        punchRow({ id: "p2", punchedAt: AT_IN_0901, direction: "IN" }), // 1 minute later
        punchRow({ id: "p3", punchedAt: AT_OUT_1730, direction: "OUT" }),
      ],
    });
    const report = await reconcilePunches("dev1", ...WEEK_WINDOW);
    expect(db.attendanceRecord.create).toHaveBeenCalledTimes(1);
    expect(db.attendanceRecord.create.mock.calls[0][0].data.inTime).toBe("09:00");
    expect(db.punch.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["p2"] } },
      data: expect.objectContaining({ reconciliationStatus: "DUPLICATE", employeeId: "u-yuki" }),
    });
    expect(db.punch.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["p1", "p3"] } },
      data: expect.objectContaining({ reconciliationStatus: "ATTENDED" }),
    });
    expect(report).toMatchObject({ matched: 3, attended: 2, duplicates: 1, recordsCreated: 1 });
  });

  it("collapses exact-instant re-reports (direction flapping)", async () => {
    setup({
      windowPunches: [
        punchRow({ id: "p1", punchedAt: AT_IN_0900, direction: "IN" }),
        punchRow({ id: "p2", punchedAt: AT_IN_0900, direction: "UNKNOWN" }),
      ],
    });
    const report = await reconcilePunches("dev1", ...WEEK_WINDOW);
    expect(report.duplicates).toBe(1);
    expect(db.attendanceRecord.create).toHaveBeenCalledTimes(1);
  });

  it("is idempotent: a second pass over the same window writes nothing", async () => {
    setup({ windowPunches: [] }); // everything already terminal
    const report = await reconcilePunches("dev1", ...WEEK_WINDOW);
    expect(report).toMatchObject({
      processed: 0,
      matched: 0,
      attended: 0,
      unmatched: 0,
      duplicates: 0,
      recordsCreated: 0,
      recordsUpdated: 0,
    });
    expect(db.deviceUserMapping.findMany).not.toHaveBeenCalled();
    expect(db.attendanceRecord.create).not.toHaveBeenCalled();
    expect(db.attendanceRecord.update).not.toHaveBeenCalled();
    expect(db.punch.updateMany).not.toHaveBeenCalled();
  });

  it("re-derives over earlier attended punches (partial windows never clobber one side)", async () => {
    setup({
      windowPunches: [punchRow({ id: "po", punchedAt: AT_OUT_1735, direction: "OUT" })],
      attendedByDay: [
        punchRow({
          id: "pa",
          punchedAt: AT_IN_0905,
          direction: "IN",
          employeeId: "u-yuki",
          reconciliationStatus: "ATTENDED",
          attendanceRecordId: "rec0",
        }),
      ],
      existingRecord: { id: "rec0", source: "BIOMETRIC", userId: "u-yuki" },
    });
    const report = await reconcilePunches("dev1", ...WEEK_WINDOW);
    expect(db.attendanceRecord.update).toHaveBeenCalledTimes(1);
    const data = db.attendanceRecord.update.mock.calls[0][0].data;
    expect(data.inTime).toBe("09:05"); // from the earlier attended punch
    expect(data.outTime).toBe("17:35"); // from this batch
    // Only the BATCH punch flips.
    expect(db.punch.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["po"] } },
      data: expect.objectContaining({ reconciliationStatus: "ATTENDED", attendanceRecordId: "rec0" }),
    });
    expect(report).toMatchObject({ processed: 1, recordsUpdated: 1 });
  });

  it("never overwrites a MANUAL/DERIVED mark — links the punches onto it instead", async () => {
    setup({
      windowPunches: [punchRow({ id: "p1", punchedAt: AT_IN_0905, direction: "IN" })],
      existingRecord: { id: "recM", source: "MANUAL", userId: "u-yuki" },
    });
    const report = await reconcilePunches("dev1", ...WEEK_WINDOW);
    expect(db.attendanceRecord.create).not.toHaveBeenCalled();
    expect(db.attendanceRecord.update).not.toHaveBeenCalled();
    expect(db.punch.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["p1"] } },
      data: expect.objectContaining({ attendanceRecordId: "recM", reconciliationStatus: "ATTENDED" }),
    });
    expect(report.recordsSkippedExisting).toBe(1);
  });

  it("skips non-working days (F-R15): punches ATTENDED, no record created", async () => {
    // NZ Saturday 2026-11-14: 10:00 → 16:00 NZDT.
    setup({
      windowPunches: [
        punchRow({ id: "p1", punchedAt: "2026-11-13T21:00:00.000Z" }),
        punchRow({ id: "p2", punchedAt: "2026-11-14T03:00:00.000Z" }),
      ],
    });
    const report = await reconcilePunches("dev1", new Date("2026-11-12T00:00:00Z"), new Date("2026-11-16T00:00:00Z"));
    expect(db.attendanceRecord.create).not.toHaveBeenCalled();
    expect(db.punch.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["p1", "p2"] } },
      data: expect.objectContaining({ reconciliationStatus: "ATTENDED", employeeId: "u-yuki" }),
    });
    const data = db.punch.updateMany.mock.calls[0][0].data;
    expect(data).not.toHaveProperty("attendanceRecordId");
    expect(report).toMatchObject({ daysSkippedNonWorking: 1, attended: 2, recordsCreated: 0 });
  });

  it("an IN-only day still records (missing OUT is an exception, not a skip)", async () => {
    setup({ windowPunches: [punchRow({ id: "p1", punchedAt: AT_IN_0905, direction: "IN" })] });
    const report = await reconcilePunches("dev1", ...WEEK_WINDOW);
    const data = db.attendanceRecord.create.mock.calls[0][0].data;
    expect(data.outTime).toBeNull();
    expect(data.workingHours).toBeNull();
    expect(data.overtimeMinutes).toBeNull();
    expect(report.missingOutDays).toBe(1);
  });

  it("an OUT-only day surfaces missingIn", async () => {
    setup({ windowPunches: [punchRow({ id: "p1", punchedAt: AT_OUT_1735, direction: "OUT" })] });
    const report = await reconcilePunches("dev1", ...WEEK_WINDOW);
    expect(report.missingInDays).toBe(1);
    expect(report.missingOutDays).toBe(0);
  });

  it("deducts no break when the device config is absent", async () => {
    setup({
      device: deviceRow(null),
      windowPunches: [
        punchRow({ id: "p1", punchedAt: AT_IN_0900, direction: "IN" }),
        punchRow({ id: "p2", punchedAt: AT_OUT_1730, direction: "OUT" }),
      ],
    });
    await reconcilePunches("dev1", ...WEEK_WINDOW);
    expect(db.attendanceRecord.create.mock.calls[0][0].data.workingHours).toBe(8.5);
  });

  it("throws when the device does not exist", async () => {
    setup({ device: null });
    await expect(reconcilePunches("nope", ...WEEK_WINDOW)).rejects.toThrow(/not found/i);
  });
});
