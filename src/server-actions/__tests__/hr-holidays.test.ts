import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// F1.1 — holiday calendar server action tests. RBAC (hr:admin only),
// create/update/delete wiring, the duplicate-date friendly error (QA-18
// convention), and the year-scoped read.
// ---------------------------------------------------------------------------

const db = vi.hoisted(() => {
  const models = ["holidayCalendarEntry", "auditLog", "user"];
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
vi.mock("@/server-actions/auth-guard", () => ({
  requirePermission: (...a: unknown[]) => requirePermissionMock(...a),
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
  getHolidayCalendar,
  upsertHolidayEntry,
  deleteHolidayEntry,
} from "../hr-holidays";

const ADMIN_AUTH = { userId: "u-admin", role: "ADMIN" as const, name: "Ada", email: "ada@x.co" };
const HR_AUTH = { userId: "u-hr", role: "HR" as const, name: "Remy", email: "remy@x.co" };

beforeEach(() => {
  vi.clearAllMocks();
  requirePermissionMock.mockResolvedValue(ADMIN_AUTH);
  db.holidayCalendarEntry.findMany.mockResolvedValue([]);
  db.holidayCalendarEntry.findUnique.mockResolvedValue(null);
  db.holidayCalendarEntry.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: "hol-new", ...data,
  }));
  db.holidayCalendarEntry.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: "hol-1", ...data,
  }));
  db.holidayCalendarEntry.delete.mockResolvedValue({});
});

describe("getHolidayCalendar", () => {
  it("is hr:admin-gated — a member is refused", async () => {
    requirePermissionMock.mockRejectedValue(new Error("no perm"));
    const res = await getHolidayCalendar(2026);
    expect(res.ok).toBe(false);
    // And the permission it demanded was hr:admin, not hr:view.
    expect(requirePermissionMock).toHaveBeenCalledWith("hr:admin");
    expect(db.holidayCalendarEntry.findMany).not.toHaveBeenCalled();
  });

  it("returns the year's entries ascending, client-shaped", async () => {
    db.holidayCalendarEntry.findMany.mockResolvedValue([
      { id: "hol-1", date: new Date("2026-02-06T00:00:00.000Z"), label: "Waitangi Day", kind: "PUBLIC", isHalfDay: false },
      { id: "hol-2", date: new Date("2026-12-25T00:00:00.000Z"), label: "Christmas Day", kind: "PUBLIC", isHalfDay: false },
    ]);
    const res = await getHolidayCalendar(2026);
    if (!res.ok) throw new Error("expected ok");
    expect(res.data.year).toBe(2026);
    expect(res.data.entries).toEqual([
      { id: "hol-1", date: "2026-02-06", label: "Waitangi Day", kind: "PUBLIC", isHalfDay: false },
      { id: "hol-2", date: "2026-12-25", label: "Christmas Day", kind: "PUBLIC", isHalfDay: false },
    ]);
    // The read is year-scoped.
    const where = db.holidayCalendarEntry.findMany.mock.calls[0][0].where;
    expect(where.date.gte).toEqual(new Date("2026-01-01T00:00:00.000Z"));
    expect(where.date.lte).toEqual(new Date("2026-12-31T00:00:00.000Z"));
  });

  it("defaults an invalid year to the current UTC year", async () => {
    const res = await getHolidayCalendar(12345);
    if (!res.ok) throw new Error("expected ok");
    expect(res.data.year).toBe(new Date().getUTCFullYear());
  });
});

describe("upsertHolidayEntry", () => {
  it("creates an entry and audits it", async () => {
    const res = await upsertHolidayEntry({ date: "2026-12-25", label: "Christmas Day", kind: "PUBLIC", isHalfDay: false });
    expect(res.ok).toBe(true);
    expect(db.holidayCalendarEntry.create).toHaveBeenCalledWith({
      data: {
        date: new Date("2026-12-25T00:00:00.000Z"),
        label: "Christmas Day",
        kind: "PUBLIC",
        isHalfDay: false,
      },
    });
    expect(logAuditMock).toHaveBeenCalledTimes(1);
    expect(logAuditMock.mock.calls[0][0].action).toBe("hr.holiday_created");
  });

  it("rejects an impossible date at the schema boundary", async () => {
    const res = await upsertHolidayEntry({ date: "2026-02-30" });
    if (res.ok) throw new Error("expected failure");
    expect(res.error).toContain("Date must be");
  });

  it("maps a duplicate date to a friendly error (QA-18 convention)", async () => {
    const uniqueErr = Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
    db.holidayCalendarEntry.create.mockRejectedValueOnce(uniqueErr);
    const res = await upsertHolidayEntry({ date: "2026-12-25", label: "Christmas Day" });
    if (res.ok) throw new Error("expected failure");
    expect(res.error).toContain("2026-12-25 is already a holiday");
  });

  it("updates an existing entry (id given) and audits the update", async () => {
    db.holidayCalendarEntry.findUnique.mockResolvedValue({
      id: "hol-1", date: new Date("2026-12-25T00:00:00.000Z"), label: "", kind: "PUBLIC", isHalfDay: false,
    });
    const res = await upsertHolidayEntry({ id: "hol-1", date: "2026-12-25", label: "Christmas Day", kind: "WEEKLY_OFF", isHalfDay: true });
    expect(res.ok).toBe(true);
    expect(db.holidayCalendarEntry.update).toHaveBeenCalledWith({
      where: { id: "hol-1" },
      data: {
        date: new Date("2026-12-25T00:00:00.000Z"),
        label: "Christmas Day",
        kind: "WEEKLY_OFF",
        isHalfDay: true,
      },
    });
    expect(logAuditMock.mock.calls[0][0].action).toBe("hr.holiday_updated");
  });

  it("rejects updating a missing entry", async () => {
    db.holidayCalendarEntry.findUnique.mockResolvedValue(null);
    const res = await upsertHolidayEntry({ id: "hol-404", date: "2026-12-25" });
    if (res.ok) throw new Error("expected failure");
    expect(res.error).toContain("not found");
  });

  it("is hr:admin-gated — a member is refused before any write", async () => {
    requirePermissionMock.mockRejectedValue(new Error("no perm"));
    const res = await upsertHolidayEntry({ date: "2026-12-25" });
    expect(res.ok).toBe(false);
    expect(requirePermissionMock).toHaveBeenCalledWith("hr:admin");
    expect(db.holidayCalendarEntry.create).not.toHaveBeenCalled();
  });

  it("HR may manage the calendar (hr:admin includes HR)", async () => {
    requirePermissionMock.mockResolvedValue(HR_AUTH);
    const res = await upsertHolidayEntry({ date: "2026-12-25", label: "Christmas Day" });
    expect(res.ok).toBe(true);
  });
});

describe("deleteHolidayEntry", () => {
  it("deletes an existing entry and audits it with the entry's date", async () => {
    db.holidayCalendarEntry.findUnique.mockResolvedValue({
      id: "hol-1", date: new Date("2026-12-25T00:00:00.000Z"), label: "Christmas Day", kind: "PUBLIC", isHalfDay: false,
    });
    const res = await deleteHolidayEntry({ id: "hol-1" });
    expect(res.ok).toBe(true);
    expect(db.holidayCalendarEntry.delete).toHaveBeenCalledWith({ where: { id: "hol-1" } });
    expect(logAuditMock.mock.calls[0][0].action).toBe("hr.holiday_deleted");
    expect(logAuditMock.mock.calls[0][0].entityLabel).toContain("2026-12-25");
  });

  it("rejects deleting a missing entry", async () => {
    db.holidayCalendarEntry.findUnique.mockResolvedValue(null);
    const res = await deleteHolidayEntry({ id: "hol-404" });
    if (res.ok) throw new Error("expected failure");
    expect(res.error).toContain("not found");
  });

  it("is hr:admin-gated — a member is refused", async () => {
    requirePermissionMock.mockRejectedValue(new Error("no perm"));
    const res = await deleteHolidayEntry({ id: "hol-1" });
    expect(res.ok).toBe(false);
    expect(requirePermissionMock).toHaveBeenCalledWith("hr:admin");
    expect(db.holidayCalendarEntry.delete).not.toHaveBeenCalled();
  });
});
