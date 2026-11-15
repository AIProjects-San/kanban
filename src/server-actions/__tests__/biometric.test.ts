import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// G5 — the biometric action tests: the manual override (status flip +
// audit + idempotency), the ignore dismissal, the exception queue reader,
// the CSV fallback imports, the device CRUD guards, the connection probe
// (adapter seam), and the attendance:manage gate on every action.
// The pure rules live in lib/biometric/__tests__/*.
// ---------------------------------------------------------------------------

const db = vi.hoisted(() => {
  const models = [
    "biometricDevice", "deviceUserMapping", "punch", "attendanceRecord",
    "holidayCalendarEntry", "user", "auditLog",
  ];
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

const requirePermissionMock = vi.fn();
vi.mock("@/server-actions/auth-guard", () => ({
  requirePermission: (...a: unknown[]) => requirePermissionMock(...a),
  AuthorizationError: class AuthorizationError extends Error {
    readonly digest = "AuthorizationError";
    constructor(m: string) {
      super(m);
      this.name = "AuthorizationError";
    }
  },
}));

const logAuditMock = vi.fn();
vi.mock("@/server-actions/shared", () => ({
  logAudit: (...a: unknown[]) => logAuditMock(...a),
}));

const reconcilePunchesMock = vi.fn();
vi.mock("@/lib/biometric/reconcile", () => ({
  reconcilePunches: (...a: unknown[]) => reconcilePunchesMock(...a),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import {
  getBiometricDevices,
  getDeviceMappings,
  getPunchLog,
  createBiometricDevice,
  updateBiometricDevice,
  deleteBiometricDevice,
  createDeviceMapping,
  deleteDeviceMapping,
  importDeviceMappings,
  testDeviceConnection,
  importPunchesCsv,
  reconcileDevicePunches,
  matchPunchToEmployee,
  ignorePunch,
  getAttendanceExceptions,
} from "../biometric";

const HR_AUTH = { userId: "u-hr", role: "HR" as const, name: "Remy", email: "remy@x.co" };

function deviceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "dev1",
    name: "Front door scanner",
    vendor: "ZKTECO",
    protocol: "ADMS_PUSH",
    serial: null,
    location: null,
    lastSyncAt: null,
    isActive: true,
    config: { pushToken: "tok_9f3ab2c1de4567ef" },
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function punchRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "p1",
    deviceId: "dev1",
    deviceUserId: "9999",
    employeeId: null,
    punchedAt: new Date("2026-11-09T20:05:00.000Z"),
    direction: "IN",
    verifyMethod: null,
    rawPayload: null,
    matchedAt: null,
    reconciliationStatus: "UNMATCHED",
    attendanceRecordId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    device: { name: "Front door scanner" },
    employee: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  requirePermissionMock.mockResolvedValue(HR_AUTH);
  db.biometricDevice.findUnique.mockResolvedValue(deviceRow());
  db.user.findUnique.mockResolvedValue({ id: "u-yuki", name: "Yuki Tanaka", deletedAt: null });
});

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

describe("the attendance:manage gate", () => {
  it("refuses every reader/writer without the permission", async () => {
    requirePermissionMock.mockRejectedValue(
      Object.assign(new Error("forbidden"), { name: "AuthorizationError", digest: "AuthorizationError" }),
    );
    await expect(getBiometricDevices()).resolves.toMatchObject({ ok: false, code: "AUTH" });
    await expect(matchPunchToEmployee({ punchId: "p1", employeeId: "u-yuki" })).resolves.toMatchObject({ ok: false, code: "AUTH" });
  });
});

// ---------------------------------------------------------------------------
// The manual override (the exception queue's core action)
// ---------------------------------------------------------------------------

describe("matchPunchToEmployee — the manual override", () => {
  it("flips an UNMATCHED punch to MATCHED, records who + when via the audit", async () => {
    db.punch.findUnique.mockResolvedValue(punchRow());
    db.punch.updateMany.mockResolvedValue({ count: 1 });
    const res = await matchPunchToEmployee({ punchId: "p1", employeeId: "u-yuki" });
    expect(res.ok).toBe(true);
    expect(db.punch.updateMany).toHaveBeenCalledWith({
      where: { id: "p1", reconciliationStatus: { in: ["PENDING", "UNMATCHED", "IGNORED", "MATCHED"] } },
      data: {
        employeeId: "u-yuki",
        reconciliationStatus: "MATCHED",
        matchedAt: expect.any(Date),
      },
    });
    expect(logAuditMock).toHaveBeenCalledTimes(1);
    const entry = logAuditMock.mock.calls[0][0];
    expect(entry.action).toBe("biometric.punch_matched");
    expect(entry.actor).toEqual(HR_AUTH);
    expect(entry.detail).toContain("Remy");
    expect(entry.detail).toContain("Yuki Tanaka");
    expect(entry.detail).toContain("next reconcile pass");
  });

  it("is idempotent — re-matching the same punch to the same employee is a no-op", async () => {
    db.punch.findUnique.mockResolvedValue(punchRow({ reconciliationStatus: "MATCHED", employeeId: "u-yuki" }));
    const res = await matchPunchToEmployee({ punchId: "p1", employeeId: "u-yuki" });
    expect(res.ok).toBe(true);
    expect(db.punch.updateMany).not.toHaveBeenCalled();
    expect(logAuditMock).not.toHaveBeenCalled();
  });

  it("refuses punches already reconciled into attendance", async () => {
    db.punch.findUnique.mockResolvedValue(punchRow({ reconciliationStatus: "ATTENDED", employeeId: "u-yuki" }));
    const res = await matchPunchToEmployee({ punchId: "p1", employeeId: "u-yuki" });
    expect(res).toMatchObject({ ok: false, code: "AUTH" });
    expect(db.punch.updateMany).not.toHaveBeenCalled();
  });

  it("refuses a vanished employee", async () => {
    db.punch.findUnique.mockResolvedValue(punchRow());
    db.user.findUnique.mockResolvedValue(null);
    const res = await matchPunchToEmployee({ punchId: "p1", employeeId: "u-gone" });
    expect(res).toMatchObject({ ok: false, code: "AUTH" });
  });
});

describe("ignorePunch", () => {
  it("dismisses an overridable punch and audits it", async () => {
    db.punch.findUnique.mockResolvedValue(punchRow());
    db.punch.updateMany.mockResolvedValue({ count: 1 });
    const res = await ignorePunch({ punchId: "p1" });
    expect(res.ok).toBe(true);
    expect(db.punch.updateMany).toHaveBeenCalledWith({
      where: { id: "p1", reconciliationStatus: { in: ["PENDING", "UNMATCHED", "MATCHED"] } },
      data: { reconciliationStatus: "IGNORED" },
    });
    expect(logAuditMock).toHaveBeenCalledTimes(1);
    expect(logAuditMock.mock.calls[0][0].action).toBe("biometric.punch_ignored");
  });

  it("is a no-op when already ignored, and refuses finalized punches", async () => {
    db.punch.findUnique.mockResolvedValue(punchRow({ reconciliationStatus: "IGNORED" }));
    await expect(ignorePunch({ punchId: "p1" })).resolves.toMatchObject({ ok: true });
    expect(db.punch.updateMany).not.toHaveBeenCalled();

    db.punch.findUnique.mockResolvedValue(punchRow({ reconciliationStatus: "DUPLICATE" }));
    await expect(ignorePunch({ punchId: "p1" })).resolves.toMatchObject({ ok: false, code: "AUTH" });
  });
});

// ---------------------------------------------------------------------------
// The exception queue reader
// ---------------------------------------------------------------------------

describe("getAttendanceExceptions", () => {
  it("surfaces unmatched punches, duplicates, and the one-sided days", async () => {
    const punchCalls: unknown[] = [];
    db.punch.findMany.mockImplementation(async (args: unknown) => {
      punchCalls.push(args);
      // call 1 = unmatched, call 2 = duplicates
      if (punchCalls.length === 1) {
        return [punchRow({ id: "pu1", deviceUserId: "9999", reconciliationStatus: "UNMATCHED" })];
      }
      return [punchRow({ id: "pd1", employeeId: "u-yuki", reconciliationStatus: "DUPLICATE", employee: { name: "Yuki Tanaka" } })];
    });
    db.attendanceRecord.findMany.mockResolvedValue([
      { id: "r1", userId: "u-yuki", date: new Date("2026-11-10T00:00:00Z"), inTime: "09:05", outTime: null, source: "BIOMETRIC" },
      { id: "r2", userId: "u-yuki", date: new Date("2026-11-11T00:00:00Z"), inTime: null, outTime: "17:35", source: "BIOMETRIC" },
    ]);
    db.user.findMany.mockResolvedValue([{ id: "u-yuki", name: "Yuki Tanaka" }]);

    const res = await getAttendanceExceptions({});
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.unmatched).toHaveLength(1);
    expect(res.data.unmatched[0]).toMatchObject({ id: "pu1", deviceUserId: "9999", employeeName: null });
    expect(res.data.duplicates).toHaveLength(1);
    expect(res.data.duplicates[0].employeeName).toBe("Yuki Tanaka");
    expect(res.data.missingOut).toEqual([
      expect.objectContaining({ recordId: "r1", employeeName: "Yuki Tanaka", day: "2026-11-10", inTime: "09:05", outTime: null }),
    ]);
    expect(res.data.missingIn).toEqual([
      expect.objectContaining({ recordId: "r2", day: "2026-11-11", inTime: null, outTime: "17:35" }),
    ]);
    expect(res.data.employees).toEqual([{ id: "u-yuki", name: "Yuki Tanaka" }]);
  });
});

// ---------------------------------------------------------------------------
// The CSV fallbacks
// ---------------------------------------------------------------------------

describe("importPunchesCsv", () => {
  it("round-trips a CSV into PENDING Punch rows, counting re-deliveries", async () => {
    db.punch.create
      .mockResolvedValueOnce({ id: "p1" })
      .mockRejectedValueOnce(Object.assign(new Error("unique"), { code: "P2002" }));
    const res = await importPunchesCsv({
      deviceId: "dev1",
      csv: "deviceUserId,punchedAt,direction\n1001,2026-11-10 09:05,IN\n1001,2026-11-10 09:05,IN\n",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toEqual({ inserted: 1, duplicates: 1 });
    expect(db.punch.create).toHaveBeenCalledTimes(2);
    const data = db.punch.create.mock.calls[0][0].data;
    expect(data.deviceId).toBe("dev1");
    expect(data.deviceUserId).toBe("1001");
    expect(data.punchedAt.toISOString()).toBe("2026-11-09T20:05:00.000Z"); // NZ naive
    expect(data.direction).toBe("IN");
    expect(data.rawPayload).toEqual({ source: "csv" });
    expect(data.reconciliationStatus).toBeUndefined(); // PENDING by default
    expect(db.biometricDevice.update).toHaveBeenCalledWith({
      where: { id: "dev1" },
      data: { lastSyncAt: expect.any(Date) },
    });
    expect(logAuditMock.mock.calls[0][0].action).toBe("biometric.punches_imported");
  });

  it("rejects a malformed CSV with a row-level VALIDATION error", async () => {
    const res = await importPunchesCsv({ deviceId: "dev1", csv: "deviceUserId,punchedAt\n1001,not-a-time\n" });
    expect(res).toMatchObject({ ok: false, code: "VALIDATION" });
    expect(db.punch.create).not.toHaveBeenCalled();
  });

  it("refuses an unknown device", async () => {
    db.biometricDevice.findUnique.mockResolvedValue(null);
    const res = await importPunchesCsv({ deviceId: "nope", csv: "deviceUserId,punchedAt\n1,2026-11-10 09:05\n" });
    expect(res).toMatchObject({ ok: false, code: "AUTH" });
  });
});

describe("importDeviceMappings", () => {
  it("imports by email, resolving every employee up front (all-or-nothing)", async () => {
    db.user.findMany.mockImplementation(async (args: unknown) => {
      const where = (args as { where?: { email?: { in: string[] } } }).where;
      if (where?.email?.in) {
        return where.email.in.map((e: string) => ({ id: "u-yuki", email: e, name: "Yuki Tanaka" }));
      }
      return [{ id: "u-yuki", name: "Yuki Tanaka" }];
    });
    db.deviceUserMapping.create.mockResolvedValue({ id: "m1" });
    const res = await importDeviceMappings({
      deviceId: "dev1",
      csv: "deviceUserId,employeeEmail\n1001,yuki@fernly.example\n",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.created).toBe(1);
    expect(db.deviceUserMapping.create).toHaveBeenCalledWith({
      data: { deviceId: "dev1", deviceUserId: "1001", employeeId: "u-yuki" },
    });
    expect(logAuditMock.mock.calls[0][0].action).toBe("biometric.mappings_imported");
  });

  it("rejects the whole import when an employee is unknown (no partial mappings)", async () => {
    db.user.findMany.mockResolvedValue([]);
    const res = await importDeviceMappings({
      deviceId: "dev1",
      csv: "deviceUserId,employeeEmail\n1001,ghost@fernly.example\n",
    });
    expect(res).toMatchObject({ ok: false, code: "VALIDATION" });
    expect(db.deviceUserMapping.create).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Devices + the reconcile trigger
// ---------------------------------------------------------------------------

describe("device CRUD guards", () => {
  it("creates a device with the config JSON (token + break)", async () => {
    db.biometricDevice.create.mockResolvedValue(deviceRow());
    const res = await createBiometricDevice({
      name: "Front door scanner",
      vendor: "ZKTECO",
      protocol: "ADMS_PUSH",
      pushToken: "tok_9f3ab2c1de4567ef",
      breakMinutes: 30,
    });
    expect(res.ok).toBe(true);
    expect(db.biometricDevice.create.mock.calls[0][0].data.config).toEqual({
      pushToken: "tok_9f3ab2c1de4567ef",
      breakMinutes: 30,
    });
    expect(logAuditMock.mock.calls[0][0].action).toBe("biometric.device_created");
  });

  it("blocks deleting a device with punch history (retire instead)", async () => {
    db.punch.count.mockResolvedValue(42);
    db.deviceUserMapping.count.mockResolvedValue(0);
    const res = await deleteBiometricDevice({ deviceId: "dev1" });
    expect(res).toMatchObject({ ok: false, code: "AUTH", error: expect.stringContaining("Deactivate the device instead") });
    expect(db.biometricDevice.delete).not.toHaveBeenCalled();
  });

  it("deletes a device with no punches and no mappings", async () => {
    db.punch.count.mockResolvedValue(0);
    db.deviceUserMapping.count.mockResolvedValue(0);
    db.biometricDevice.delete.mockResolvedValue(deviceRow());
    const res = await deleteBiometricDevice({ deviceId: "dev1" });
    expect(res.ok).toBe(true);
    expect(db.biometricDevice.delete).toHaveBeenCalledWith({ where: { id: "dev1" } });
    expect(logAuditMock.mock.calls[0][0].action).toBe("biometric.device_deleted");
  });
});

describe("testDeviceConnection — the adapter seam", () => {
  it("reports OK for a CSV_IMPORT device (the built-in fallback adapter)", async () => {
    db.biometricDevice.findUnique.mockResolvedValue(deviceRow({ protocol: "CSV_IMPORT" }));
    const res = await testDeviceConnection({ deviceId: "dev1" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toEqual({ ok: true });
    expect(logAuditMock.mock.calls[0][0].action).toBe("biometric.device_tested");
  });

  it("validates the push token for ADMS_PUSH devices (no adapter needed)", async () => {
    const res = await testDeviceConnection({ deviceId: "dev1" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toEqual({ ok: true });

    db.biometricDevice.findUnique.mockResolvedValue(deviceRow({ config: null }));
    const noToken = await testDeviceConnection({ deviceId: "dev1" });
    expect(noToken.ok).toBe(true);
    if (!noToken.ok) return;
    expect(noToken.data).toMatchObject({ ok: false });
    expect(noToken.data.error).toContain("push token");
  });

  it("reports the honest not-yet-available for poll/SDK vendors", async () => {
    db.biometricDevice.findUnique.mockResolvedValue(deviceRow({ protocol: "TCP_POLL" }));
    const res = await testDeviceConnection({ deviceId: "dev1" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toMatchObject({ ok: false });
    expect(res.data.error).toContain("vendor integration");
  });
});

describe("reconcileDevicePunches — the trigger", () => {
  it("runs the engine over the NZ-day window, audits + serializes the report", async () => {
    reconcilePunchesMock.mockResolvedValue({
      deviceId: "dev1",
      deviceName: "Front door scanner",
      windowStart: new Date("2026-11-08T00:00:00Z"),
      windowEnd: new Date("2026-11-12T00:00:00Z"),
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
    const res = await reconcileDevicePunches({ deviceId: "dev1", from: "2026-11-09", to: "2026-11-10" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // The window is the NZ days' bounds (instants), end inclusive-1ms.
    const [calledDevice, start, end] = reconcilePunchesMock.mock.calls[0];
    expect(calledDevice).toBe("dev1");
    expect(start.toISOString()).toBe("2026-11-08T11:00:00.000Z"); // 2026-11-09 00:00 NZDT
    expect(end.toISOString()).toBe("2026-11-10T10:59:59.999Z"); // 2026-11-11 00:00 NZDT − 1ms
    expect(res.data.processed).toBe(2);
    expect(res.data.windowStart).toBe("2026-11-08T00:00:00.000Z");
    expect(logAuditMock.mock.calls[0][0].action).toBe("biometric.reconciled");
  });

  it("refuses an inverted window", async () => {
    const res = await reconcileDevicePunches({ deviceId: "dev1", from: "2026-11-10", to: "2026-11-09" });
    expect(res).toMatchObject({ ok: false, code: "AUTH" });
    expect(reconcilePunchesMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Readers (full coverage: serialization + filters + pagination)
// ---------------------------------------------------------------------------

describe("getBiometricDevices", () => {
  it("serializes the catalog with live punch/mapping counts", async () => {
    db.biometricDevice.findMany.mockResolvedValue([deviceRow({ config: { pushToken: "tok_9f3ab2c1de4567ef", breakMinutes: 45 } })]);
    db.punch.groupBy.mockResolvedValue([{ deviceId: "dev1", _count: { _all: 7 } }]);
    db.deviceUserMapping.groupBy.mockResolvedValue([{ deviceId: "dev1", _count: { _all: 2 } }]);
    const res = await getBiometricDevices();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toHaveLength(1);
    expect(res.data[0]).toMatchObject({
      id: "dev1",
      name: "Front door scanner",
      vendor: "ZKTECO",
      protocol: "ADMS_PUSH",
      hasPushToken: true,
      breakMinutes: 45,
      punchCount: 7,
      mappingCount: 2,
      isActive: true,
      lastSyncAt: null,
    });
  });

  it("maps missing group counts to zero", async () => {
    db.biometricDevice.findMany.mockResolvedValue([deviceRow({ config: null })]);
    db.punch.groupBy.mockResolvedValue([]);
    db.deviceUserMapping.groupBy.mockResolvedValue([]);
    const res = await getBiometricDevices();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data[0]).toMatchObject({ punchCount: 0, mappingCount: 0, hasPushToken: false, breakMinutes: 0 });
  });
});

describe("getDeviceMappings", () => {
  const mappingRow = {
    id: "m1",
    deviceId: "dev1",
    deviceUserId: "1001",
    employeeId: "u-yuki",
    createdAt: new Date("2026-11-01T00:00:00Z"),
    device: { name: "Front door scanner" },
    employee: { name: "Yuki Tanaka" },
  };

  it("returns mappings + the picker inputs (unscoped)", async () => {
    db.deviceUserMapping.findMany.mockResolvedValue([mappingRow]);
    db.biometricDevice.findMany.mockResolvedValue([{ id: "dev1", name: "Front door scanner" }]);
    db.user.findMany.mockResolvedValue([{ id: "u-yuki", name: "Yuki Tanaka" }]);
    const res = await getDeviceMappings();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.mappings).toEqual([
      {
        id: "m1",
        deviceId: "dev1",
        deviceName: "Front door scanner",
        deviceUserId: "1001",
        employeeId: "u-yuki",
        employeeName: "Yuki Tanaka",
        createdAt: "2026-11-01",
      },
    ]);
    expect(res.data.devices).toEqual([{ id: "dev1", name: "Front door scanner" }]);
    const findArgs = db.deviceUserMapping.findMany.mock.calls[0][0];
    expect(findArgs.where).toBeUndefined();
  });

  it("scopes to a device when given one", async () => {
    db.deviceUserMapping.findMany.mockResolvedValue([]);
    db.biometricDevice.findMany.mockResolvedValue([]);
    db.user.findMany.mockResolvedValue([]);
    const res = await getDeviceMappings({ deviceId: "dev1" });
    expect(res.ok).toBe(true);
    expect(db.deviceUserMapping.findMany.mock.calls[0][0].where).toEqual({ deviceId: "dev1" });
  });
});

describe("getPunchLog", () => {
  it("filters, paginates and serializes (NZ day/time projection)", async () => {
    db.punch.findMany.mockResolvedValue([
      punchRow({ id: "p1", punchedAt: new Date("2026-11-09T20:05:00.000Z"), employeeId: "u-yuki", employee: { name: "Yuki Tanaka" } }),
    ]);
    db.punch.count.mockResolvedValue(51);
    db.biometricDevice.findMany.mockResolvedValue([{ id: "dev1", name: "Front door scanner" }]);
    const res = await getPunchLog({ deviceId: "dev1", status: "UNMATCHED", from: "2026-11-09", to: "2026-11-10", page: 2 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const args = db.punch.findMany.mock.calls[0][0];
    expect(args.where).toEqual({
      deviceId: "dev1",
      reconciliationStatus: "UNMATCHED",
      punchedAt: {
        gte: new Date("2026-11-08T11:00:00.000Z"), // 2026-11-09 00:00 NZDT
        lt: new Date("2026-11-10T11:00:00.000Z"), // 2026-11-11 00:00 NZDT
      },
    });
    expect(args.skip).toBe(50);
    expect(args.take).toBe(50);
    expect(res.data.page).toBe(2);
    expect(res.data.pageCount).toBe(2);
    expect(res.data.punches[0]).toMatchObject({
      id: "p1",
      day: "2026-11-10",
      time: "09:05",
      employeeName: "Yuki Tanaka",
      deviceName: "Front door scanner",
    });
  });

  it("runs unfiltered (no window, no device) and floors at one page", async () => {
    db.punch.findMany.mockResolvedValue([]);
    db.punch.count.mockResolvedValue(0);
    db.biometricDevice.findMany.mockResolvedValue([]);
    const res = await getPunchLog({});
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(db.punch.findMany.mock.calls[0][0].where).toEqual({});
    expect(res.data.pageCount).toBe(1);
  });

  it("accepts a from-only window", async () => {
    db.punch.findMany.mockResolvedValue([]);
    db.punch.count.mockResolvedValue(0);
    db.biometricDevice.findMany.mockResolvedValue([]);
    const res = await getPunchLog({ from: "2026-11-09" });
    expect(res.ok).toBe(true);
    expect(db.punch.findMany.mock.calls[0][0].where).toEqual({
      punchedAt: { gte: new Date("2026-11-08T11:00:00.000Z") },
    });
  });
});

// ---------------------------------------------------------------------------
// Device writers — the remaining branches
// ---------------------------------------------------------------------------

describe("createBiometricDevice — collisions", () => {
  it("surfaces a duplicate serial as a friendly AUTH error", async () => {
    db.biometricDevice.create.mockRejectedValue(Object.assign(new Error("unique"), { code: "P2002" }));
    const res = await createBiometricDevice({
      name: "Second scanner",
      vendor: "OTHER",
      protocol: "CSV_IMPORT",
      serial: "SN-DUP",
    });
    expect(res).toMatchObject({ ok: false, code: "AUTH", error: expect.stringContaining("SN-DUP") });
  });
});

describe("updateBiometricDevice", () => {
  it("merges config, applies partial fields and audits the deactivation", async () => {
    db.biometricDevice.findUnique.mockResolvedValue(deviceRow({ config: { pushToken: "tok_9f3ab2c1de4567ef" } }));
    db.biometricDevice.update.mockResolvedValue(deviceRow());
    const res = await updateBiometricDevice({ deviceId: "dev1", isActive: false, breakMinutes: 45 });
    expect(res.ok).toBe(true);
    const args = db.biometricDevice.update.mock.calls[0][0];
    expect(args.where).toEqual({ id: "dev1" });
    expect(args.data.isActive).toBe(false);
    expect(args.data.config).toEqual({ pushToken: "tok_9f3ab2c1de4567ef", breakMinutes: 45 });
    expect(logAuditMock.mock.calls[0][0].detail).toContain("deactivated");
  });

  it("can rotate the push token and rename in one update", async () => {
    db.biometricDevice.findUnique.mockResolvedValue(deviceRow());
    const res = await updateBiometricDevice({ deviceId: "dev1", name: "Back door", pushToken: "tok_rotated_abcdef123456" });
    expect(res.ok).toBe(true);
    const args = db.biometricDevice.update.mock.calls[0][0];
    expect(args.data.name).toBe("Back door");
    expect(args.data.config).toEqual({ pushToken: "tok_rotated_abcdef123456" });
  });

  it("refuses an unknown device and surfaces serial collisions", async () => {
    db.biometricDevice.findUnique.mockResolvedValue(null);
    await expect(updateBiometricDevice({ deviceId: "nope", name: "X" })).resolves.toMatchObject({ ok: false, code: "AUTH" });

    db.biometricDevice.findUnique.mockResolvedValue(deviceRow());
    db.biometricDevice.update.mockRejectedValue(Object.assign(new Error("unique"), { code: "P2002" }));
    await expect(updateBiometricDevice({ deviceId: "dev1", serial: "SN-DUP" })).resolves.toMatchObject({
      ok: false,
      code: "AUTH",
      error: expect.stringContaining("SN-DUP"),
    });
  });
});

describe("deleteBiometricDevice — the mapping guard", () => {
  it("blocks deletion while mappings remain", async () => {
    db.punch.count.mockResolvedValue(0);
    db.deviceUserMapping.count.mockResolvedValue(3);
    const res = await deleteBiometricDevice({ deviceId: "dev1" });
    expect(res).toMatchObject({ ok: false, code: "AUTH", error: expect.stringContaining("mapping") });
    expect(db.biometricDevice.delete).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Mapping writers — the remaining branches
// ---------------------------------------------------------------------------

describe("createDeviceMapping", () => {
  it("creates the mapping and audits the link", async () => {
    db.biometricDevice.findUnique.mockResolvedValue({ id: "dev1", name: "Front door scanner" });
    db.user.findUnique.mockResolvedValue({ id: "u-yuki", name: "Yuki Tanaka", deletedAt: null });
    db.deviceUserMapping.create.mockResolvedValue({ id: "m1" });
    const res = await createDeviceMapping({ deviceId: "dev1", deviceUserId: "1001", employeeId: "u-yuki" });
    expect(res.ok).toBe(true);
    expect(db.deviceUserMapping.create).toHaveBeenCalledWith({
      data: { deviceId: "dev1", deviceUserId: "1001", employeeId: "u-yuki" },
    });
    expect(logAuditMock.mock.calls[0][0].action).toBe("biometric.mapping_created");
  });

  it("surfaces both unique directions as one friendly error", async () => {
    db.biometricDevice.findUnique.mockResolvedValue({ id: "dev1", name: "Front door scanner" });
    db.user.findUnique.mockResolvedValue({ id: "u-yuki", name: "Yuki Tanaka", deletedAt: null });
    db.deviceUserMapping.create.mockRejectedValue(Object.assign(new Error("unique"), { code: "P2002" }));
    const res = await createDeviceMapping({ deviceId: "dev1", deviceUserId: "1001", employeeId: "u-yuki" });
    expect(res).toMatchObject({ ok: false, code: "AUTH", error: expect.stringContaining("already mapped") });
  });

  it("refuses an unknown device or a soft-deleted employee", async () => {
    db.biometricDevice.findUnique.mockResolvedValue(null);
    await expect(createDeviceMapping({ deviceId: "nope", deviceUserId: "1", employeeId: "u-yuki" })).resolves.toMatchObject({ ok: false, code: "AUTH" });

    db.biometricDevice.findUnique.mockResolvedValue({ id: "dev1", name: "Scanner" });
    db.user.findUnique.mockResolvedValue({ id: "u-gone", name: "Gone", deletedAt: new Date() });
    await expect(createDeviceMapping({ deviceId: "dev1", deviceUserId: "1", employeeId: "u-gone" })).resolves.toMatchObject({ ok: false, code: "AUTH" });
  });
});

describe("deleteDeviceMapping", () => {
  it("removes the mapping and audits it", async () => {
    db.deviceUserMapping.findUnique.mockResolvedValue({
      id: "m1",
      deviceUserId: "1001",
      device: { name: "Front door scanner" },
      employee: { name: "Yuki Tanaka" },
    });
    db.deviceUserMapping.delete.mockResolvedValue({});
    const res = await deleteDeviceMapping({ mappingId: "m1" });
    expect(res.ok).toBe(true);
    expect(db.deviceUserMapping.delete).toHaveBeenCalledWith({ where: { id: "m1" } });
    expect(logAuditMock.mock.calls[0][0].action).toBe("biometric.mapping_deleted");
  });

  it("refuses an unknown mapping", async () => {
    db.deviceUserMapping.findUnique.mockResolvedValue(null);
    await expect(deleteDeviceMapping({ mappingId: "nope" })).resolves.toMatchObject({ ok: false, code: "AUTH" });
  });
});

// ---------------------------------------------------------------------------
// The remaining import + guarded-flip branches
// ---------------------------------------------------------------------------

describe("importDeviceMappings — id-column + duplicate counting", () => {
  it("resolves the employeeId column too", async () => {
    db.user.findMany.mockImplementation(async (args: unknown) => {
      const where = (args as { where?: { id?: { in: string[] } } }).where;
      if (where?.id?.in) return where.id.in.map((i: string) => ({ id: i, name: "Yuki Tanaka" }));
      return [];
    });
    db.deviceUserMapping.create.mockResolvedValue({ id: "m1" });
    const res = await importDeviceMappings({
      deviceId: "dev1",
      csv: "deviceUserId,employeeId\n1001,u-yuki\n",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toEqual({ created: 1, duplicates: 0 });
  });

  it("counts already-mapped rows instead of failing", async () => {
    db.user.findMany.mockImplementation(async (args: unknown) => {
      const where = (args as { where?: { email?: { in: string[] } } }).where;
      if (where?.email?.in) return where.email.in.map((e: string) => ({ id: "u-yuki", email: e, name: "Yuki Tanaka" }));
      return [];
    });
    db.deviceUserMapping.create.mockRejectedValue(Object.assign(new Error("unique"), { code: "P2002" }));
    const res = await importDeviceMappings({
      deviceId: "dev1",
      csv: "deviceUserId,employeeEmail\n1001,yuki@fernly.example\n",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toEqual({ created: 0, duplicates: 1 });
  });
});

describe("importPunchesCsv — unexpected failures", () => {
  it("surfaces a non-unique ingest failure as INTERNAL (nothing partial)", async () => {
    db.punch.create.mockRejectedValue(new Error("db down"));
    const res = await importPunchesCsv({ deviceId: "dev1", csv: "deviceUserId,punchedAt\n1001,2026-11-10 09:05\n" });
    expect(res).toMatchObject({ ok: false, code: "INTERNAL" });
  });
});

describe("the guarded status flips (QA-16)", () => {
  it("matchPunchToEmployee refuses a punch finalized between read + write", async () => {
    db.punch.findUnique.mockResolvedValue(punchRow({ reconciliationStatus: "UNMATCHED" }));
    db.punch.updateMany.mockResolvedValue({ count: 0 });
    const res = await matchPunchToEmployee({ punchId: "p1", employeeId: "u-yuki" });
    expect(res).toMatchObject({ ok: false, code: "AUTH" });
  });

  it("ignorePunch refuses a punch finalized between read + write", async () => {
    db.punch.findUnique.mockResolvedValue(punchRow({ reconciliationStatus: "UNMATCHED" }));
    db.punch.updateMany.mockResolvedValue({ count: 0 });
    const res = await ignorePunch({ punchId: "p1" });
    expect(res).toMatchObject({ ok: false, code: "AUTH" });
  });

  it("matchPunchToEmployee refuses an unknown punch", async () => {
    db.punch.findUnique.mockResolvedValue(null);
    await expect(matchPunchToEmployee({ punchId: "nope", employeeId: "u-yuki" })).resolves.toMatchObject({ ok: false, code: "AUTH" });
  });

  it("ignorePunch refuses an unknown punch", async () => {
    db.punch.findUnique.mockResolvedValue(null);
    await expect(ignorePunch({ punchId: "nope" })).resolves.toMatchObject({ ok: false, code: "AUTH" });
  });
});
