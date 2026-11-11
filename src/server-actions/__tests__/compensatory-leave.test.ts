import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// P30 (LV-01/LV-11) — compensatory leave server action tests.
// Full rule matrix: the claim's worked-holiday validation (the kernel's facts
// through the real action), the double-earning overlap guard, the decision's
// guarded flips, the approve transaction's GRANT ledger row + cache sync
// (re-validating the facts INSIDE the transaction — the QA-1 discipline),
// and the two queue surfaces' scoping.
// ---------------------------------------------------------------------------

const db = vi.hoisted(() => {
  const models = [
    "compensatoryLeaveRequest", "leaveType", "leavePolicy", "leaveBalance",
    "leaveLedgerEntry", "leaveRequest",
    "user", "auditLog", "notification", "holidayCalendarEntry",
    "attendanceRecord", "employeeProfile", "leavePeriod",
    "leavePolicySet", "leavePolicySetItem", "leavePolicyAssignment",
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

const requirePermissionMock = vi.fn();
vi.mock("@/server-actions/auth-guard", () => ({
  getSession: () => vi.fn(),
  requirePermission: (...a: unknown[]) => requirePermissionMock(...a),
  AuthorizationError: class AuthorizationError extends Error {
    readonly digest = "AuthorizationError";
    constructor(m: string) { super(m); this.name = "AuthorizationError"; }
  },
}));

const logAuditMock = vi.fn();
vi.mock("@/server-actions/shared", () => ({
  logAudit: (...a: unknown[]) => logAuditMock(...a),
  queueOutboxMail: vi.fn(),
  deliverOutboxMail: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import {
  createCompensatoryLeaveRequest,
  decideCompensatoryLeaveRequest,
  getMyCompensatoryRequests,
  getCompensatoryQueue,
} from "../compensatory-leave";

const ADMIN_AUTH = { userId: "u-admin", role: "ADMIN" as const, name: "Ada", email: "ada@x.co" };
const MEMBER_AUTH = { userId: "u-yuki", role: "MEMBER" as const, name: "Yuki", email: "yuki@x.co" };

const COMP_TYPE = {
  id: "lt-comp",
  name: "Comp Off",
  code: "COMP_OFF",
  color: "#84cc16",
  requiresDoc: false,
  paid: true,
  active: true,
  isCompensatory: true,
  policy: { id: "lp-comp", leaveTypeId: "lt-comp", annualDays: 0, maxCarryOver: 0, minNoticeDays: 0, maxConsecutiveDays: 10 },
};

const PLAIN_TYPE = {
  id: "lt-annual",
  name: "Annual Leave",
  code: "ANNUAL",
  color: "#8b5cf6",
  requiresDoc: false,
  paid: true,
  active: true,
  isCompensatory: false,
  policy: { id: "lp-1", leaveTypeId: "lt-annual", annualDays: 20, maxCarryOver: 5, minNoticeDays: 1, maxConsecutiveDays: 15 },
};

/** The most recent Saturday (a worked-holiday weekend day), as a day key. */
function lastSaturday(): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  const offset = (d.getUTCDay() + 1) % 7; // 0 when today IS Saturday
  d.setUTCDate(d.getUTCDate() - offset);
  return d.toISOString().slice(0, 10);
}

function toUtcDate(key: string): Date {
  return new Date(`${key}T00:00:00.000Z`);
}

const SAT = lastSaturday();

beforeEach(() => {
  vi.clearAllMocks();
  requirePermissionMock.mockResolvedValue(MEMBER_AUTH);
  db.leaveType.findUnique.mockResolvedValue(COMP_TYPE);
  db.employeeProfile.findUnique.mockResolvedValue(null);
  // The worked Saturday: PRESENT attendance + no holiday entry (a weekend).
  db.attendanceRecord.findMany.mockResolvedValue([
    { date: toUtcDate(SAT), status: "PRESENT" },
  ]);
  db.holidayCalendarEntry.findMany.mockResolvedValue([]);
  // No overlapping ACTIVE comp claims by default.
  db.compensatoryLeaveRequest.findFirst.mockResolvedValue(null);
  db.compensatoryLeaveRequest.create.mockResolvedValue({ id: "cr-1" });
  db.compensatoryLeaveRequest.findMany.mockResolvedValue([]);
  db.compensatoryLeaveRequest.findUnique.mockResolvedValue(null);
  db.compensatoryLeaveRequest.updateMany.mockResolvedValue({ count: 1 });
  // The approve-path materializer: the balance row EXISTS (no materialize
  // write), the ledger has the comp GRANT after the write (projection via
  // groupBy — default: empty ledger, then the GRANT group below).
  db.leaveBalance.findUnique.mockResolvedValue({ id: "lb-1" });
  db.leaveBalance.update.mockResolvedValue({});
  db.leaveLedgerEntry.groupBy.mockResolvedValue([{ entryType: "GRANT", _sum: { delta: 1 } }]);
  db.leaveLedgerEntry.create.mockResolvedValue({ id: "lle-1" });
  db.leavePolicy.findUnique.mockResolvedValue(COMP_TYPE.policy);
  db.leavePeriod.findMany.mockResolvedValue([]);
  db.leavePolicyAssignment.findMany.mockResolvedValue([]);
  db.user.findUnique.mockResolvedValue(null);
  db.user.findMany.mockResolvedValue([]);
  db.notification.create.mockResolvedValue({});
});

describe("createCompensatoryLeaveRequest", () => {
  it("files a valid worked-Saturday claim (days 1, PENDING)", async () => {
    const res = await createCompensatoryLeaveRequest({
      leaveTypeId: "lt-comp",
      workFromDate: SAT,
      workToDate: SAT,
      reason: "deploy support",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.days).toBe(1);
    expect(db.compensatoryLeaveRequest.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: "u-yuki",
        leaveTypeId: "lt-comp",
        days: 1,
        status: "PENDING",
      }),
    });
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "leave.comp_requested" }));
  });

  it("refuses a non-compensatory type", async () => {
    db.leaveType.findUnique.mockResolvedValue(PLAIN_TYPE);
    const res = await createCompensatoryLeaveRequest({
      leaveTypeId: "lt-annual", workFromDate: SAT, workToDate: SAT,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("not a compensatory type");
  });

  it("refuses an unmarked day (no attendance row)", async () => {
    db.attendanceRecord.findMany.mockResolvedValue([]);
    const res = await createCompensatoryLeaveRequest({
      leaveTypeId: "lt-comp", workFromDate: SAT, workToDate: SAT,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("no attendance marked");
  });

  it("refuses a working day inside the span", async () => {
    // The Friday before the Saturday (a working day).
    const friday = new Date(toUtcDate(SAT).getTime() - 86_400_000).toISOString().slice(0, 10);
    const res = await createCompensatoryLeaveRequest({
      leaveTypeId: "lt-comp", workFromDate: friday, workToDate: SAT,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("is a working day");
  });

  it("refuses a future worked-to date (claims cover worked days)", async () => {
    const future = new Date(Date.UTC(2100, 0, 1)).toISOString().slice(0, 10);
    const res = await createCompensatoryLeaveRequest({
      leaveTypeId: "lt-comp", workFromDate: future, workToDate: future,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("can't be in the future");
  });

  it("refuses a second claim covering the same worked day (double-earning guard)", async () => {
    db.compensatoryLeaveRequest.findFirst.mockResolvedValue({
      id: "cr-old",
      workFromDate: toUtcDate(SAT),
      workToDate: toUtcDate(SAT),
    });
    const res = await createCompensatoryLeaveRequest({
      leaveTypeId: "lt-comp", workFromDate: SAT, workToDate: SAT,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("each worked day earns comp once");
  });

  it("earns half a day for a HALF_DAY attendance mark", async () => {
    db.attendanceRecord.findMany.mockResolvedValue([
      { date: toUtcDate(SAT), status: "HALF_DAY" },
    ]);
    const res = await createCompensatoryLeaveRequest({
      leaveTypeId: "lt-comp", workFromDate: SAT, workToDate: SAT,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.days).toBe(0.5);
  });
});

describe("decideCompensatoryLeaveRequest", () => {
  const CLAIM = {
    id: "cr-1",
    userId: "u-yuki",
    leaveTypeId: "lt-comp",
    workFromDate: toUtcDate(SAT),
    workToDate: toUtcDate(SAT),
    days: 1,
    reason: "deploy support",
    status: "PENDING",
    decidedById: null,
    decidedAt: null,
    decisionNote: "",
    createdAt: new Date(),
  };

  beforeEach(() => {
    requirePermissionMock.mockResolvedValue(ADMIN_AUTH);
    db.compensatoryLeaveRequest.findUnique.mockResolvedValue(CLAIM);
    db.user.findUnique.mockResolvedValue({ name: "Yuki" });
  });

  it("reject flips the row through the guarded updateMany", async () => {
    const res = await decideCompensatoryLeaveRequest({ compId: "cr-1", decision: "REJECT", note: "nope" });
    expect(res.ok).toBe(true);
    expect(db.compensatoryLeaveRequest.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "cr-1", status: "PENDING" } }),
    );
    expect(db.leaveLedgerEntry.create).not.toHaveBeenCalled();
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "leave.comp_rejected" }));
  });

  it("approve writes the comp GRANT ledger row and re-syncs the cache in ONE transaction", async () => {
    const res = await decideCompensatoryLeaveRequest({ compId: "cr-1", decision: "APPROVE" });
    expect(res.ok).toBe(true);
    expect(db.$transaction).toHaveBeenCalled();
    expect(db.leaveLedgerEntry.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: "u-yuki",
        leaveTypeId: "lt-comp",
        entryType: "GRANT",
        delta: 1,
        sourceType: "COMP_REQUEST",
        sourceId: "cr-1",
      }),
    });
    // Cache sync — absolute set from the post-grant projection.
    expect(db.leaveBalance.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId_leaveTypeId_year: { userId: "u-yuki", leaveTypeId: "lt-comp", year: new Date().getUTCFullYear() } },
        data: expect.objectContaining({ entitled: 1 }),
      }),
    );
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "leave.comp_approved" }));
  });

  it("approve re-validates the facts INSIDE the transaction (QA-1: attendance un-marked since submission)", async () => {
    // Inside the transaction the attendance read comes back EMPTY — the day
    // is no longer marked worked, so the approval refuses without writing.
    db.attendanceRecord.findMany.mockResolvedValue([]);
    const res = await decideCompensatoryLeaveRequest({ compId: "cr-1", decision: "APPROVE" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("no longer checks out");
    expect(db.leaveLedgerEntry.create).not.toHaveBeenCalled();
  });

  it("approve refuses when attendance changed the priced days since submission", async () => {
    db.attendanceRecord.findMany.mockResolvedValue([
      { date: toUtcDate(SAT), status: "HALF_DAY" },
    ]);
    const res = await decideCompensatoryLeaveRequest({ compId: "cr-1", decision: "APPROVE" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("now prices 0.5");
  });

  it("approve refuses a lost race (already decided elsewhere)", async () => {
    db.compensatoryLeaveRequest.updateMany.mockResolvedValue({ count: 0 });
    const res = await decideCompensatoryLeaveRequest({ compId: "cr-1", decision: "APPROVE" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("no longer pending");
    expect(db.leaveLedgerEntry.create).not.toHaveBeenCalled();
  });

  it("approve refuses a non-pending claim", async () => {
    db.compensatoryLeaveRequest.findUnique.mockResolvedValue({ ...CLAIM, status: "APPROVED" });
    const res = await decideCompensatoryLeaveRequest({ compId: "cr-1", decision: "APPROVE" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("already approved");
  });
});

describe("the read surfaces", () => {
  it("getMyCompensatoryRequests returns the member's serialized claims", async () => {
    requirePermissionMock.mockResolvedValue(MEMBER_AUTH);
    db.compensatoryLeaveRequest.findMany.mockResolvedValue([
      {
        id: "cr-1", userId: "u-yuki", leaveTypeId: "lt-comp",
        workFromDate: toUtcDate(SAT), workToDate: toUtcDate(SAT),
        days: 1, reason: "deploy", status: "APPROVED",
        decidedById: "u-admin", decidedAt: new Date(), decisionNote: "ty",
        createdAt: new Date(),
      },
    ]);
    db.leaveType.findMany.mockResolvedValue([COMP_TYPE]);
    const res = await getMyCompensatoryRequests();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toHaveLength(1);
    expect(res.data[0].typeName).toBe("Comp Off");
    expect(res.data[0].status).toBe("APPROVED");
  });

  it("getCompensatoryQueue scopes a MANAGER to their subtree", async () => {
    requirePermissionMock.mockResolvedValue({ ...ADMIN_AUTH, role: "MANAGER", userId: "u-mgr" });
    const hierarchy = await import("@/lib/hierarchy");
    const spy = vi.spyOn(hierarchy, "getSubtreeUserIds").mockResolvedValue(new Set(["u-yuki"]));
    db.compensatoryLeaveRequest.findMany.mockResolvedValue([]);
    const res = await getCompensatoryQueue();
    expect(res.ok).toBe(true);
    const where = db.compensatoryLeaveRequest.findMany.mock.calls[0][0].where;
    expect(where.status).toBe("PENDING");
    expect(where.userId).toMatchObject({ in: ["u-yuki"] });
    spy.mockRestore();
  });
});
