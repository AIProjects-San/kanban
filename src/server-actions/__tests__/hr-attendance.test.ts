import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// F1.3 — attendance records server action tests. RBAC (attendance:manage —
// the NEW permission, ADMIN+HR), month read + self-scoped read, upsert
// wiring (create/update paths), the duplicate (userId, date) friendly error
// (QA-18 convention), validation boundaries (ON_LEAVE is not submittable,
// HH:mm times, out-after-in), and delete.
// ---------------------------------------------------------------------------

const db = vi.hoisted(() => {
  const models = ["attendanceRecord", "holidayCalendarEntry", "user", "auditLog"];
  const methods = [
    "findMany", "findUnique", "findFirst", "create", "createMany", "update",
    "updateMany", "delete", "deleteMany", "upsert", "count", "aggregate",
  ];
  const obj: Record<string, Record<string, ReturnType<typeof vi.fn>>> = {};
  for (const m of models) {
    obj[m] = {};
    for (const meth of methods) obj[m][meth] = vi.fn();
  }
  return obj;
});
vi.mock("@/lib/db", () => ({ db }));

const requirePermissionMock = vi.fn();
const getSessionOrThrowMock = vi.fn();
vi.mock("@/server-actions/auth-guard", () => ({
  requirePermission: (...a: unknown[]) => requirePermissionMock(...a),
  getSessionOrThrow: (...a: unknown[]) => getSessionOrThrowMock(...a),
  AuthorizationError: class AuthorizationError extends Error {
    readonly digest = "AuthorizationError";
    constructor(m: string) { super(m); this.name = "AuthorizationError"; }
  },
}));

const logAuditMock = vi.fn();
vi.mock("@/server-actions/shared", () => ({
  logAudit: (...a: unknown[]) => logAuditMock(...a),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import {
  getAttendanceMonth,
  upsertAttendanceRecord,
  deleteAttendanceRecord,
  getMyAttendance,
} from "../hr-attendance";

const ADMIN_AUTH = { userId: "u-admin", role: "ADMIN" as const, name: "Ada", email: "ada@x.co" };
const HR_AUTH = { userId: "u-hr", role: "HR" as const, name: "Remy", email: "remy@x.co" };
const MEMBER_AUTH = { userId: "u-theo", role: "MEMBER" as const, name: "Theo", email: "theo@x.co" };

beforeEach(() => {
  vi.clearAllMocks();
  requirePermissionMock.mockResolvedValue(ADMIN_AUTH);
  getSessionOrThrowMock.mockResolvedValue(MEMBER_AUTH);
  db.user.findUnique.mockResolvedValue({ id: "u-theo", name: "Theo Vance", deletedAt: null });
  db.attendanceRecord.findMany.mockResolvedValue([]);
  db.attendanceRecord.findUnique.mockResolvedValue(null);
  db.holidayCalendarEntry.findMany.mockResolvedValue([]);
  db.attendanceRecord.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: "att-new", ...data,
  }));
  db.attendanceRecord.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: "att-1", ...data,
  }));
  db.attendanceRecord.delete.mockResolvedValue({});
});

describe("getAttendanceMonth", () => {
  it("is attendance:manage-gated — a member is refused", async () => {
    requirePermissionMock.mockRejectedValue(new Error("no perm"));
    const res = await getAttendanceMonth(2026, 11);
    expect(res.ok).toBe(false);
    // And the permission it demanded was attendance:manage, not hr:admin.
    expect(requirePermissionMock).toHaveBeenCalledWith("attendance:manage");
    expect(db.attendanceRecord.findMany).not.toHaveBeenCalled();
  });

  it("returns roster + records + holidays for the month, client-shaped", async () => {
    db.user.findMany.mockResolvedValue([
      { id: "u-admin", name: "Ada Lovelace" },
      { id: "u-theo", name: "Theo Vance" },
    ]);
    db.attendanceRecord.findMany.mockResolvedValue([
      { id: "att-1", userId: "u-theo", date: new Date("2026-11-05T00:00:00.000Z"), status: "WFH", inTime: "09:15", outTime: "17:40", note: "Home", source: "MANUAL" },
    ]);
    db.holidayCalendarEntry.findMany.mockResolvedValue([
      { date: new Date("2026-11-27T00:00:00.000Z"), label: "Regional anniversary" },
    ]);
    const res = await getAttendanceMonth(2026, 11);
    if (!res.ok) throw new Error("expected success");
    expect(res.data.year).toBe(2026);
    expect(res.data.month).toBe(11);
    expect(res.data.members).toHaveLength(2);
    expect(res.data.records[0]).toMatchObject({
      id: "att-1", userId: "u-theo", userName: "Theo Vance", date: "2026-11-05", status: "WFH", source: "MANUAL",
    });
    expect(res.data.holidays).toEqual([{ date: "2026-11-27", label: "Regional anniversary" }]);
  });

  it("clamps an invalid month to the current UTC month", async () => {
    db.user.findMany.mockResolvedValue([]);
    const res = await getAttendanceMonth(1899, 13);
    if (!res.ok) throw new Error("expected success");
    const now = new Date();
    expect(res.data.year).toBe(now.getUTCFullYear());
    expect(res.data.month).toBe(now.getUTCMonth() + 1);
  });

  it("scopes the record read to the month bounds", async () => {
    db.user.findMany.mockResolvedValue([]);
    await getAttendanceMonth(2026, 2);
    expect(db.attendanceRecord.findMany).toHaveBeenCalledWith({
      where: { date: { gte: new Date("2026-02-01T00:00:00.000Z"), lte: new Date("2026-02-28T00:00:00.000Z") } },
      orderBy: { date: "asc" },
    });
  });
});

describe("upsertAttendanceRecord", () => {
  it("HR may mark a member (HR holds attendance:manage)", async () => {
    requirePermissionMock.mockResolvedValue(HR_AUTH);
    const res = await upsertAttendanceRecord({
      userId: "u-theo", date: "2026-11-05", status: "WFH", note: "From home",
    });
    if (!res.ok) throw new Error(res.error);
    expect(res.data.id).toBe("att-new");
    expect(db.attendanceRecord.create).toHaveBeenCalledWith({
      data: {
        userId: "u-theo",
        date: new Date("2026-11-05T00:00:00.000Z"),
        status: "WFH",
        inTime: null,
        outTime: null,
        note: "From home",
        source: "MANUAL",
      },
    });
    expect(logAuditMock.mock.calls[0][0].action).toBe("hr.attendance_marked");
  });

  it("maps a duplicate (user, date) to a friendly error (QA-18 convention)", async () => {
    const uniqueErr = Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
    db.attendanceRecord.create.mockRejectedValueOnce(uniqueErr);
    const res = await upsertAttendanceRecord({
      userId: "u-theo", date: "2026-11-05", status: "ABSENT",
    });
    if (res.ok) throw new Error("expected failure");
    expect(res.code).toBe("AUTH");
    expect(res.error).toContain("Theo Vance already has an attendance record for 2026-11-05");
    expect(res.error).toContain("one record per person per day");
  });

  it("updates an existing record and audits hr.attendance_updated", async () => {
    db.attendanceRecord.findUnique.mockResolvedValue({
      id: "att-1", userId: "u-theo", date: new Date("2026-11-05T00:00:00.000Z"), status: "PRESENT",
    });
    const res = await upsertAttendanceRecord({
      id: "att-1", userId: "u-theo", date: "2026-11-05", status: "HALF_DAY", inTime: "09:00", outTime: "13:00",
    });
    if (!res.ok) throw new Error(res.error);
    expect(db.attendanceRecord.update).toHaveBeenCalledWith({
      where: { id: "att-1" },
      data: {
        userId: "u-theo",
        date: new Date("2026-11-05T00:00:00.000Z"),
        status: "HALF_DAY",
        inTime: "09:00",
        outTime: "13:00",
        note: "",
        source: "MANUAL",
      },
    });
    expect(logAuditMock.mock.calls[0][0].action).toBe("hr.attendance_updated");
  });

  it("rejects an update whose target user does not exist", async () => {
    db.attendanceRecord.findUnique.mockResolvedValue(null);
    const res = await upsertAttendanceRecord({
      id: "att-404", userId: "u-theo", date: "2026-11-05", status: "PRESENT",
    });
    if (res.ok) throw new Error("expected failure");
    expect(res.error).toContain("Attendance record not found");
  });

  it("refuses to move a record between people", async () => {
    db.attendanceRecord.findUnique.mockResolvedValue({
      id: "att-1", userId: "u-soren", date: new Date("2026-11-05T00:00:00.000Z"), status: "PRESENT",
    });
    const res = await upsertAttendanceRecord({
      id: "att-1", userId: "u-theo", date: "2026-11-05", status: "PRESENT",
    });
    if (res.ok) throw new Error("expected failure");
    expect(res.error).toContain("cannot move between people");
  });

  it("rejects ON_LEAVE — the status is derived, never form-submitted", async () => {
    const res = await upsertAttendanceRecord({
      userId: "u-theo", date: "2026-11-05", status: "ON_LEAVE" as "PRESENT",
    });
    if (res.ok) throw new Error("expected failure");
    expect(res.code).toBe("VALIDATION");
    expect(db.attendanceRecord.create).not.toHaveBeenCalled();
  });

  it("rejects malformed times and out-before-in", async () => {
    const badTime = await upsertAttendanceRecord({
      userId: "u-theo", date: "2026-11-05", status: "PRESENT", inTime: "9am",
    });
    if (badTime.ok) throw new Error("expected failure");
    expect(badTime.code).toBe("VALIDATION");
    expect(badTime.error).toContain("HH:mm");

    const backwards = await upsertAttendanceRecord({
      userId: "u-theo", date: "2026-11-05", status: "PRESENT", inTime: "17:00", outTime: "09:00",
    });
    if (backwards.ok) throw new Error("expected failure");
    expect(backwards.code).toBe("VALIDATION");
    expect(backwards.error).toContain("Out time must be after in time");
  });

  it("rejects an unknown target member", async () => {
    db.user.findUnique.mockResolvedValue(null);
    const res = await upsertAttendanceRecord({
      userId: "u-ghost", date: "2026-11-05", status: "PRESENT",
    });
    if (res.ok) throw new Error("expected failure");
    expect(res.error).toContain("Member not found");
  });
});

describe("deleteAttendanceRecord", () => {
  it("deletes and audits hr.attendance_deleted", async () => {
    db.attendanceRecord.findUnique.mockResolvedValue({
      id: "att-1", userId: "u-theo", date: new Date("2026-11-05T00:00:00.000Z"), status: "ABSENT", note: "",
    });
    const res = await deleteAttendanceRecord({ id: "att-1" });
    if (!res.ok) throw new Error(res.error);
    expect(db.attendanceRecord.delete).toHaveBeenCalledWith({ where: { id: "att-1" } });
    expect(logAuditMock.mock.calls[0][0].action).toBe("hr.attendance_deleted");
  });

  it("is a 404-style failure for a missing record", async () => {
    db.attendanceRecord.findUnique.mockResolvedValue(null);
    const res = await deleteAttendanceRecord({ id: "att-404" });
    if (res.ok) throw new Error("expected failure");
    expect(res.error).toContain("Attendance record not found");
  });
});

describe("getMyAttendance", () => {
  it("is self-scoped — the WHERE clause carries the session user and the month bounds", async () => {
    db.attendanceRecord.findMany.mockResolvedValue([
      { id: "att-1", userId: "u-theo", date: new Date("2026-11-05T00:00:00.000Z"), status: "PRESENT", inTime: null, outTime: null, note: "", source: "MANUAL" },
    ]);
    const res = await getMyAttendance(2026, 11);
    if (!res.ok) throw new Error(res.error);
    expect(getSessionOrThrowMock).toHaveBeenCalled();
    expect(db.attendanceRecord.findMany).toHaveBeenCalledWith({
      where: { userId: "u-theo", date: { gte: new Date("2026-11-01T00:00:00.000Z"), lte: new Date("2026-11-30T00:00:00.000Z") } },
      orderBy: { date: "asc" },
      take: 400,
    });
    expect(res.data.records[0].userName).toBe("Theo");
    expect(res.data.records[0].date).toBe("2026-11-05");
  });

  it("takes zero member inputs — invalid month falls back to the current UTC month", async () => {
    const res = await getMyAttendance(undefined, undefined);
    if (!res.ok) throw new Error(res.error);
    const now = new Date();
    expect(res.data.year).toBe(now.getUTCFullYear());
    expect(res.data.month).toBe(now.getUTCMonth() + 1);
  });
});
