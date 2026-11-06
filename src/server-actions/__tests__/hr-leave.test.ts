import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// HR module — leave management server action tests (docs/HR_MODULE_PLAN.md §4).
// Full rule matrix: request validation (policy rails, overlap, balance),
// decide (chain-scoped approver, transactional balance), cancel (restore).
// ---------------------------------------------------------------------------

const db = vi.hoisted(() => {
  const models = [
    "leaveRequest", "leaveType", "leavePolicy", "leaveBalance",
    "user", "auditLog", "notification", "holidayCalendarEntry",
    "attendanceRecord",
  ];
  const methods = [
    "findMany", "findUnique", "findFirst", "create", "createMany", "update",
    "updateMany", "delete", "deleteMany", "upsert", "count", "aggregate",
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
} from "../hr-leave";
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
});

describe("getOrCreateBalance", () => {
  it("returns the existing row untouched", async () => {
    db.leaveBalance.findUnique.mockResolvedValue({ entitled: 20, carriedOver: 2, used: 3 });
    const b = await getOrCreateBalance("u-theo", "lt-annual", 2026, 20);
    expect(b).toEqual({ entitled: 20, carriedOver: 2, used: 3 });
    expect(db.leaveBalance.create).not.toHaveBeenCalled();
  });
  it("materializes the entitlement when no row exists", async () => {
    db.leaveBalance.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ entitled: 20, carriedOver: 0, used: 0 });
    const b = await getOrCreateBalance("u-theo", "lt-annual", 2026, 20);
    expect(db.leaveBalance.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ entitled: 20, year: 2026 }) }),
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
    const res = await createLeaveRequest({ leaveTypeId: "lt-annual", startDate: isoDay(7), endDate: isoDay(8) });
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
  it("approves: flips status and increments used inside a transaction", async () => {
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
    // The transaction aborted before the debit — used was never incremented.
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
    // Entitled 20, 15 already used by a previously approved request → 5 left.
    db.leaveBalance.findUnique.mockResolvedValue({ entitled: 20, carriedOver: 0, used: 15 });

    const res = await decideLeaveRequest({ requestId: "lr-1", decision: "APPROVE" });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/insufficient balance/i);
    expect(res.ok === false && res.error).toMatch(/5 day/i);
    // Neither the balance nor the request may change on the refused path —
    // the guarded flip inside the transaction is rolled back with it
    // (QA-16), so no debit ever lands.
    expect(db.leaveBalance.update).not.toHaveBeenCalled();
  });

  it("QA-1: approves exactly at the remaining balance (boundary is inclusive)", async () => {
    requirePermissionMock.mockResolvedValue(MANAGER_AUTH);
    db.leaveRequest.findUnique.mockResolvedValue({ ...PENDING_REQUEST, days: 5 });
    db.user.findUnique.mockResolvedValue({ managerId: "u-mgr" });
    db.leaveBalance.findUnique.mockResolvedValue({ entitled: 20, carriedOver: 0, used: 15 });

    const res = await decideLeaveRequest({ requestId: "lr-1", decision: "APPROVE" });
    expect(res.ok).toBe(true);
    expect(db.leaveBalance.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { used: { increment: 5 } } }),
    );
  });

  it("QA-1: materializes a missing balance row inside the transaction before debiting", async () => {
    requirePermissionMock.mockResolvedValue(MANAGER_AUTH);
    db.leaveRequest.findUnique.mockResolvedValue(PENDING_REQUEST);
    db.user.findUnique.mockResolvedValue({ managerId: "u-mgr" });
    db.leaveBalance.findUnique.mockResolvedValue(null); // never materialized
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

  it("cancelling an APPROVED request restores the balance", async () => {
    requirePermissionMock.mockResolvedValue(MEMBER_AUTH);
    db.leaveRequest.findUnique.mockResolvedValue({ ...PENDING_REQUEST, status: "APPROVED" });
    db.leaveBalance.findUnique.mockResolvedValue({ entitled: 20, carriedOver: 0, used: 2 });
    const res = await cancelLeaveRequest({ requestId: "lr-1" });
    expect(res.ok).toBe(true);
    // Atomic decrement (QA-1b) — the restore mirrors the approve increment.
    expect(db.leaveBalance.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { used: { decrement: 2 } } }),
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
    const res = await cancelLeaveRequest({ requestId: "lr-1" });
    expect(res.ok).toBe(true);
    expect(db.leaveBalance.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { used: { decrement: 1 } } }),
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
          policy: { create: { annualDays: 10, maxCarryOver: 0, minNoticeDays: 14, maxConsecutiveDays: 90 } },
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
        update: { annualDays: 25, maxCarryOver: 5, minNoticeDays: 1, maxConsecutiveDays: 15 },
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

  it("pins hr-leave.ts:428-435 — a unique-trio race on materialize re-reads the winner's balance row", async () => {
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

    const b = await getOrCreateBalance("u-theo", "lt-annual", 2026, 20);
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
      { id: "lt-annual", entitled: 20 },
      { id: "lt-sick", entitled: 10 },
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
