import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// HR module — leave management server action tests (docs/HR_MODULE_PLAN.md §4).
// Full rule matrix: request validation (policy rails, overlap, balance),
// decide (chain-scoped approver, transactional balance), cancel (restore).
// ---------------------------------------------------------------------------

const db = vi.hoisted(() => {
  const models = [
    "leaveRequest", "leaveType", "leavePolicy", "leaveBalance",
    "leaveLedgerEntry", "payslip", "payrollRun",
    "user", "auditLog", "notification", "holidayCalendarEntry",
    "attendanceRecord", "employeeProfile",
  ];
  const methods = [
    "findMany", "findUnique", "findFirst", "create", "createMany", "update",
    "updateMany", "delete", "deleteMany", "upsert", "count", "aggregate",
    "groupBy",
  ];
  const obj: Record<string, Record<string, ReturnType<typeof vi.fn>>> = {};
  for (const m of models) {
    obj[m] = {};
    for (const meth of methods) obj[m][meth] = vi.fn();
  }
  (obj as Record<string, unknown>).$transaction = vi.fn(
    async (fn: unknown) =>
      typeof fn === "function" ? fn(obj) : Promise.resolve(fn),
  );
  return obj;
});

vi.mock("@/lib/db", () => ({ db }));

const getSessionMock = vi.fn();
const requirePermissionMock = vi.fn();
vi.mock("@/server-actions/auth-guard", () => ({
  getSession: () => getSessionMock(),
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

// PR-56 — partial mock so the best-effort notification catch blocks can be
// asserted (and so they don't spam the console). Everything but logError
// stays real, matching the __tests__/shared.test.ts convention.
const logErrorSpy = vi.fn();
vi.mock("@/lib/observability", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/observability")>();
  return { ...actual, logError: (...args: unknown[]) => logErrorSpy(...args) };
});

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import {
  createLeaveRequest,
  decideLeaveRequest,
  cancelLeaveRequest,
  createLeaveType,
  updateLeaveType,
  getMyLeaveData,
  getLeaveQueue,
  adjustLeaveBalance,
} from "../hr-leave";
import { projectLeaveBalance } from "@/lib/leave-ledger";
import { monthsInRange } from "@/lib/payroll-math";
import {
  parseDay,
  daysBetween,
  workingDays,
  getApproverIdsFor,
  assertLeaveDecider,
  getOrCreateBalance,
  getOrCreateBalancesBatch,
  findOverlappingActiveRequest,
} from "../hr-shared";

const ADMIN_AUTH = { userId: "u-admin", role: "ADMIN" as const, name: "Ada", email: "ada@x.co" };
const MANAGER_AUTH = { userId: "u-mgr", role: "MANAGER" as const, name: "Ingrid", email: "ingrid@x.co" };
const MEMBER_AUTH = { userId: "u-theo", role: "MEMBER" as const, name: "Theo", email: "theo@x.co" };
const HR_AUTH = { userId: "u-hr", role: "HR" as const, name: "Remy", email: "remy@x.co" };

const ANNUAL_TYPE = {
  id: "lt-annual",
  name: "Annual Leave",
  code: "ANNUAL",
  color: "#8b5cf6",
  requiresDoc: false,
  paid: true,
  active: true,
  policy: { id: "lp-1", leaveTypeId: "lt-annual", annualDays: 20, maxCarryOver: 5, minNoticeDays: 1, maxConsecutiveDays: 15 },
};

const BALANCE = { entitled: 20, carriedOver: 0, used: 0 };

function isoDay(offset: number): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

beforeEach(() => {
  vi.clearAllMocks();
  requirePermissionMock.mockResolvedValue(MEMBER_AUTH);
  getSessionMock.mockResolvedValue(MEMBER_AUTH);
  db.leaveType.findUnique.mockResolvedValue(null);
  db.leaveType.findMany.mockResolvedValue([]);
  db.leavePolicy.findUnique.mockResolvedValue(ANNUAL_TYPE.policy);
  db.leaveRequest.findMany.mockResolvedValue([]);
  db.leaveRequest.findFirst.mockResolvedValue(null);
  db.leaveRequest.findUnique.mockResolvedValue(null);
  db.leaveRequest.create.mockResolvedValue({ id: "lr-1" });
  db.leaveRequest.update.mockResolvedValue({});
  db.leaveBalance.findUnique.mockResolvedValue(BALANCE);
  // F1.1 — holiday calendar reads default to empty (holiday-free math);
  // individual tests seed entries to pin the exclusion behavior.
  db.holidayCalendarEntry.findMany.mockResolvedValue([]);
  // PR-19 — getMyLeaveData now reads balances in ONE batched findMany
  // (+ createMany materialization for missing rows).
  db.leaveBalance.findMany.mockResolvedValue([{ leaveTypeId: "lt-annual", ...BALANCE }]);
  db.leaveBalance.create.mockResolvedValue({});
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
  db.leaveLedgerEntry.createMany.mockResolvedValue({ count: 0 });
  db.user.findUnique.mockResolvedValue(null);
  db.user.findMany.mockResolvedValue([]);
  db.notification.create.mockResolvedValue({});
  db.notification.createMany.mockResolvedValue({ count: 0 });
  // QA-16: decision/cancel writes are guarded updateMany calls — the happy
  // path matches exactly one row.
  db.leaveRequest.updateMany.mockResolvedValue({ count: 1 });
  // F1.3 — the approve/cancel transactions derive/remove ON_LEAVE attendance
  // rows; default to "no records" so the derivation no-ops unless a test
  // seeds rows.
  db.attendanceRecord.findMany.mockResolvedValue([]);
  // LV-B10 (S10) — the salary-processed guard reads the user's LOCKED
  // payslips; default to none.
  db.payslip.findMany.mockResolvedValue([]);
});

// ---------------------------------------------------------------------------
// Pure helpers (hr-shared)
// ---------------------------------------------------------------------------

describe("workingDays", () => {
  it("counts Mon-Fri only — a week-long range is 5 days", () => {
    // 2026-11-02 is a Monday.
    expect(workingDays(parseDay("2026-11-02"), parseDay("2026-11-08"))).toBe(5);
  });
  it("a single Saturday is zero days", () => {
    expect(workingDays(parseDay("2026-11-07"), parseDay("2026-11-07"))).toBe(0);
  });
  it("a single Wednesday is one day", () => {
    expect(workingDays(parseDay("2026-11-04"), parseDay("2026-11-04"))).toBe(1);
  });
});

describe("parseDay / daysBetween", () => {
  it("normalizes to UTC midnight", () => {
    const d = parseDay("2026-11-02");
    expect(d.toISOString()).toBe("2026-11-02T00:00:00.000Z");
  });
  it("rejects malformed date strings", () => {
    expect(() => parseDay("11/02/2026")).toThrow();
    expect(() => parseDay("")).toThrow();
  });
  it("daysBetween is exact in whole days", () => {
    expect(daysBetween(parseDay("2026-11-02"), parseDay("2026-11-09"))).toBe(7);
    expect(daysBetween(parseDay("2026-11-09"), parseDay("2026-11-02"))).toBe(-7);
  });
});

describe("getApproverIdsFor / assertLeaveDecider", () => {
  it("resolves the manager when one is set", async () => {
    db.user.findUnique.mockResolvedValue({ managerId: "u-mgr" });
    expect(await getApproverIdsFor("u-theo")).toEqual(["u-mgr"]);
  });
  it("falls back to every admin when no manager is set", async () => {
    db.user.findUnique.mockResolvedValue({ managerId: null });
    db.user.findMany.mockResolvedValue([{ id: "u-admin" }, { id: "u-admin2" }]);
    expect(await getApproverIdsFor("u-theo")).toEqual(["u-admin", "u-admin2"]);
  });
  it("accepts the requester's manager as decider", async () => {
    db.user.findUnique.mockResolvedValue({ managerId: "u-mgr" });
    await expect(assertLeaveDecider(MANAGER_AUTH, "u-theo")).resolves.toBeUndefined();
  });
  it("accepts an admin even without a manager chain", async () => {
    db.user.findUnique.mockResolvedValue({ managerId: null });
    await expect(assertLeaveDecider(ADMIN_AUTH, "u-theo")).resolves.toBeUndefined();
  });
  it("rejects a manager outside the chain", async () => {
    db.user.findUnique.mockResolvedValue({ managerId: "u-other-mgr" });
    await expect(assertLeaveDecider(MANAGER_AUTH, "u-theo")).rejects.toThrow(/manager/i);
  });
  it("rejects an HR user outside the chain (chain-scoped, not role-scoped)", async () => {
    db.user.findUnique.mockResolvedValue({ managerId: "u-mgr" });
    await expect(assertLeaveDecider(HR_AUTH, "u-theo")).rejects.toThrow(/manager/i);
  });

  it("S14 — the profile's leave-approver OVERRIDE outranks the manager", async () => {
    db.user.findUnique.mockResolvedValue({ managerId: "u-mgr" });
    db.employeeProfile.findUnique.mockResolvedValue({ leaveApproverId: "u-remy" });
    expect(await getApproverIdsFor("u-theo")).toEqual(["u-remy"]);
    // The override user may decide even as a plain MANAGER-role member…
    const REMY_AUTH = { userId: "u-remy", role: "MANAGER" as const, name: "Remy", email: "remy@x.co" };
    await expect(assertLeaveDecider(REMY_AUTH, "u-theo")).resolves.toBeUndefined();
    // …and the profile-less user keeps the manager rule (null-safe).
    db.employeeProfile.findUnique.mockResolvedValue(null);
    expect(await getApproverIdsFor("u-theo")).toEqual(["u-mgr"]);
  });

  it("S14 — the override routes the request notifications too (createLeaveRequest)", async () => {
    db.leaveType.findUnique.mockResolvedValue(ANNUAL_TYPE);
    db.employeeProfile.findUnique.mockResolvedValue({ leaveApproverId: "u-remy" });
    db.user.findUnique.mockResolvedValue({ managerId: "u-mgr" });
    db.leaveRequest.findFirst.mockResolvedValue(null);
    db.leaveRequest.findMany.mockResolvedValue([]);
    db.payslip.findMany.mockResolvedValue([]);
    db.attendanceRecord.findMany.mockResolvedValue([]);
    const res = await createLeaveRequest({
      leaveTypeId: "lt-annual", startDate: isoDay(3), endDate: isoDay(5), reason: "override routing",
    });
    expect(res.ok).toBe(true);
    expect(db.notification.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.arrayContaining([expect.objectContaining({ recipientUserId: "u-remy" })]),
      }),
    );
    // The bypassed manager is NOT notified.
    const notified = (db.notification.createMany.mock.calls[0][0] as { data: Array<{ recipientUserId: string }> }).data;
    expect(notified.some((n) => n.recipientUserId === "u-mgr")).toBe(false);
  });
});

describe("getOrCreateBalance", () => {
  it("returns the existing row untouched", async () => {
    db.leaveBalance.findUnique.mockResolvedValue({ entitled: 20, carriedOver: 2, used: 3 });
    const b = await getOrCreateBalance("u-theo", "lt-annual", 2026, ANNUAL_TYPE.policy);
    expect(b).toEqual({ entitled: 20, carriedOver: 2, used: 3 });
    expect(db.leaveBalance.create).not.toHaveBeenCalled();
  });
  it("materializes the entitlement when no row exists", async () => {
    db.leaveBalance.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ entitled: 20, carriedOver: 0, used: 0 });
    const b = await getOrCreateBalance("u-theo", "lt-annual", 2026, ANNUAL_TYPE.policy);
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
  });
});

describe("findOverlappingActiveRequest", () => {
  it("queries only PENDING/APPROVED statuses", async () => {
    await findOverlappingActiveRequest("u-theo", parseDay("2026-11-02"), parseDay("2026-11-06"));
    expect(db.leaveRequest.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: { in: ["PENDING", "APPROVED"] } }),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// createLeaveRequest
// ---------------------------------------------------------------------------

describe("createLeaveRequest", () => {
  it("creates a pending request with computed working days and audits it", async () => {
    requirePermissionMock.mockResolvedValue(MEMBER_AUTH);
    db.leaveType.findUnique.mockResolvedValue(ANNUAL_TYPE);
    // Fixed future dates with known weekdays (2027-06-07 is a Monday) —
    // relative offsets would land on weekends depending on the run day.
    const res = await createLeaveRequest({
      leaveTypeId: "lt-annual",
      startDate: "2027-06-07",
      endDate: "2027-06-08",
      reason: "Family visit",
    });
    expect(res.ok).toBe(true);
    expect(db.leaveRequest.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          leaveTypeId: "lt-annual",
          userId: "u-theo",
          status: "PENDING",
          days: 2,
        }),
      }),
    );
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "leave.requested", entityType: "LEAVE_REQUEST", entityId: "lr-1" }),
    );
  });

  it("excludes a holiday-calendar entry from the request's day count (F1.1)", async () => {
    requirePermissionMock.mockResolvedValue(MEMBER_AUTH);
    db.leaveType.findUnique.mockResolvedValue(ANNUAL_TYPE);
    // 2027-06-07 (Mon) .. 2027-06-09 (Wed) = 3 working days; King's
    // Birthday (Mon 2027-06-07) removes Monday → 2 days.
    db.holidayCalendarEntry.findMany.mockResolvedValue([
      { date: new Date("2027-06-07T00:00:00.000Z"), isHalfDay: false },
    ]);
    const res = await createLeaveRequest({
      leaveTypeId: "lt-annual",
      startDate: "2027-06-07",
      endDate: "2027-06-09",
      reason: "Long weekend",
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.days).toBe(2);
    expect(db.leaveRequest.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ days: 2 }),
      }),
    );
    // The calendar read was scoped to the request's range.
    const where = db.holidayCalendarEntry.findMany.mock.calls[0][0].where;
    expect(where.date.gte).toEqual(new Date("2027-06-07T00:00:00.000Z"));
    expect(where.date.lte).toEqual(new Date("2027-06-09T00:00:00.000Z"));
  });

  it("counts a half-day holiday as 0.5 working days (F1.1)", async () => {
    requirePermissionMock.mockResolvedValue(MEMBER_AUTH);
    db.leaveType.findUnique.mockResolvedValue(ANNUAL_TYPE);
    // Wed 2027-06-09 alone: 1 working day, but a half-day holiday → 0.5.
    db.holidayCalendarEntry.findMany.mockResolvedValue([
      { date: new Date("2027-06-09T00:00:00.000Z"), isHalfDay: true },
    ]);
    const res = await createLeaveRequest({
      leaveTypeId: "lt-annual",
      startDate: "2027-06-09",
      endDate: "2027-06-09",
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.days).toBe(0.5);
  });

  it("rejects a range whose every working day is a holiday (F1.1)", async () => {
    requirePermissionMock.mockResolvedValue(MEMBER_AUTH);
    db.leaveType.findUnique.mockResolvedValue(ANNUAL_TYPE);
    db.holidayCalendarEntry.findMany.mockResolvedValue([
      { date: new Date("2027-06-07T00:00:00.000Z"), isHalfDay: false },
      { date: new Date("2027-06-08T00:00:00.000Z"), isHalfDay: false },
    ]);
    const res = await createLeaveRequest({
      leaveTypeId: "lt-annual",
      startDate: "2027-06-07",
      endDate: "2027-06-08",
    });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/no working days/i);
    expect(db.leaveRequest.create).not.toHaveBeenCalled();
  });

  it("rejects an unknown or inactive leave type", async () => {
    db.leaveType.findUnique.mockResolvedValue({ ...ANNUAL_TYPE, active: false });
    const res = await createLeaveRequest({ leaveTypeId: "lt-x", startDate: isoDay(7), endDate: isoDay(8) });
    expect(res.ok).toBe(false);
    expect(db.leaveRequest.create).not.toHaveBeenCalled();
  });

  // F2.1 — offboarding finality: the exit arc closes the request gate
  // (every other status, including "" not-tracked, stays requestable).
  it("F2.1 — rejects a request from an EXITED employee", async () => {
    requirePermissionMock.mockResolvedValue(MEMBER_AUTH);
    db.leaveType.findUnique.mockResolvedValue(ANNUAL_TYPE);
    db.employeeProfile.findUnique.mockResolvedValueOnce({ employmentStatus: "EXITED" });
    const res = await createLeaveRequest({ leaveTypeId: "lt-annual", startDate: isoDay(7), endDate: isoDay(8) });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/exited/i);
    expect(db.leaveRequest.create).not.toHaveBeenCalled();
  });

  it("F2.1 — an ACTIVE employee (and an untracked profile) still requests leave", async () => {
    requirePermissionMock.mockResolvedValue(MEMBER_AUTH);
    db.leaveType.findUnique.mockResolvedValue(ANNUAL_TYPE);
    db.employeeProfile.findUnique.mockResolvedValueOnce({ employmentStatus: "ACTIVE" });
    const active = await createLeaveRequest({ leaveTypeId: "lt-annual", startDate: isoDay(7), endDate: isoDay(8) });
    expect(active.ok).toBe(true);

    db.employeeProfile.findUnique.mockResolvedValue(null);
    const untracked = await createLeaveRequest({ leaveTypeId: "lt-annual", startDate: isoDay(7), endDate: isoDay(8) });
    expect(untracked.ok).toBe(true);
    // Restore the permissive default for the suites after this one.
    db.employeeProfile.findUnique.mockResolvedValue(undefined);
  });

  it("rejects an end date before the start date", async () => {
    db.leaveType.findUnique.mockResolvedValue(ANNUAL_TYPE);
    const res = await createLeaveRequest({ leaveTypeId: "lt-annual", startDate: isoDay(9), endDate: isoDay(7) });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/end date/i);
  });

  it("rejects a weekend-only range (zero working days)", async () => {
    db.leaveType.findUnique.mockResolvedValue(ANNUAL_TYPE);
    // Find next Saturday.
    const sat = new Date();
    sat.setUTCHours(0, 0, 0, 0);
    while (sat.getUTCDay() !== 6) sat.setUTCDate(sat.getUTCDate() + 1);
    const iso = sat.toISOString().slice(0, 10);
    const res = await createLeaveRequest({ leaveTypeId: "lt-annual", startDate: iso, endDate: iso });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/no working days/i);
  });

  it("enforces the minimum-notice policy", async () => {
    db.leaveType.findUnique.mockResolvedValue({
      ...ANNUAL_TYPE,
      policy: { ...ANNUAL_TYPE.policy, minNoticeDays: 5 },
    });
    // The range must ALWAYS contain working days: a 2-day window starting
    // "tomorrow" lands on a weekend whenever the suite runs on a Friday
    // (UTC), the "no working days" guard then fires ahead of the notice
    // check and this test fails on the calendar, not the policy. A 7-day
    // window straddles >= 5 working days on every weekday the suite can
    // start on, and its start is still 1 day out — well inside the 5-day
    // notice minimum the assertion targets.
    const res = await createLeaveRequest({ leaveTypeId: "lt-annual", startDate: isoDay(1), endDate: isoDay(7) });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/notice/i);
  });

  it("enforces the max-consecutive-days policy", async () => {
    db.leaveType.findUnique.mockResolvedValue(ANNUAL_TYPE); // max 15
    const res = await createLeaveRequest({ leaveTypeId: "lt-annual", startDate: isoDay(7), endDate: isoDay(7 + 28) });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/consecutive/i);
  });

  it("rejects an overlapping active request", async () => {
    db.leaveType.findUnique.mockResolvedValue(ANNUAL_TYPE);
    db.leaveRequest.findFirst.mockResolvedValue({ id: "lr-existing" });
    // Calendar-independent window (same discipline as the notice test
    // above): a 2-day span at +7 lands on a weekend whenever the suite
    // runs on a Saturday (UTC) — the "no working days" guard (F1.1) then
    // fires ahead of the overlap check and this fails on the calendar, not
    // the policy. A 7-day span always straddles >= 5 working days, starts
    // past the 1-day notice minimum, and stays under the 15-day consecutive
    // cap, so the overlap check is what rejects it on every run day.
    const res = await createLeaveRequest({ leaveTypeId: "lt-annual", startDate: isoDay(7), endDate: isoDay(13) });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/overlapping/i);
  });

  it("rejects insufficient balance at submission", async () => {
    db.leaveType.findUnique.mockResolvedValue(ANNUAL_TYPE);
    db.leaveBalance.findUnique.mockResolvedValue({ entitled: 20, carriedOver: 0, used: 19 });
    // Mon–Wed 2027 = 3 working days > 1 available.
    const res = await createLeaveRequest({ leaveTypeId: "lt-annual", startDate: "2027-06-07", endDate: "2027-06-09" });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/Insufficient balance/i);
    expect(db.leaveRequest.create).not.toHaveBeenCalled();
  });

  it("notifies the approver (best-effort)", async () => {
    requirePermissionMock.mockResolvedValue(MEMBER_AUTH);
    db.leaveType.findUnique.mockResolvedValue(ANNUAL_TYPE);
    db.user.findUnique.mockResolvedValue({ managerId: "u-mgr" });
    await createLeaveRequest({ leaveTypeId: "lt-annual", startDate: "2027-06-07", endDate: "2027-06-08" });
    expect(db.notification.createMany).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// decideLeaveRequest
// ---------------------------------------------------------------------------

const PENDING_REQUEST = {
  id: "lr-1",
  leaveTypeId: "lt-annual",
  userId: "u-theo",
  startDate: parseDay(isoDay(7)),
  endDate: parseDay(isoDay(8)),
  days: 2,
  reason: "",
  status: "PENDING",
  decidedById: null,
  decidedAt: null,
  decisionNote: "",
};

describe("decideLeaveRequest", () => {
  it("approves: flips status, writes a CONSUME ledger row, and syncs the cache inside a transaction", async () => {
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
    );
    // QA-16: the status flip is a guarded updateMany — see the QA-16 block.
    expect(db.leaveRequest.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "APPROVED", decidedById: "u-mgr" }) }),
    );
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "leave.approved" }),
    );
  });

  it("rejects: flips status WITHOUT touching the balance", async () => {
    requirePermissionMock.mockResolvedValue(MANAGER_AUTH);
    db.leaveRequest.findUnique.mockResolvedValue(PENDING_REQUEST);
    db.user.findUnique.mockResolvedValue({ managerId: "u-mgr" });

    const res = await decideLeaveRequest({ requestId: "lr-1", decision: "REJECT", note: "Capacity" });
    expect(res.ok).toBe(true);
    expect(db.leaveBalance.update).not.toHaveBeenCalled();
    expect(db.leaveRequest.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "REJECTED", decisionNote: "Capacity" }) }),
    );
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "leave.rejected" }),
    );
  });

  it("refuses a non-pending request", async () => {
    db.leaveRequest.findUnique.mockResolvedValue({ ...PENDING_REQUEST, status: "APPROVED" });
    const res = await decideLeaveRequest({ requestId: "lr-1", decision: "APPROVE" });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/already/i);
  });

  it("refuses a decider outside the requester's chain (HR is not a decider)", async () => {
    requirePermissionMock.mockResolvedValue(HR_AUTH);
    db.leaveRequest.findUnique.mockResolvedValue(PENDING_REQUEST);
    db.user.findUnique.mockResolvedValue({ managerId: "u-mgr" });
    const res = await decideLeaveRequest({ requestId: "lr-1", decision: "APPROVE" });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/manager/i);
  });

  it("refuses an unknown request", async () => {
    db.leaveRequest.findUnique.mockResolvedValue(null);
    const res = await decideLeaveRequest({ requestId: "lr-ghost", decision: "APPROVE" });
    expect(res.ok).toBe(false);
  });

  // -----------------------------------------------------------------------
  // QA-16 — decision writes are guarded by the status in the WHERE clause.
  // The PENDING precheck runs BEFORE the write; two tabs (or two reviewers)
  // can both pass it and then both "win" their write. The approve path is
  // worse than a duplicated toast: each winner increments `used`, so the
  // balance is debited TWICE for one request. The status guard makes the
  // loser's write a zero-row update, which must abort with the same
  // friendly "already decided" error instead of silently succeeding.
  // -----------------------------------------------------------------------

  it("QA-16: the approve write guards on PENDING in its WHERE clause", async () => {
    requirePermissionMock.mockResolvedValue(MANAGER_AUTH);
    db.leaveRequest.findUnique.mockResolvedValue(PENDING_REQUEST);
    db.user.findUnique.mockResolvedValue({ managerId: "u-mgr" });
    db.leaveRequest.updateMany.mockResolvedValue({ count: 1 });
    db.leaveBalance.findUnique.mockResolvedValue(BALANCE);

    await decideLeaveRequest({ requestId: "lr-1", decision: "APPROVE" });
    expect(db.leaveRequest.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "lr-1", status: "PENDING" },
        data: expect.objectContaining({ status: "APPROVED" }),
      }),
    );
  });

  it("QA-16: a concurrent decision (zero-row guarded write) refuses AND never debits", async () => {
    requirePermissionMock.mockResolvedValue(MANAGER_AUTH);
    db.leaveRequest.findUnique.mockResolvedValue(PENDING_REQUEST);
    db.user.findUnique.mockResolvedValue({ managerId: "u-mgr" });
    // The guarded update matched nothing — another decider won the race and
    // the row is no longer PENDING.
    db.leaveRequest.updateMany.mockResolvedValue({ count: 0 });

    const res = await decideLeaveRequest({ requestId: "lr-1", decision: "APPROVE" });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.code).toBe("AUTH");
    expect(res.ok === false && res.error).toMatch(/no longer pending|already/i);
    // The transaction aborted before the debit — no ledger row, no cache
    // write (F1.2 makes "no debit" two assertions, not one).
    expect(db.leaveLedgerEntry.create).not.toHaveBeenCalled();
    expect(db.leaveBalance.update).not.toHaveBeenCalled();
  });

  it("QA-16: the reject write guards on PENDING in its WHERE clause", async () => {
    requirePermissionMock.mockResolvedValue(MANAGER_AUTH);
    db.leaveRequest.findUnique.mockResolvedValue(PENDING_REQUEST);
    db.user.findUnique.mockResolvedValue({ managerId: "u-mgr" });
    db.leaveRequest.updateMany.mockResolvedValue({ count: 1 });

    await decideLeaveRequest({ requestId: "lr-1", decision: "REJECT" });
    expect(db.leaveRequest.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "lr-1", status: "PENDING" },
        data: expect.objectContaining({ status: "REJECTED" }),
      }),
    );
  });

  it("QA-16: a concurrent decision on the reject path surfaces the race, not silence", async () => {
    requirePermissionMock.mockResolvedValue(MANAGER_AUTH);
    db.leaveRequest.findUnique.mockResolvedValue(PENDING_REQUEST);
    db.user.findUnique.mockResolvedValue({ managerId: "u-mgr" });
    db.leaveRequest.updateMany.mockResolvedValue({ count: 0 });

    const res = await decideLeaveRequest({ requestId: "lr-1", decision: "REJECT" });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/no longer pending|already/i);
  });

  // -----------------------------------------------------------------------
  // QA-1 — overdraft guard. Balance is validated at SUBMISSION only; two
  // non-overlapping requests both pass it, so approving the second one
  // after the first consumed the balance must be refused, not blindly
  // debited (which showed a negative "days left" to the member).
  // -----------------------------------------------------------------------

  it("QA-1: refuses approval when the remaining balance no longer covers the request", async () => {
    requirePermissionMock.mockResolvedValue(MANAGER_AUTH);
    db.leaveRequest.findUnique.mockResolvedValue({ ...PENDING_REQUEST, days: 6 });
    db.user.findUnique.mockResolvedValue({ managerId: "u-mgr" });
    // Entitled 20, 15 already consumed by previously approved requests →
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
    expect(db.leaveBalance.update).not.toHaveBeenCalled();
  });

  it("QA-1: approves exactly at the remaining balance (boundary is inclusive)", async () => {
    requirePermissionMock.mockResolvedValue(MANAGER_AUTH);
    db.leaveRequest.findUnique.mockResolvedValue({ ...PENDING_REQUEST, days: 5 });
    db.user.findUnique.mockResolvedValue({ managerId: "u-mgr" });
    db.leaveLedgerEntry.groupBy.mockResolvedValue([
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
  });

  it("QA-1: materializes a missing balance row inside the transaction before debiting", async () => {
    requirePermissionMock.mockResolvedValue(MANAGER_AUTH);
    db.leaveRequest.findUnique.mockResolvedValue(PENDING_REQUEST);
    db.user.findUnique.mockResolvedValue({ managerId: "u-mgr" });
    db.leaveBalance.findUnique.mockResolvedValue(null); // never materialized
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
  });

  // -----------------------------------------------------------------------
  // F1.3 — approving leave derives ON_LEAVE attendance rows (side effect
  // INSIDE the approval transaction — a rolled-back approval can never
  // leave phantom rows).
  // -----------------------------------------------------------------------

  it("F1.3: approving derives ON_LEAVE attendance rows for every uncovered date in range", async () => {
    requirePermissionMock.mockResolvedValue(MANAGER_AUTH);
    db.leaveRequest.findUnique.mockResolvedValue(PENDING_REQUEST);
    db.user.findUnique.mockResolvedValue({ managerId: "u-mgr" });
    db.leaveType.findUnique.mockResolvedValue(ANNUAL_TYPE);
    db.attendanceRecord.findMany.mockResolvedValue([]); // nothing marked yet

    const res = await decideLeaveRequest({ requestId: "lr-1", decision: "APPROVE" });
    expect(res.ok).toBe(true);
    expect(db.attendanceRecord.createMany).toHaveBeenCalledWith({
      data: [parseDay(isoDay(7)), parseDay(isoDay(8))].map((d) => ({
        userId: "u-theo",
        date: d,
        status: "ON_LEAVE",
        note: "Derived from approved Annual Leave leave",
        source: "DERIVED",
      })),
    });
  });

  it("F1.3: dates that already have ANY record are skipped — an explicit HR mark wins", async () => {
    requirePermissionMock.mockResolvedValue(MANAGER_AUTH);
    db.leaveRequest.findUnique.mockResolvedValue(PENDING_REQUEST);
    db.user.findUnique.mockResolvedValue({ managerId: "u-mgr" });
    db.leaveType.findUnique.mockResolvedValue(ANNUAL_TYPE);
    // HR already marked day 7 WFH — only day 8 gets derived.
    db.attendanceRecord.findMany.mockResolvedValue([{ date: parseDay(isoDay(7)) }]);

    const res = await decideLeaveRequest({ requestId: "lr-1", decision: "APPROVE" });
    expect(res.ok).toBe(true);
    expect(db.attendanceRecord.createMany).toHaveBeenCalledWith({
      data: [{
        userId: "u-theo",
        date: parseDay(isoDay(8)),
        status: "ON_LEAVE",
        note: "Derived from approved Annual Leave leave",
        source: "DERIVED",
      }],
    });
  });

  it("F1.3: rejecting never derives attendance rows", async () => {
    requirePermissionMock.mockResolvedValue(MANAGER_AUTH);
    db.leaveRequest.findUnique.mockResolvedValue(PENDING_REQUEST);
    db.user.findUnique.mockResolvedValue({ managerId: "u-mgr" });

    const res = await decideLeaveRequest({ requestId: "lr-1", decision: "REJECT" });
    expect(res.ok).toBe(true);
    expect(db.attendanceRecord.createMany).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// cancelLeaveRequest
// ---------------------------------------------------------------------------

describe("cancelLeaveRequest", () => {
  it("requester cancels a PENDING request without balance changes", async () => {
    requirePermissionMock.mockResolvedValue(MEMBER_AUTH);
    db.leaveRequest.findUnique.mockResolvedValue(PENDING_REQUEST);
    const res = await cancelLeaveRequest({ requestId: "lr-1" });
    expect(res.ok).toBe(true);
    expect(db.leaveBalance.update).not.toHaveBeenCalled();
    expect(db.leaveRequest.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "CANCELLED" }) }),
    );
  });

  it("cancelling an APPROVED request writes the reversal row and restores the balance", async () => {
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
    );
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "leave.cancelled", detail: expect.stringContaining("balance restored") }),
    );
  });

  it("refuses a cancel by someone other than the requester/admin", async () => {
    requirePermissionMock.mockResolvedValue({ ...MEMBER_AUTH, userId: "u-someone-else", role: "MEMBER" as const });
    db.leaveRequest.findUnique.mockResolvedValue(PENDING_REQUEST);
    const res = await cancelLeaveRequest({ requestId: "lr-1" });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/requester/i);
  });

  it("refuses cancelling an already-decided (REJECTED) request", async () => {
    requirePermissionMock.mockResolvedValue(MEMBER_AUTH);
    db.leaveRequest.findUnique.mockResolvedValue({ ...PENDING_REQUEST, status: "REJECTED" });
    const res = await cancelLeaveRequest({ requestId: "lr-1" });
    expect(res.ok).toBe(false);
  });

  it("QA-1: floors the balance restore at zero when used is already lower than the request's days", async () => {
    requirePermissionMock.mockResolvedValue(MEMBER_AUTH);
    // Hand-edited / drift state: only 1 day used but the request debited 2.
    db.leaveRequest.findUnique.mockResolvedValue({ ...PENDING_REQUEST, status: "APPROVED" });
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
  });

  // -----------------------------------------------------------------------
  // QA-16 (cancel side) — the status precheck sits outside the write. Two
  // tabs cancelling the same APPROVED request both pass it; the second
  // cancel must not restore the days a second time. Worse interleaving:
  // a cancel that read PENDING races an approval — the plain update then
  // flips the just-approved request to CANCELLED without ever restoring
  // the days the approval debited (permanent balance leak). The guarded
  // write makes the stale cancel a zero-row update → clear error, and
  // the retry takes the proper restore path.
  // -----------------------------------------------------------------------

  it("QA-16: cancelling an APPROVED request guards the write on APPROVED status", async () => {
    requirePermissionMock.mockResolvedValue(MEMBER_AUTH);
    db.leaveRequest.findUnique.mockResolvedValue({ ...PENDING_REQUEST, status: "APPROVED" });
    db.leaveBalance.findUnique.mockResolvedValue({ entitled: 20, carriedOver: 0, used: 2 });
    db.leaveRequest.updateMany.mockResolvedValue({ count: 1 });

    const res = await cancelLeaveRequest({ requestId: "lr-1" });
    expect(res.ok).toBe(true);
    expect(db.leaveRequest.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "lr-1", status: "APPROVED" },
        data: expect.objectContaining({ status: "CANCELLED" }),
      }),
    );
  });

  it("QA-16: a concurrent cancel (zero-row guarded write) aborts before restoring days", async () => {
    requirePermissionMock.mockResolvedValue(MEMBER_AUTH);
    // This cancel read APPROVED; another tab already cancelled it.
    db.leaveRequest.findUnique.mockResolvedValue({ ...PENDING_REQUEST, status: "APPROVED" });
    db.leaveRequest.updateMany.mockResolvedValue({ count: 0 });

    const res = await cancelLeaveRequest({ requestId: "lr-1" });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.code).toBe("AUTH");
    expect(res.ok === false && res.error).toMatch(/no longer|already/i);
    // Aborted before the reversal — no ledger row, no cache write.
    expect(db.leaveLedgerEntry.create).not.toHaveBeenCalled();
    expect(db.leaveBalance.update).not.toHaveBeenCalled();
  });

  it("QA-16: cancelling a PENDING request guards the write on PENDING status", async () => {
    requirePermissionMock.mockResolvedValue(MEMBER_AUTH);
    db.leaveRequest.findUnique.mockResolvedValue(PENDING_REQUEST);
    db.leaveRequest.updateMany.mockResolvedValue({ count: 1 });

    const res = await cancelLeaveRequest({ requestId: "lr-1" });
    expect(res.ok).toBe(true);
    expect(db.leaveRequest.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "lr-1", status: "PENDING" },
        data: expect.objectContaining({ status: "CANCELLED" }),
      }),
    );
    expect(db.leaveBalance.update).not.toHaveBeenCalled();
  });

  it("QA-16: a PENDING cancel that races an approval loses cleanly (no silent leak)", async () => {
    requirePermissionMock.mockResolvedValue(MEMBER_AUTH);
    // This cancel read PENDING; an approval landed first — the row is now
    // APPROVED, so the guarded PENDING write matches nothing.
    db.leaveRequest.findUnique.mockResolvedValue(PENDING_REQUEST);
    db.leaveRequest.updateMany.mockResolvedValue({ count: 0 });

    const res = await cancelLeaveRequest({ requestId: "lr-1" });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/no longer pending|approved/i);
    expect(db.leaveBalance.update).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // F1.3 — cancelling approved leave removes its DERIVED ON_LEAVE rows
  // (unless another approved request still covers the date).
  // -----------------------------------------------------------------------

  it("F1.3: cancelling an APPROVED request removes its derived ON_LEAVE rows", async () => {
    requirePermissionMock.mockResolvedValue(MEMBER_AUTH);
    db.leaveRequest.findUnique.mockResolvedValue({ ...PENDING_REQUEST, status: "APPROVED" });
    db.leaveBalance.findUnique.mockResolvedValue({ entitled: 20, carriedOver: 0, used: 2 });
    // No other approved request overlaps the range.
    db.leaveRequest.findMany.mockResolvedValue([]);
    db.attendanceRecord.findMany.mockResolvedValue([
      { date: parseDay(isoDay(7)) },
      { date: parseDay(isoDay(8)) },
    ]);

    const res = await cancelLeaveRequest({ requestId: "lr-1" });
    expect(res.ok).toBe(true);
    expect(db.attendanceRecord.deleteMany).toHaveBeenCalledWith({
      where: {
        userId: "u-theo",
        source: "DERIVED",
        status: "ON_LEAVE",
        date: { in: [parseDay(isoDay(7)), parseDay(isoDay(8))] },
      },
    });
  });

  it("F1.3: derived rows for dates still covered by ANOTHER approved request survive the cancel", async () => {
    requirePermissionMock.mockResolvedValue(MEMBER_AUTH);
    db.leaveRequest.findUnique.mockResolvedValue({ ...PENDING_REQUEST, status: "APPROVED" });
    db.leaveBalance.findUnique.mockResolvedValue({ entitled: 20, carriedOver: 0, used: 2 });
    // An overlapping approved request still covers day 7.
    db.leaveRequest.findMany.mockResolvedValue([
      { startDate: parseDay(isoDay(7)), endDate: parseDay(isoDay(7)) },
    ]);
    db.attendanceRecord.findMany.mockResolvedValue([
      { date: parseDay(isoDay(7)) },
      { date: parseDay(isoDay(8)) },
    ]);

    const res = await cancelLeaveRequest({ requestId: "lr-1" });
    expect(res.ok).toBe(true);
    // Only day 8 is deleted; day 7 stays (the other request owns it now).
    expect(db.attendanceRecord.deleteMany).toHaveBeenCalledWith({
      where: {
        userId: "u-theo",
        source: "DERIVED",
        status: "ON_LEAVE",
        date: { in: [parseDay(isoDay(8))] },
      },
    });
  });
});

// ---------------------------------------------------------------------------
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
    // Blanket every day from +1 to +4 as a holiday. The request starts +5
    // (inside the 3N+1 = 7-day near window, so the notice count runs
    // holiday-aware): the notice window (today, +5] retains at most ONE
    // unblanketed working day (+5 itself) — 0 or 1 working days of notice
    // < 2 → refused by the notice rail. The request's own range [+5, +9]
    // contains no holiday entries (workingDaysBetween only reads keys
    // inside the range), so the day-count check passes first and the
    // assertion targets the notice rail specifically — deterministic on
    // every weekday the suite can start on.
    const hol = [1, 2, 3, 4].map((n) => {
      const d = new Date();
      d.setUTCHours(0, 0, 0, 0);
      d.setUTCDate(d.getUTCDate() + n);
      return { date: d, isHalfDay: false };
    });
    db.holidayCalendarEntry.findMany.mockResolvedValue(hol);
    const start = new Date();
    start.setUTCHours(0, 0, 0, 0);
    start.setUTCDate(start.getUTCDate() + 5);
    const end = new Date();
    end.setUTCHours(0, 0, 0, 0);
    end.setUTCDate(end.getUTCDate() + 9);
    const res = await createLeaveRequest({
      leaveTypeId: "lt-annual",
      startDate: start.toISOString().slice(0, 10),
      endDate: end.toISOString().slice(0, 10),
    });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/notice/i);
    expect(db.leaveRequest.create).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Types & policies (hr:admin)
// ---------------------------------------------------------------------------

describe("createLeaveType / updateLeaveType", () => {
  it("creates a type with its policy (hr:admin only)", async () => {
    requirePermissionMock.mockResolvedValue(ADMIN_AUTH);
    db.leaveType.create.mockResolvedValue({ id: "lt-new", name: "Parental", code: "PARENTAL" });
    const res = await createLeaveType({
      name: "Parental",
      code: "PARENTAL",
      color: "#8b5cf6",
      policy: { annualDays: 10, maxCarryOver: 0, minNoticeDays: 14, maxConsecutiveDays: 90 },
    });
    expect(res.ok).toBe(true);
    expect(db.leaveType.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          name: "Parental",
          code: "PARENTAL",
          // F2.4 — the strategy block lands with the zod defaults (MANUAL,
          // no negative allowance, holidays excluded): a legacy-shaped input
          // creates exactly the legacy-shaped policy.
          policy: {
            create: expect.objectContaining({
              annualDays: 10, maxCarryOver: 0, minNoticeDays: 14, maxConsecutiveDays: 90,
              allocationStrategy: "MANUAL", allowNegative: false, negativeFloor: 0,
              countHolidaysInLeave: false,
            }),
          },
        }),
      }),
    );
  });

  it("denies type creation to a MANAGER (no hr:admin)", async () => {
    requirePermissionMock.mockImplementation(async (perm: string) => {
      if (perm === "hr:admin") {
        throw new (class extends Error { digest = "AuthorizationError"; })("denied");
      }
      return MANAGER_AUTH;
    });
    const res = await createLeaveType({
      name: "X", code: "X", policy: { annualDays: 1, maxCarryOver: 0, minNoticeDays: 0, maxConsecutiveDays: 1 },
    });
    expect(res.ok).toBe(false);
    expect(db.leaveType.create).not.toHaveBeenCalled();
  });

  it("updates a type and upserts its policy", async () => {
    requirePermissionMock.mockResolvedValue(ADMIN_AUTH);
    db.leaveType.findUnique.mockResolvedValue({ id: "lt-annual", name: "Annual Leave" });
    const res = await updateLeaveType("lt-annual", {
      policy: { annualDays: 25, maxCarryOver: 5, minNoticeDays: 1, maxConsecutiveDays: 15 },
    });
    expect(res.ok).toBe(true);
    expect(db.leavePolicy.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { leaveTypeId: "lt-annual" },
        update: expect.objectContaining({
          annualDays: 25, maxCarryOver: 5, minNoticeDays: 1, maxConsecutiveDays: 15,
          // F2.4 — zod defaults fill the strategy block (legacy semantics).
          allocationStrategy: "MANUAL", allowNegative: false,
        }),
      }),
    );
  });

  // -----------------------------------------------------------------------
  // QA-18 — LeaveType.name and .code are @unique. Creating a duplicate
  // threw Prisma P2002, which toResult converted into the generic INTERNAL
  // "Something went wrong. Please try again." — the admin had no idea the
  // name was taken (it looks like a server bug, and retrying can never
  // succeed). The result.ts isUniqueConstraintError helper existed for
  // exactly this and was wired to nothing.
  // -----------------------------------------------------------------------

  it("QA-18: a duplicate type name surfaces a friendly conflict, not a generic 500", async () => {
    requirePermissionMock.mockResolvedValue(ADMIN_AUTH);
    db.leaveType.create.mockRejectedValue({ code: "P2002" });
    const res = await createLeaveType({
      name: "Annual Leave",
      code: "ANNUAL",
      policy: { annualDays: 20, maxCarryOver: 5, minNoticeDays: 1, maxConsecutiveDays: 15 },
    });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.code).toBe("AUTH");
    expect(res.ok === false && res.error).toMatch(/already exists/i);
    expect(res.ok === false && res.error).not.toMatch(/something went wrong/i);
  });
});

// ---------------------------------------------------------------------------
// Read actions
// ---------------------------------------------------------------------------

describe("getMyLeaveData", () => {
  it("returns balances lazily materialized from policy entitlements", async () => {
    requirePermissionMock.mockResolvedValue(MEMBER_AUTH);
    db.leaveType.findMany.mockResolvedValue([ANNUAL_TYPE]);
    db.leaveRequest.findMany.mockResolvedValue([]);
    // PR-19 — no balance row exists: the batched read returns nothing, the
    // loader materializes the entitlement via ONE createMany (not a
    // per-type loop), and the fallback entitlement is used for this render.
    db.leaveBalance.findMany.mockResolvedValue([]);
    const res = await getMyLeaveData();
    expect(res.ok).toBe(true);
    expect(db.leaveBalance.createMany).toHaveBeenCalledTimes(1);
    expect(db.leaveBalance.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [expect.objectContaining({ leaveTypeId: "lt-annual", entitled: 20, carriedOver: 0, used: 0 })],
      }),
    );
    if (res.ok) {
      expect(res.data.balances).toHaveLength(1);
      expect(res.data.balances[0]).toMatchObject({ typeName: "Annual Leave", available: 20 });
    }
  });

  // -----------------------------------------------------------------------
  // QA-21 — the loader resolved the pending approver ids of MY pending
  // requests (getApproverIdsFor per request) and folded their names into
  // the decider-names map… which is only ever read with decidedById —
  // always null for PENDING rows. Dead queries on every Leave-view load.
  // -----------------------------------------------------------------------

  it("QA-21: does not resolve approver names for pending requests (they were never rendered)", async () => {
    requirePermissionMock.mockResolvedValue(MEMBER_AUTH);
    db.leaveType.findMany.mockResolvedValue([ANNUAL_TYPE]);
    db.leaveRequest.findMany.mockResolvedValue([
      { ...PENDING_REQUEST, leaveTypeId: "lt-annual", createdAt: new Date("2026-01-01T00:00:00.000Z") },
      { ...REQUEST_ROW, leaveTypeId: "lt-annual", status: "APPROVED", decidedById: "u-mgr" },
    ]);
    db.leaveBalance.findMany.mockResolvedValue([{ leaveTypeId: "lt-annual", ...BALANCE }]);
    db.user.findMany.mockResolvedValue([{ id: "u-mgr", name: "Ingrid" }]);
    const res = await getMyLeaveData();
    expect(res.ok).toBe(true);
    // No per-request approver resolution walks — decided names come from a
    // single findMany, and pending rows render "awaiting a decision" only.
    expect(db.user.findUnique).not.toHaveBeenCalled();
    if (res.ok) {
      const pending = res.data.requests.find((r) => r.status === "PENDING");
      const decided = res.data.requests.find((r) => r.status === "APPROVED");
      expect(pending?.decidedBy).toBeNull();
      expect(decided?.decidedBy).toBe("Ingrid");
    }
  });
});

describe("getLeaveQueue", () => {
  it("scopes a MANAGER's queue to their subtree", async () => {
    requirePermissionMock.mockResolvedValue(MANAGER_AUTH);
    db.leaveRequest.findMany.mockResolvedValue([]);
    db.leaveType.findMany.mockResolvedValue([]);
    const res = await getLeaveQueue();
    expect(res.ok).toBe(true);
    expect(db.leaveRequest.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ userId: { in: expect.any(Array) } }) }),
    );
  });

  it("shows the whole workspace to an admin", async () => {
    requirePermissionMock.mockResolvedValue(ADMIN_AUTH);
    db.leaveRequest.findMany.mockResolvedValue([]);
    db.leaveType.findMany.mockResolvedValue([]);
    const res = await getLeaveQueue();
    expect(res.ok).toBe(true);
    expect(db.leaveRequest.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: {} }),
    );
  });
});

// ---------------------------------------------------------------------------
// Read-action mapping (non-empty rows) — exercises the serializer callbacks
// and their fallback branches that empty-array tests never reach.
// ---------------------------------------------------------------------------

const REQUEST_ROW = {
  id: "lr-9",
  leaveTypeId: "lt-annual",
  userId: "u-theo",
  startDate: new Date("2027-06-07T00:00:00.000Z"),
  endDate: new Date("2027-06-08T00:00:00.000Z"),
  days: 2,
  reason: "Trip",
  status: "PENDING",
  decidedById: null,
  decidedAt: null,
  decisionNote: "",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
};

describe("read mapping with data", () => {
  it("getMyLeaveData maps request rows including the approver name", async () => {
    requirePermissionMock.mockResolvedValue(MEMBER_AUTH);
    db.leaveType.findMany.mockResolvedValue([ANNUAL_TYPE]);
    db.leaveRequest.findMany.mockResolvedValue([REQUEST_ROW]);
    db.leaveBalance.findMany.mockResolvedValue([{ leaveTypeId: "lt-annual", entitled: 20, carriedOver: 0, used: 0 }]);
    db.user.findUnique.mockResolvedValue({ managerId: "u-mgr" });
    db.user.findMany.mockResolvedValue([{ id: "u-mgr", name: "Ingrid" }]);
    const res = await getMyLeaveData();
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.requests).toHaveLength(1);
      expect(res.data.requests[0]).toMatchObject({
        typeName: "Annual Leave",
        typeColor: "#8b5cf6",
        userName: "Theo",
        days: 2,
        status: "PENDING",
        startDate: "2027-06-07",
        endDate: "2027-06-08",
      });
      expect(res.data.balances[0]).toMatchObject({ available: 20 });
    }
  });

  it("getMyLeaveData falls back to a generic type name for orphaned rows", async () => {
    requirePermissionMock.mockResolvedValue(MEMBER_AUTH);
    db.leaveType.findMany.mockResolvedValue([]); // type deleted → fallback
    db.leaveRequest.findMany.mockResolvedValue([REQUEST_ROW]);
    const res = await getMyLeaveData();
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.requests[0].typeName).toBe("Leave");
      expect(res.data.requests[0].typeColor).toBe("#8b5cf6");
    }
  });

  it("getLeaveQueue maps decided rows with the decider name (admin, unscoped)", async () => {
    requirePermissionMock.mockResolvedValue(ADMIN_AUTH);
    db.leaveRequest.findMany.mockResolvedValue([
      { ...REQUEST_ROW, status: "APPROVED", decidedById: "u-mgr", decidedAt: new Date("2026-02-02"), decisionNote: "Enjoy" },
    ]);
    db.leaveType.findMany.mockResolvedValue([ANNUAL_TYPE]);
    db.user.findMany.mockResolvedValue([{ id: "u-theo", name: "Theo" }, { id: "u-mgr", name: "Ingrid" }]);
    const res = await getLeaveQueue();
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.requests[0].userName).toBe("Theo");
      expect(res.data.requests[0].decidedBy).toBe("Ingrid");
      expect(res.data.requests[0].decisionNote).toBe("Enjoy");
      expect(res.data.canAdmin).toBe(true);
      expect(res.data.types[0].policy).toMatchObject({ annualDays: 20 });
    }
  });

  it("getLeaveQueue renders a former-user fallback for deleted requesters", async () => {
    requirePermissionMock.mockResolvedValue(ADMIN_AUTH);
    db.leaveRequest.findMany.mockResolvedValue([
      { ...REQUEST_ROW, status: "REJECTED", decidedById: "u-ghost", decidedAt: new Date("2026-02-02") },
    ]);
    db.leaveType.findMany.mockResolvedValue([ANNUAL_TYPE]);
    db.user.findMany.mockResolvedValue([]); // nobody resolves → fallbacks
    const res = await getLeaveQueue();
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.requests[0].userName).toBe("(former user)");
      expect(res.data.requests[0].decidedBy).toBeNull();
    }
  });

  it("getMyLeaveData maps a decided request without a decider lookup miss", async () => {
    requirePermissionMock.mockResolvedValue(MEMBER_AUTH);
    db.leaveType.findMany.mockResolvedValue([ANNUAL_TYPE]);
    db.leaveRequest.findMany.mockResolvedValue([
      { ...REQUEST_ROW, status: "REJECTED", decidedById: "u-mgr", decidedAt: new Date("2026-02-02"), decisionNote: "No" },
    ]);
    db.user.findMany.mockResolvedValue([{ id: "u-mgr", name: "Ingrid" }]);
    db.leaveBalance.findMany.mockResolvedValue([{ leaveTypeId: "lt-annual", entitled: 20, carriedOver: 0, used: 0 }]);
    const res = await getMyLeaveData();
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.requests[0].decidedBy).toBe("Ingrid");
      expect(res.data.requests[0].decisionNote).toBe("No");
    }
  });
});

// ---------------------------------------------------------------------------
// PR-56 — remaining branch coverage: the best-effort notification catch
// blocks, the unique-trio race winner re-read inside the approve transaction,
// the not-found guards, and the non-unique createLeaveType rethrow.
// ---------------------------------------------------------------------------

describe("PR-56 — remaining branch coverage", () => {
  it("pins hr-leave.ts:332 — a notification createMany failure never breaks the leave request", async () => {
    requirePermissionMock.mockResolvedValue(MEMBER_AUTH);
    db.leaveType.findUnique.mockResolvedValue(ANNUAL_TYPE);
    // The approver must resolve so createMany is actually reached.
    db.user.findUnique.mockResolvedValue({ managerId: "u-mgr" });
    db.notification.createMany.mockRejectedValue(new Error("broker down"));

    const res = await createLeaveRequest({ leaveTypeId: "lt-annual", startDate: "2027-06-07", endDate: "2027-06-08" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data).toEqual({ id: "lr-1", days: 2 });
    expect(logErrorSpy).toHaveBeenCalledWith("[hr-leave] notification createMany failed:", expect.any(Error));
    // The request itself still lands — audit and all.
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "leave.requested" }));
  });

  it("F1.2: a unique-trio race on the approve-path materialize aborts loudly (retryable), never silently", async () => {
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
  });

  it("pins hr-leave.ts:481 — a notification create failure never breaks the decision", async () => {
    requirePermissionMock.mockResolvedValue(MANAGER_AUTH);
    db.leaveRequest.findUnique.mockResolvedValue(PENDING_REQUEST);
    db.user.findUnique.mockResolvedValue({ managerId: "u-mgr", name: "Theo" });
    db.notification.create.mockRejectedValue(new Error("SMTP down"));

    const res = await decideLeaveRequest({ requestId: "lr-1", decision: "APPROVE", note: "Enjoy" });
    expect(res.ok).toBe(true);
    expect(logErrorSpy).toHaveBeenCalledWith("[hr-leave] notification create failed:", expect.any(Error));
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "leave.approved" }));
  });

  it("pins hr-leave.ts:507 — cancelling an unknown leave request fails with not-found", async () => {
    requirePermissionMock.mockResolvedValue(MEMBER_AUTH);
    db.leaveRequest.findUnique.mockResolvedValue(null);

    const res = await cancelLeaveRequest({ requestId: "lr-ghost" });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.code).toBe("AUTH");
    expect(res.ok === false && res.error).toMatch(/leave request not found/i);
    expect(db.leaveRequest.updateMany).not.toHaveBeenCalled();
  });

  it("pins hr-leave.ts:620 — a non-unique createLeaveType failure is rethrown as generic INTERNAL", async () => {
    requirePermissionMock.mockResolvedValue(ADMIN_AUTH);
    db.leaveType.create.mockRejectedValue(new Error("database unavailable"));

    const res = await createLeaveType({
      name: "Sabbatical",
      code: "SABBATICAL",
      policy: { annualDays: 30, maxCarryOver: 0, minNoticeDays: 30, maxConsecutiveDays: 90 },
    });
    expect(res.ok).toBe(false);
    // NOT the P2002 friendly message — the rethrown error reaches the
    // generic INTERNAL arm of toResult.
    expect(res.ok === false && res.code).toBe("INTERNAL");
    expect(res.ok === false && res.error).toMatch(/something went wrong/i);
    expect(res.ok === false && res.error).not.toMatch(/already exists/i);
    expect(logErrorSpy).toHaveBeenCalledWith("[action] unexpected failure:", expect.any(Error));
  });

  it("pins hr-leave.ts:654 — updating an unknown leave type fails with not-found", async () => {
    requirePermissionMock.mockResolvedValue(ADMIN_AUTH);
    db.leaveType.findUnique.mockResolvedValue(null);

    const res = await updateLeaveType("lt-ghost", { name: "Ghost Leave" });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.code).toBe("AUTH");
    expect(res.ok === false && res.error).toMatch(/leave type not found/i);
    expect(db.leaveType.update).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// PR-56 — remaining hr-shared branch coverage (suffixed to stay distinct
// from the hr-leave.ts PR-56 block above): the calendar-invalid date guard
// in parseDay, and the two unique-trio race catches that log the conflict
// and re-read the concurrent winner's row instead of failing the read path.
// ---------------------------------------------------------------------------

describe("LV-B08 (S12) — cross-request consecutive walk in createLeaveRequest", () => {
  it("a request touching an ACTIVE same-type request over the cap is refused with the chain named", async () => {
    db.leaveType.findUnique.mockResolvedValue({
      ...ANNUAL_TYPE,
      policy: { ...ANNUAL_TYPE.policy, maxConsecutiveDays: 6 },
    });
    // Fixed far-future dates (past every notice window): an approved
    // Mon–Fri 2027-03-01→05 request; the new one is the FOLLOWING Mon–Tue
    // 2027-03-08→09 → a touching chain of 7 working days > 6.
    db.leaveRequest.findMany.mockImplementation(async ({ where }: { where?: { status?: { in?: string[] } } }) => {
      if (where?.status?.in?.includes("PENDING")) {
        return [{
          startDate: new Date("2027-03-01T00:00:00Z"),
          endDate: new Date("2027-03-05T00:00:00Z"),
        }];
      }
      return [];
    });
    db.leaveRequest.findFirst.mockResolvedValue(null); // no overlap
    const res = await createLeaveRequest({
      leaveTypeId: "lt-annual", startDate: "2027-03-08", endDate: "2027-03-09", reason: "chained week",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain("chains with your other");
      expect(res.error).toContain("consecutive day(s)");
    }
    expect(db.leaveRequest.create).not.toHaveBeenCalled();
  });

  it("a REJECTED/CANCELLED neighbour never chains (only ACTIVE requests count)", async () => {
    db.leaveType.findUnique.mockResolvedValue({
      ...ANNUAL_TYPE,
      policy: { ...ANNUAL_TYPE.policy, maxConsecutiveDays: 6 },
    });
    db.leaveRequest.findMany.mockResolvedValue([]); // the walk finds no ACTIVE rows
    db.leaveRequest.findFirst.mockResolvedValue(null);
    const res = await createLeaveRequest({
      leaveTypeId: "lt-annual", startDate: "2027-03-08", endDate: "2027-03-09", reason: "after a cancelled week",
    });
    expect(res.ok).toBe(true);
  });
});

describe("LV-B11 (S11) — attendance-conflict guard in the leave chain", () => {
  it("an explicit attendance mark inside the range refuses the request, naming the date + status", async () => {
    db.leaveType.findUnique.mockResolvedValue(ANNUAL_TYPE);
    db.attendanceRecord.findMany.mockImplementation(async ({ where }: { where?: { status?: { in?: string[] } } }) => {
      // The chain reads attendance twice: the conflict guard (statuses
      // filtered) answers with a clash; other reads stay empty.
      if (where?.status?.in?.includes("PRESENT")) {
        return [{ date: new Date(`${isoDay(3)}T00:00:00Z`), status: "PRESENT" }];
      }
      return [];
    });
    const res = await createLeaveRequest({
      leaveTypeId: "lt-annual", startDate: isoDay(3), endDate: isoDay(5), reason: "clash",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain("Attendance is already marked");
      expect(res.error).toContain("PRESENT");
    }
    expect(db.leaveRequest.create).not.toHaveBeenCalled();
  });

  it("ON_LEAVE rows (derived or manual) never conflict — they ARE the leave story", async () => {
    db.leaveType.findUnique.mockResolvedValue(ANNUAL_TYPE);
    // The guard's DB-side status filter (PRESENT/ABSENT/HALF_DAY/WFH) is
    // honored by the mock: the ON_LEAVE row exists but never reaches the
    // conflict list.
    db.attendanceRecord.findMany.mockImplementation(async ({ where }: { where?: { status?: { in?: string[] } } }) => {
      const statuses = where?.status?.in as string[] | undefined;
      if (statuses) {
        const all = [{ date: new Date(`${isoDay(3)}T00:00:00Z`), status: "ON_LEAVE" }];
        return all.filter((r) => statuses.includes(r.status));
      }
      return [{ date: new Date(`${isoDay(3)}T00:00:00Z`), status: "ON_LEAVE" }];
    });
    const res = await createLeaveRequest({
      leaveTypeId: "lt-annual", startDate: isoDay(3), endDate: isoDay(5), reason: "over derived rows",
    });
    expect(res.ok).toBe(true);
  });

  it("marks OUTSIDE the range do not block the request (the guard's date window is DB-side)", async () => {
    db.leaveType.findUnique.mockResolvedValue(ANNUAL_TYPE);
    // An ABSENT mark 20 days out exists; the guard's read (statuses filter)
    // returns nothing inside the requested window.
    db.attendanceRecord.findMany.mockImplementation(async ({ where }: { where?: { status?: { in?: string[] } } }) => {
      if (where?.status?.in) return [];
      return [{ date: new Date(`${isoDay(20)}T00:00:00Z`), status: "ABSENT" }];
    });
    const res = await createLeaveRequest({
      leaveTypeId: "lt-annual", startDate: isoDay(3), endDate: isoDay(5), reason: "unrelated mark",
    });
    expect(res.ok).toBe(true);
  });
});

describe("LV-B10 (S10) — salary-processed guard on unpaid leave", () => {
  const UNPAID_TYPE = { ...ANNUAL_TYPE, paid: false, name: "Unpaid Leave" };

  it("monthsInRange walks the months a range touches (inclusive, multi-month)", () => {
    expect(monthsInRange(new Date("2026-10-28T00:00:00Z"), new Date("2026-10-31T00:00:00Z"))).toEqual(["2026-10"]);
    expect(monthsInRange(new Date("2026-10-28T00:00:00Z"), new Date("2026-12-02T00:00:00Z"))).toEqual(["2026-10", "2026-11", "2026-12"]);
    expect(monthsInRange(new Date("2026-12-31T00:00:00Z"), new Date("2027-01-01T00:00:00Z"))).toEqual(["2026-12", "2027-01"]);
    expect(monthsInRange(new Date("2026-12-02T00:00:00Z"), new Date("2026-12-01T00:00:00Z"))).toEqual([]);
  });

  it("unpaid leave overlapping a LOCKED run's month is refused, naming the period", async () => {
    db.leaveType.findUnique.mockResolvedValue(UNPAID_TYPE);
    db.payslip.findMany.mockResolvedValue([
      { run: { period: "2026-11" } },
      { run: { period: "2026-10" } },
    ]);
    const res = await createLeaveRequest({
      leaveTypeId: "lt-annual", startDate: isoDay(3), endDate: isoDay(5), reason: "unpaid stretch",
    });
    // The default request window is the CURRENT month — a locked period
    // equal to it makes the guard fire.
    const currentPeriod = `${new Date().getUTCFullYear()}-${String(new Date().getUTCMonth() + 1).padStart(2, "0")}`;
    if (["2026-11", "2026-10"].includes(currentPeriod)) {
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toContain("already been processed");
    } else {
      // Far-period fixture: force the clash explicitly.
      db.payslip.findMany.mockResolvedValue([{ run: { period: currentPeriod } }]);
      const res2 = await createLeaveRequest({
        leaveTypeId: "lt-annual", startDate: isoDay(3), endDate: isoDay(5), reason: "unpaid stretch",
      });
      expect(res2.ok).toBe(false);
      if (!res2.ok) expect(res2.error).toContain("already been processed");
    }
    expect(db.leaveRequest.create).not.toHaveBeenCalled();
  });

  it("PAID leave is never blocked by processed salary (no LOP dock)", async () => {
    db.leaveType.findUnique.mockResolvedValue(ANNUAL_TYPE);
    db.payslip.findMany.mockResolvedValue([{ run: { period: `${new Date().getUTCFullYear()}-${String(new Date().getUTCMonth() + 1).padStart(2, "0")}` } }]);
    const res = await createLeaveRequest({
      leaveTypeId: "lt-annual", startDate: isoDay(3), endDate: isoDay(5), reason: "paid stretch",
    });
    expect(res.ok).toBe(true);
  });

  it("unpaid leave in a month with only an OPEN run is allowed (not processed yet)", async () => {
    db.leaveType.findUnique.mockResolvedValue(UNPAID_TYPE);
    db.payslip.findMany.mockResolvedValue([{ run: { period: "1999-01" } }]);
    const res = await createLeaveRequest({
      leaveTypeId: "lt-annual", startDate: isoDay(3), endDate: isoDay(5), reason: "unpaid future stretch",
    });
    expect(res.ok).toBe(true);
  });
});

describe("LV-10 (S9) — adjustLeaveBalance (the user-facing ADJUST writer)", () => {
  const HR_ADMIN_AUTH = { userId: "u-hr", role: "HR" as const, name: "Remy", email: "remy@x.co" };

  it("is hr:admin-gated — a member session is refused before any read", async () => {
    requirePermissionMock.mockRejectedValue(new Error("no perm"));
    const res = await adjustLeaveBalance({ userId: "u-theo", leaveTypeId: "lt-annual", year: 2026, delta: 2, reason: "court-ordered correction" });
    expect(res.ok).toBe(false);
    expect(requirePermissionMock).toHaveBeenCalledWith("hr:admin");
  });

  it("writes an ADJUST ledger row with the reason, re-syncs the cache, and audits", async () => {
    requirePermissionMock.mockResolvedValue(HR_ADMIN_AUTH);
    db.user.findUnique.mockResolvedValue({ id: "u-theo", name: "Theo Vance", deletedAt: null });
    db.leaveType.findUnique.mockResolvedValue(ANNUAL_TYPE);
    // Before: GRANT 20 → available 20. After: + ADJUST 2 → 22.
    db.leaveLedgerEntry.groupBy
      .mockResolvedValueOnce([{ entryType: "GRANT", _sum: { delta: 20 } }])
      .mockResolvedValue([{ entryType: "GRANT", _sum: { delta: 20 } }, { entryType: "ADJUST", _sum: { delta: 2 } }]);
    const res = await adjustLeaveBalance({ userId: "u-theo", leaveTypeId: "lt-annual", year: 2026, delta: 2, reason: "Accrual arrears from 2025" });
    if (!res.ok) throw new Error(res.error);
    expect(res.data).toEqual({ availableBefore: 20, availableAfter: 22 });
    const ledgerArg = db.leaveLedgerEntry.create.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(ledgerArg.data).toMatchObject({
      userId: "u-theo", leaveTypeId: "lt-annual", year: 2026,
      delta: 2, entryType: "ADJUST", sourceType: "HR_ADJUSTMENT",
      note: "Accrual arrears from 2025", isReversal: false,
    });
    // Cache re-sync: entitled folds the entitlement-side correction (20 + 2).
    const cacheArg = db.leaveBalance.update.mock.calls[0][0] as { data: { entitled: number; used: number } };
    expect(cacheArg.data.entitled).toBe(22);
    expect(cacheArg.data.used).toBe(0);
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "hr.leave_adjusted" }));
  });

  it("a negative adjustment past the floor is refused with the floor named (no row written)", async () => {
    requirePermissionMock.mockResolvedValue(HR_ADMIN_AUTH);
    db.user.findUnique.mockResolvedValue({ id: "u-theo", name: "Theo Vance", deletedAt: null });
    db.leaveType.findUnique.mockResolvedValue(ANNUAL_TYPE);
    db.leaveLedgerEntry.groupBy.mockResolvedValue([{ entryType: "GRANT", _sum: { delta: 20 } }]);
    const res = await adjustLeaveBalance({ userId: "u-theo", leaveTypeId: "lt-annual", year: 2026, delta: -21, reason: "Dock entitlement" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain("advance floor");
      expect(res.error).toContain("−0-day");
    }
    expect(db.leaveLedgerEntry.create).not.toHaveBeenCalled();
  });

  it("an advance-leave floor (allowNegative + negativeFloor) admits corrections down to it", async () => {
    requirePermissionMock.mockResolvedValue(HR_ADMIN_AUTH);
    db.user.findUnique.mockResolvedValue({ id: "u-theo", name: "Theo Vance", deletedAt: null });
    db.leaveType.findUnique.mockResolvedValue({
      ...ANNUAL_TYPE,
      policy: { ...ANNUAL_TYPE.policy, allowNegative: true, negativeFloor: 5 },
    });
    db.leaveLedgerEntry.groupBy
      .mockResolvedValueOnce([{ entryType: "GRANT", _sum: { delta: 10 } }])
      .mockResolvedValue([{ entryType: "GRANT", _sum: { delta: 10 } }, { entryType: "ADJUST", _sum: { delta: -15 } }]);
    const res = await adjustLeaveBalance({ userId: "u-theo", leaveTypeId: "lt-annual", year: 2026, delta: -15, reason: "Claw back over-granted days" });
    if (!res.ok) throw new Error(res.error);
    expect(res.data.availableAfter).toBe(-5);
    expect(db.leaveLedgerEntry.create).toHaveBeenCalled();
  });

  it("validation: zero delta, non-quarter steps, and missing reasons are refused", async () => {
    requirePermissionMock.mockResolvedValue(HR_ADMIN_AUTH);
    db.user.findUnique.mockResolvedValue({ id: "u-theo", name: "Theo Vance", deletedAt: null });
    db.leaveType.findUnique.mockResolvedValue(ANNUAL_TYPE);
    const zero = await adjustLeaveBalance({ userId: "u-theo", leaveTypeId: "lt-annual", year: 2026, delta: 0, reason: "no-op" });
    expect(zero.ok).toBe(false);
    const dust = await adjustLeaveBalance({ userId: "u-theo", leaveTypeId: "lt-annual", year: 2026, delta: 0.3, reason: "fraction" });
    expect(dust.ok).toBe(false);
    const noReason = await adjustLeaveBalance({ userId: "u-theo", leaveTypeId: "lt-annual", year: 2026, delta: 1, reason: "  " });
    expect(noReason.ok).toBe(false);
  });

  it("friendly 404s: unknown member and unknown leave type", async () => {
    requirePermissionMock.mockResolvedValue(HR_ADMIN_AUTH);
    db.user.findUnique.mockResolvedValue(null);
    const noUser = await adjustLeaveBalance({ userId: "u-ghost", leaveTypeId: "lt-annual", year: 2026, delta: 1, reason: "test" });
    expect(noUser.ok).toBe(false);
    if (!noUser.ok) expect(noUser.error).toContain("Member not found");

    db.user.findUnique.mockResolvedValue({ id: "u-theo", name: "Theo Vance", deletedAt: null });
    db.leaveType.findUnique.mockResolvedValue(null);
    const noType = await adjustLeaveBalance({ userId: "u-theo", leaveTypeId: "lt-ghost", year: 2026, delta: 1, reason: "test" });
    expect(noType.ok).toBe(false);
    if (!noType.ok) expect(noType.error).toContain("Leave type not found");
  });
});

describe("PR-56 — remaining branch coverage (hr-shared)", () => {
  // hr-shared.ts:25 — the SECOND guard in parseDay: a string that matches
  // ^\d{4}-\d{2}-\d{2}$ yet still parses to Invalid Date. NOTE: V8 rolls
  // "2026-02-31" over to 2026-03-03 (it is NOT NaN), so the reachable
  // inputs here are out-of-range months, day 00, and day 32+ — those DO
  // produce NaN and must throw rather than flow into day arithmetic.
  it("pins hr-shared.ts:25 — a regex-shaped but calendar-invalid date throws instead of NaN arithmetic", () => {
    expect(() => parseDay("2026-13-01")).toThrow("Invalid date: 2026-13-01");
    expect(() => parseDay("2026-00-10")).toThrow("Invalid date: 2026-00-10");
    expect(() => parseDay("2026-02-32")).toThrow("Invalid date: 2026-02-32");
    expect(() => parseDay("2026-02-00")).toThrow("Invalid date: 2026-02-00");
  });

  // hr-shared.ts:117-122 — getOrCreateBalance loses the unique-trio race on
  // the lazy materialize: PR-22 makes the previously-silent catch LOG the
  // conflict, and the re-read returns the concurrent winner's numbers.
  it("pins hr-shared.ts:121 — a materialize race logs the conflict and re-reads the winner's row", async () => {
    // Both findUnique calls share the same where clause, so the values are
    // sequenced: 1st read finds no row → materialize; the create LOSES the
    // race; 2nd read returns the concurrent winner's row.
    db.leaveBalance.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ entitled: 20, carriedOver: 2, used: 3 });
    db.leaveBalance.create.mockRejectedValueOnce(new Error("P2002 unique constraint failed"));

    const b = await getOrCreateBalance("u-theo", "lt-annual", 2026, ANNUAL_TYPE.policy);
    // The winner's numbers, not the policy default (20/0/0).
    expect(b).toEqual({ entitled: 20, carriedOver: 2, used: 3 });
    expect(db.leaveBalance.create).toHaveBeenCalledTimes(1);
    expect(logErrorSpy).toHaveBeenCalledTimes(1);
    expect(logErrorSpy).toHaveBeenCalledWith(
      "[hr-shared] leave balance materialize raced with a concurrent create:",
      expect.any(Error),
    );
  });

  // hr-shared.ts:161-168 — the batched variant's race catch: createMany
  // rejects (skipDuplicates is unsupported on SQLite), PR-22 logs it, and
  // the retry findMany + fold-in loop recover the winner's rows.
  it("pins hr-shared.ts:162+168 — a batch materialize race logs, re-reads, and folds in the winner's rows", async () => {
    // leaveBalance.findMany serves BOTH the initial batched read (annual +
    // sick) and the post-race retry (sick only) — key the mock on the where
    // clause instead of sequencing.
    db.leaveBalance.findMany.mockImplementation(
      async (args: { where: { leaveTypeId: { in: string[] } } }) => {
        if (args.where.leaveTypeId.in.includes("lt-annual")) {
          // Initial read: only the annual row exists — sick is missing.
          return [{ leaveTypeId: "lt-annual", entitled: 20, carriedOver: 0, used: 0 }];
        }
        // Retry read after the raced createMany: the concurrent winner's row.
        return [{ leaveTypeId: "lt-sick", entitled: 10, carriedOver: 1, used: 2 }];
      },
    );
    db.leaveBalance.createMany.mockRejectedValueOnce(new Error("P2002 unique constraint failed"));

    const balances = await getOrCreateBalancesBatch("u-theo", [
      { id: "lt-annual", policy: ANNUAL_TYPE.policy },
      { id: "lt-sick", policy: { annualDays: 10, maxCarryOver: 0, minNoticeDays: 0, maxConsecutiveDays: 120 } },
    ], 2026);

    // Only the missing type was queued for materialization.
    expect(db.leaveBalance.createMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: [expect.objectContaining({ leaveTypeId: "lt-sick" })] }),
    );
    expect(db.leaveBalance.findMany).toHaveBeenCalledTimes(2); // initial + retry
    expect(logErrorSpy).toHaveBeenCalledTimes(1);
    expect(logErrorSpy).toHaveBeenCalledWith(
      "[hr-shared] balance batch materialize raced with a concurrent create:",
      expect.any(Error),
    );
    // The already-present annual row passes through untouched; the sick row
    // comes from the retry loop (line 168), not the createMany default.
    // (Batch rows keep their leaveTypeId — the fold-in stores the whole row.)
    expect(balances.get("lt-annual")).toMatchObject({ entitled: 20, carriedOver: 0, used: 0 });
    expect(balances.get("lt-sick")).toMatchObject({ entitled: 10, carriedOver: 1, used: 2 });
  });
});

// ---------------------------------------------------------------------------
// F2.4 — leave policy engine (docs/Fernly_Policy_Engine_Design.md §4).
// Floor-aware guards (submission + approval), the include-holiday day count,
// the LV-B07 service gate, and strategy-aware materialization — through the
// actions, with the rules themselves pinned in leave-policy.test.ts.
// ---------------------------------------------------------------------------

describe("F2.4 — advance (negative) leave", () => {
  const ADVANCE_TYPE = {
    ...ANNUAL_TYPE,
    id: "lt-advance",
    name: "Advance Annual",
    policy: {
      ...ANNUAL_TYPE.policy,
      leaveTypeId: "lt-advance",
      allocationStrategy: "EARNED",
      accrualFrequency: "MONTHLY",
      allowNegative: true,
      negativeFloor: 5,
    },
  };

  it("permits a submission that lands inside the negative floor", async () => {
    db.leaveType.findUnique.mockResolvedValue(ADVANCE_TYPE);
    // 6 available, 8 requested → −2 ≥ −5 → allowed (Org A's June walk).
    db.leaveBalance.findUnique.mockResolvedValue({ entitled: 24, carriedOver: 0, used: 18 });
    const res = await createLeaveRequest({
      leaveTypeId: "lt-advance",
      startDate: "2027-06-07",
      endDate: "2027-06-15", // 8 working days, ≤ 15-day cap, notice fine
      reason: "Advance leave e2e",
    });
    expect(res.ok).toBe(true);
    // Mon 7 → Tue 15 = 7 working days; 6 − 7 = −1 ≥ −5 → allowed.
    expect(db.leaveRequest.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ days: 7, status: "PENDING" }) }),
    );
  });

  it("rejects a submission past the floor and says what the floor is", async () => {
    db.leaveType.findUnique.mockResolvedValue(ADVANCE_TYPE);
    db.leaveBalance.findUnique.mockResolvedValue({ entitled: 24, carriedOver: 0, used: 18 });
    const res = await createLeaveRequest({
      leaveTypeId: "lt-advance",
      startDate: "2027-06-07",
      endDate: "2027-06-18", // 10 working days → −4 < −5? no: 6−10 = −4 ≥ −5 ok. Push further:
      reason: "",
    });
    // 12 working days → 6 − 12 = −6 < −5 → rejected.
    const res2 = await createLeaveRequest({
      leaveTypeId: "lt-advance",
      startDate: "2027-06-07",
      endDate: "2027-06-22",
      reason: "",
    });
    expect(res.ok).toBe(true);
    expect(res2.ok).toBe(false);
    expect(res2.ok === false && res2.error).toMatch(/advance leave is allowed down to −5/i);
    expect(db.leaveRequest.create).toHaveBeenCalledTimes(1);
  });

  it("QA-1 (floor-aware): approves exactly AT the floor, refuses past it", async () => {
    requirePermissionMock.mockResolvedValue(MANAGER_AUTH);
    db.user.findUnique.mockResolvedValue({ managerId: "u-mgr" });
    db.leaveType.findUnique.mockResolvedValue(ADVANCE_TYPE);
    // Available 6 (GRANT 24, CONSUME −18). Requesting 11 → −5 = floor → OK.
    db.leaveRequest.findUnique.mockResolvedValue({ ...PENDING_REQUEST, leaveTypeId: "lt-advance", days: 11 });
    db.leaveLedgerEntry.groupBy.mockResolvedValue([
      { entryType: "GRANT", _sum: { delta: 24 } },
      { entryType: "CONSUME", _sum: { delta: -18 } },
    ]);
    const at = await decideLeaveRequest({ requestId: "lr-1", decision: "APPROVE" });
    expect(at.ok).toBe(true);
    expect(db.leaveLedgerEntry.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ delta: -11, entryType: "CONSUME" }) }),
    );

    // Requesting 11.25 → −5.25 < −5 → refused, nothing written for it.
    db.leaveRequest.updateMany.mockClear();
    db.leaveLedgerEntry.create.mockClear();
    db.leaveRequest.findUnique.mockResolvedValue({ ...PENDING_REQUEST, leaveTypeId: "lt-advance", days: 11.25 });
    db.leaveRequest.updateMany.mockResolvedValue({ count: 1 });
    const past = await decideLeaveRequest({ requestId: "lr-1", decision: "APPROVE" });
    expect(past.ok).toBe(false);
    expect(past.ok === false && past.error).toMatch(/insufficient balance/i);
    expect(db.leaveLedgerEntry.create).not.toHaveBeenCalled();
  });
});

describe("F2.4 — include-holiday day count (countHolidaysInLeave)", () => {
  const COUNTING_TYPE = {
    ...ANNUAL_TYPE,
    id: "lt-counting",
    policy: { ...ANNUAL_TYPE.policy, leaveTypeId: "lt-counting", countHolidaysInLeave: true },
  };

  it("counts a full holiday as a leave day (only half-day entries discount)", async () => {
    requirePermissionMock.mockResolvedValue(MEMBER_AUTH);
    db.leaveType.findUnique.mockResolvedValue(COUNTING_TYPE);
    // 2027-06-07 (Mon) .. 2027-06-09 (Wed): King's Birthday Mon full,
    // Tue half-day holiday. Include-holiday: Mon counts 1, Tue counts 0.5,
    // Wed 1 → 2.5 days (vs 1.5 with the default holiday-aware count).
    db.holidayCalendarEntry.findMany.mockResolvedValue([
      { date: new Date("2027-06-07T00:00:00.000Z"), isHalfDay: false },
      { date: new Date("2027-06-08T00:00:00.000Z"), isHalfDay: true },
    ]);
    const res = await createLeaveRequest({
      leaveTypeId: "lt-counting",
      startDate: "2027-06-07",
      endDate: "2027-06-09",
      reason: "",
    });
    expect(res.ok).toBe(true);
    expect(db.leaveRequest.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ days: 2.5 }) }),
    );
  });
});

describe("F2.4 — LV-B07 service gate (minServiceMonths)", () => {
  const GATED_TYPE = {
    ...ANNUAL_TYPE,
    id: "lt-gated",
    name: "Long Service",
    policy: { ...ANNUAL_TYPE.policy, leaveTypeId: "lt-gated", minServiceMonths: 6 },
  };

  it("rejects a request before N months of service with the months named", async () => {
    requirePermissionMock.mockResolvedValue(MEMBER_AUTH);
    db.leaveType.findUnique.mockResolvedValue(GATED_TYPE);
    db.employeeProfile.findUnique.mockResolvedValue({
      hireDate: new Date("2026-09-15T00:00:00.000Z"),
      employmentStatus: "ACTIVE",
      probationEndsAt: null,
    });
    // Request starts 2027-03-10 → 5 months of service (< 6).
    const res = await createLeaveRequest({
      leaveTypeId: "lt-gated",
      startDate: "2027-03-10",
      endDate: "2027-03-11",
      reason: "",
    });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/6 month\(s\) of service/);
    expect(res.ok === false && res.error).toMatch(/you have 5 so far/i);
    expect(db.leaveRequest.create).not.toHaveBeenCalled();
  });

  it("passes on the N-month mark and when no hire date is on record", async () => {
    requirePermissionMock.mockResolvedValue(MEMBER_AUTH);
    db.leaveType.findUnique.mockResolvedValue(GATED_TYPE);
    db.employeeProfile.findUnique.mockResolvedValue({
      hireDate: new Date("2026-09-15T00:00:00.000Z"),
      employmentStatus: "ACTIVE",
      probationEndsAt: null,
    });
    // On the mark: 2027-03-15 → exactly 6 months.
    const onMark = await createLeaveRequest({
      leaveTypeId: "lt-gated", startDate: "2027-03-15", endDate: "2027-03-16", reason: "",
    });
    expect(onMark.ok).toBe(true);

    // No profile at all — unknown is not ineligible.
    db.employeeProfile.findUnique.mockResolvedValue(null);
    const noFacts = await createLeaveRequest({
      leaveTypeId: "lt-gated", startDate: "2027-03-10", endDate: "2027-03-11", reason: "",
    });
    expect(noFacts.ok).toBe(true);
  });
});

describe("F2.4 — strategy-aware materialization", () => {
  it("materializes an EARNED balance with one GRANT row per due period", async () => {
    // Employee hired 2023 → as of "now" (real clock — the rule's asOf), the
    // current-year periods up to today are due. What matters here: the
    // ledger rows carry PERIOD-KEY sourceIds (not the legacy type id) and
    // the entitled cache equals their sum.
    db.leaveBalance.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(undefined) // re-read after the (mocked) race-free create
      .mockResolvedValueOnce(null);
    const EARNED_POLICY = {
      ...ANNUAL_TYPE.policy,
      allocationStrategy: "EARNED",
      accrualFrequency: "MONTHLY",
      annualDays: 24,
    };
    db.employeeProfile.findUnique.mockResolvedValue({
      hireDate: new Date("2023-03-15T00:00:00.000Z"),
      employmentStatus: "ACTIVE",
      probationEndsAt: null,
    });

    const b = await getOrCreateBalance("u-theo", "lt-earned", new Date().getUTCFullYear(), EARNED_POLICY);
    // The mock never persists the row, so the fallback is the ops sum —
    // which proves the strategy granted (12 × 2 only in December; earlier
    // otherwise). Assert the ledger shape instead of the exact count.
    expect(b.entitled).toBeGreaterThanOrEqual(2);
    expect(b.entitled % 2).toBe(0); // whole months of 2 days
    expect(db.leaveLedgerEntry.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.arrayContaining([
          expect.objectContaining({ entryType: "GRANT", sourceType: "POLICY", sourceId: expect.stringMatching(/^\d{4}-\d{2}$/) }),
        ]),
      }),
    );
  });

  it("keeps the legacy single-grant shape for MANUAL types", async () => {
    db.leaveBalance.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ entitled: 20, carriedOver: 0, used: 0 });
    await getOrCreateBalance("u-theo", "lt-annual", 2026, ANNUAL_TYPE.policy);
    expect(db.leaveLedgerEntry.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ delta: 20, entryType: "GRANT", sourceType: "POLICY", sourceId: "lt-annual" }),
      }),
    );
    expect(db.leaveLedgerEntry.createMany).not.toHaveBeenCalled();
  });
});
