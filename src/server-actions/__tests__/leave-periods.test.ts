import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// P27 (LV-08) — the leave period master's action tests: the RBAC gate
// (hr:admin), the pure-kernel refusals surfacing as friendly errors, the two
// forward-looking DB guards (engine-clean bucket, future start), the
// immutable-history delete guard, and the audit rows. The window KERNEL's
// own matrix lives in leave-period.test.ts.
// ---------------------------------------------------------------------------

const db = vi.hoisted(() => {
  const models = ["leavePeriod", "leaveLedgerEntry"];
  const methods = ["findMany", "findUnique", "findFirst", "create", "delete", "deleteMany", "count"];
  const obj: Record<string, Record<string, ReturnType<typeof vi.fn>>> = {};
  for (const m of models) {
    obj[m] = {};
    for (const meth of methods) obj[m][meth] = vi.fn();
  }
  (obj as Record<string, unknown>).$transaction = vi.fn();
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

import { listLeavePeriods, createLeavePeriod, deleteLeavePeriod } from "../leave-periods";

const ADMIN_AUTH = { userId: "u-admin", role: "ADMIN" as const, name: "Ada", email: "ada@x.co" };
const HR_AUTH = { userId: "u-hr", role: "HR" as const, name: "Remy", email: "remy@x.co" };
const MANAGER_AUTH = { userId: "u-mgr", role: "MANAGER" as const, name: "Ingrid", email: "ingrid@x.co" };

/** A future window far clear of "today" in any run of the suite. */
const FUTURE_START = "2031-04-01";
const FUTURE_END = "2032-03-31";

function isoDay(offset: number): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

beforeEach(() => {
  vi.clearAllMocks();
  requirePermissionMock.mockResolvedValue(ADMIN_AUTH);
  db.leavePeriod.findMany.mockResolvedValue([]);
  db.leavePeriod.findUnique.mockResolvedValue(null);
  db.leavePeriod.create.mockImplementation(async (args: { data: Record<string, unknown> }) => ({
    id: "p-new",
    name: args.data.name,
    ...args.data,
  }));
  db.leaveLedgerEntry.count.mockResolvedValue(0);
});

describe("listLeavePeriods", () => {
  it("is hr:admin-gated (a MANAGER is refused)", async () => {
    requirePermissionMock.mockResolvedValue(MANAGER_AUTH);
    requirePermissionMock.mockRejectedValueOnce(new Error("Forbidden"));
    const res = await listLeavePeriods();
    expect(res.ok).toBe(false);
  });

  it("maps the rows to day keys and their ledger buckets", async () => {
    db.leavePeriod.findMany.mockResolvedValue([
      { id: "p1", name: "FY 2031/32", startDate: new Date("2031-04-01T00:00:00.000Z"), endDate: new Date("2032-03-31T00:00:00.000Z") },
    ]);
    const res = await listLeavePeriods();
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.periods).toEqual([
        { id: "p1", name: "FY 2031/32", startDate: "2031-04-01", endDate: "2032-03-31", bucketYear: 2031 },
      ]);
    }
  });
});

describe("createLeavePeriod", () => {
  it("creates a clean future window (UTC-midnight dates, audited, bucket = start year)", async () => {
    const res = await createLeavePeriod({ name: "FY 2031/32 (Apr → Mar)", startDate: FUTURE_START, endDate: FUTURE_END });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.period).toMatchObject({ name: "FY 2031/32 (Apr → Mar)", startDate: FUTURE_START, endDate: FUTURE_END, bucketYear: 2031 });
    }
    expect(db.leavePeriod.create).toHaveBeenCalledWith({
      data: {
        name: "FY 2031/32 (Apr → Mar)",
        startDate: new Date("2031-04-01T00:00:00.000Z"),
        endDate: new Date("2032-03-31T00:00:00.000Z"),
      },
    });
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "leave.period_created", entityType: "LEAVE_PERIOD", entityLabel: "FY 2031/32 (Apr → Mar)" }),
    );
  });

  it("an HR admin passes the gate too", async () => {
    requirePermissionMock.mockResolvedValue(HR_AUTH);
    const res = await createLeavePeriod({ name: "FY 2031/32", startDate: FUTURE_START, endDate: FUTURE_END });
    expect(res.ok).toBe(true);
  });

  it("refuses a malformed date shape (zod)", async () => {
    const res = await createLeavePeriod({ name: "X", startDate: "not-a-date", endDate: FUTURE_END });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("YYYY-MM-DD");
  });

  it("refuses an overlapping window (the kernel's sentence)", async () => {
    db.leavePeriod.findMany.mockResolvedValue([
      { id: "p1", name: "FY 2031/32", startDate: new Date("2031-04-01T00:00:00.000Z"), endDate: new Date("2032-03-31T00:00:00.000Z") },
    ]);
    const res = await createLeavePeriod({ name: "Clash", startDate: "2031-06-01", endDate: "2032-05-31" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("overlaps");
  });

  it("refuses a start year the engine has already granted into (forward-looking)", async () => {
    db.leaveLedgerEntry.count.mockResolvedValue(17);
    const res = await createLeavePeriod({ name: "FY 2031/32", startDate: FUTURE_START, endDate: FUTURE_END });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("already has engine grants");
  });

  it("refuses a window that already started (races the daily pass)", async () => {
    const res = await createLeavePeriod({ name: "Past", startDate: isoDay(-30), endDate: isoDay(300) });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("must start in the future");
  });
});

describe("deleteLeavePeriod", () => {
  it("deletes a future window whose bucket is clean (audited)", async () => {
    db.leavePeriod.findUnique.mockResolvedValue({
      id: "p1",
      name: "FY 2031/32",
      startDate: new Date("2031-04-01T00:00:00.000Z"),
      endDate: new Date("2032-03-31T00:00:00.000Z"),
    });
    const res = await deleteLeavePeriod({ id: "p1" });
    expect(res.ok).toBe(true);
    expect(db.leavePeriod.delete).toHaveBeenCalledWith({ where: { id: "p1" } });
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "leave.period_deleted", entityType: "LEAVE_PERIOD", entityLabel: "FY 2031/32" }),
    );
  });

  it("refuses an unknown id with a friendly retry message", async () => {
    const res = await deleteLeavePeriod({ id: "ghost" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("no longer exists");
  });

  it("refuses a window whose ledger bucket has ANY rows (history is immutable)", async () => {
    db.leavePeriod.findUnique.mockResolvedValue({
      id: "p1",
      name: "FY 2031/32",
      startDate: new Date("2031-04-01T00:00:00.000Z"),
      endDate: new Date("2032-03-31T00:00:00.000Z"),
    });
    db.leaveLedgerEntry.count.mockResolvedValue(4);
    const res = await deleteLeavePeriod({ id: "p1" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("never deleted");
    expect(db.leavePeriod.delete).not.toHaveBeenCalled();
  });
});
