import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// HR module — leave management server action tests (docs/HR_MODULE_PLAN.md §4).
// Full rule matrix: request validation (policy rails, overlap, balance),
// decide (chain-scoped approver, transactional balance), cancel (restore).
// ---------------------------------------------------------------------------

const db = vi.hoisted(() => {
  const models = [
    "leaveRequest", "leaveType", "leavePolicy", "leaveBalance",
    "user", "auditLog", "notification",
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
  db.leaveBalance.create.mockResolvedValue({});
  db.leaveBalance.update.mockResolvedValue({});
  db.user.findUnique.mockResolvedValue(null);
  db.user.findMany.mockResolvedValue([]);
  db.notification.create.mockResolvedValue({});
  db.notification.createMany.mockResolvedValue({ count: 0 });
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
    const res = await createLeaveRequest({ leaveTypeId: "lt-annual", startDate: isoDay(1), endDate: isoDay(2) });
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
    expect(db.leaveRequest.update).toHaveBeenCalledWith(
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
    expect(db.leaveRequest.update).toHaveBeenCalledWith(
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
    // Neither the balance nor the request may change on the refused path.
    expect(db.leaveBalance.update).not.toHaveBeenCalled();
    expect(db.leaveRequest.update).not.toHaveBeenCalled();
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
    expect(db.leaveRequest.update).toHaveBeenCalledWith(
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
});

// ---------------------------------------------------------------------------
// Read actions
// ---------------------------------------------------------------------------

describe("getMyLeaveData", () => {
  it("returns balances lazily materialized from policy entitlements", async () => {
    requirePermissionMock.mockResolvedValue(MEMBER_AUTH);
    db.leaveType.findMany.mockResolvedValue([ANNUAL_TYPE]);
    db.leaveRequest.findMany.mockResolvedValue([]);
    db.leaveBalance.findUnique.mockResolvedValue(null);
    db.leaveBalance.create.mockResolvedValue({});
    const res = await getMyLeaveData();
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.balances).toHaveLength(1);
      expect(res.data.balances[0]).toMatchObject({ typeName: "Annual Leave", available: 20 });
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
    db.leaveBalance.findUnique.mockResolvedValue({ entitled: 20, carriedOver: 0, used: 0 });
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
    db.leaveBalance.findUnique.mockResolvedValue({ entitled: 20, carriedOver: 0, used: 0 });
    const res = await getMyLeaveData();
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.requests[0].decidedBy).toBe("Ingrid");
      expect(res.data.requests[0].decisionNote).toBe("No");
    }
  });
});
