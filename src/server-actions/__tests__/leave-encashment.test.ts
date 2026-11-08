import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// P2 (LV-09, F2.2) — leave encashment action tests.
// docs/Fernly_HR_Payroll_Enhancement_Plan.md §7.2.1 payroll sweep, item 2.
//
// The full rule matrix: request validation (policy knobs against the LEDGER
// projection, locked payout periods), the approval transaction (guarded
// flip, CONSUME ledger row, cache re-sync, the ENCASHMENT PayAdjustment —
// days and money commit together), rejection, and the reads.
// ---------------------------------------------------------------------------

const db = vi.hoisted(() => {
  const models = [
    "leaveEncashment", "payAdjustment", "leaveType", "leavePolicy", "leaveBalance",
    "leaveLedgerEntry", "salaryStructure", "payrollRun",
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

const requirePermissionMock = vi.fn();
vi.mock("@/server-actions/auth-guard", () => ({
  getSession: vi.fn(),
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
  requestLeaveEncashment,
  decideLeaveEncashment,
  getMyEncashments,
  getEncashmentQueue,
} from "../leave-encashment";

const MEMBER_AUTH = { userId: "u-theo", role: "MEMBER" as const, name: "Theo", email: "theo@x.co" };
const ADMIN_AUTH = { userId: "u-admin", role: "ADMIN" as const, name: "Ada", email: "ada@x.co" };
const HR_AUTH = { userId: "u-hr", role: "HR" as const, name: "Remy", email: "remy@x.co" };

const ENCASHABLE_POLICY_ROW = {
  id: "pol-1", leaveTypeId: "lt-annual", annualDays: 20, maxCarryOver: 5,
  minNoticeDays: 1, maxConsecutiveDays: 15,
  allocationStrategy: "MANUAL", accrualFrequency: "MONTHLY", allocateOnDay: "FIRST",
  accrualRounding: "FLOOR_QUARTER", accrualCap: null, grantOn: "PERIOD_START",
  prorateForJoiners: true, minServiceMonths: 0, accrueDuringProbation: true,
  allowNegative: false, negativeFloor: 0, carryExpiresAfterMonths: null,
  countHolidaysInLeave: false,
  encashable: true, maxEncashableDays: 5, nonEncashableDays: 5,
};

const ANNUAL_TYPE = {
  id: "lt-annual", name: "Annual Leave", code: "ANNUAL", color: "#8b5cf6",
  requiresDoc: false, paid: true, active: true,
  policy: ENCASHABLE_POLICY_ROW,
};

const STRUCTURE_ROW = {
  id: "ss-1", userId: "u-theo",
  // 78,000 annual earnings → 6,500 monthly.
  components: JSON.stringify([
    { key: "basic", label: "Basic Salary", kind: "EARNING", mode: "FIXED", amount: 78000 },
  ]),
  notes: "", effectiveFrom: new Date(), isActive: true,
  createdAt: new Date(), updatedAt: new Date(),
};

function projectionGroups(available: number) {
  // GRANT 20 − CONSUME (20 − available) = available.
  return [
    { entryType: "GRANT", _sum: { delta: 20 } },
    { entryType: "CONSUME", _sum: { delta: -(20 - available) } },
  ];
}

function encashmentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "enc-1",
    userId: "u-theo",
    leaveTypeId: "lt-annual",
    year: 2026,
    days: 3,
    status: "PENDING",
    payoutPeriod: "2026-12",
    amount: 0,
    dailyRate: 0,
    reason: "Moving house",
    createdById: "u-theo",
    decidedById: null,
    decidedAt: null,
    decisionNote: "",
    paidRunId: "",
    paidAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  requirePermissionMock.mockResolvedValue(MEMBER_AUTH);
  db.user.findUnique.mockResolvedValue({ id: "u-theo", name: "Theo", managerId: null, role: "MEMBER" });
  db.user.findMany.mockResolvedValue([]);
  db.employeeProfile.findUnique.mockResolvedValue(null);
  db.leaveType.findUnique.mockResolvedValue(ANNUAL_TYPE);
  db.leavePolicy.findUnique.mockResolvedValue(ENCASHABLE_POLICY_ROW);
  db.leaveBalance.findUnique.mockResolvedValue({ id: "lb-1" });
  db.leaveLedgerEntry.groupBy.mockResolvedValue(projectionGroups(20));
  db.leaveLedgerEntry.create.mockResolvedValue({});
  db.leaveBalance.update.mockResolvedValue({});
  db.payrollRun.findUnique.mockResolvedValue(null);
  db.salaryStructure.findFirst.mockResolvedValue(STRUCTURE_ROW);
  db.holidayCalendarEntry.findMany.mockResolvedValue([]);
  db.leaveEncashment.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "enc-new", ...data }));
  db.leaveEncashment.findUnique.mockResolvedValue(encashmentRow());
  db.leaveEncashment.findMany.mockResolvedValue([]);
  db.leaveEncashment.updateMany.mockResolvedValue({ count: 1 });
  db.payAdjustment.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "adj-new", ...data }));
  db.notification.create.mockResolvedValue({});
});

describe("P2 — requestLeaveEncashment", () => {
  it("creates a PENDING request for an encashable type with balance", async () => {
    const res = await requestLeaveEncashment({ leaveTypeId: "lt-annual", days: 3, payoutPeriod: "2026-12", reason: "Moving house" });
    expect(res.ok).toBe(true);
    const createArg = db.leaveEncashment.create.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(createArg.data).toMatchObject({
      userId: "u-theo", leaveTypeId: "lt-annual", days: 3, status: "PENDING",
      payoutPeriod: "2026-12", reason: "Moving house",
    });
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "leave.encashment_requested" }));
  });

  it("refuses a type whose policy is not encashable", async () => {
    db.leaveType.findUnique.mockResolvedValue({
      ...ANNUAL_TYPE,
      policy: { ...ENCASHABLE_POLICY_ROW, encashable: false },
    });
    const res = await requestLeaveEncashment({ leaveTypeId: "lt-annual", days: 3, payoutPeriod: "2026-12" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("not encashable");
    expect(db.leaveEncashment.create).not.toHaveBeenCalled();
  });

  it("refuses days past the balance floor (kernel reason verbatim)", async () => {
    db.leaveLedgerEntry.groupBy.mockResolvedValue(projectionGroups(7));
    const res = await requestLeaveEncashment({ leaveTypeId: "lt-annual", days: 3, payoutPeriod: "2026-12" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("2 day(s) are encashable");
  });

  it("refuses a payout period whose run is already LOCKED", async () => {
    db.payrollRun.findUnique.mockResolvedValue({ status: "LOCKED" });
    const res = await requestLeaveEncashment({ leaveTypeId: "lt-annual", days: 3, payoutPeriod: "2026-10" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("already locked");
  });
});

describe("P2 — decideLeaveEncashment (APPROVE)", () => {
  it("writes the ledger CONSUME row, cache re-sync AND the adapter row in ONE transaction", async () => {
    requirePermissionMock.mockResolvedValue(ADMIN_AUTH);
    const res = await decideLeaveEncashment({ encashmentId: "enc-1", decision: "APPROVE" });
    expect(res.ok).toBe(true);

    // The guarded flip.
    expect(db.leaveEncashment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "enc-1", status: "PENDING" },
        data: expect.objectContaining({ status: "APPROVED", decidedById: "u-admin" }),
      }),
    );
    // The consumption row — append-only, source-linked.
    expect(db.leaveLedgerEntry.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: "u-theo", leaveTypeId: "lt-annual", year: 2026,
          delta: -3, entryType: "CONSUME", sourceType: "LEAVE_ENCASHMENT", sourceId: "enc-1",
        }),
      }),
    );
    // The cache re-sync (absolute, from the projection).
    expect(db.leaveBalance.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId_leaveTypeId_year: { userId: "u-theo", leaveTypeId: "lt-annual", year: 2026 } },
        data: { used: 3 },
      }),
    );
    // The money: the P1 adapter row (same transaction — same mocked db).
    expect(db.payAdjustment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: "u-theo", sourceType: "ENCASHMENT", sourceId: "enc-1",
          side: "EARNING", recurrence: "ONE_SHOT", calcMode: "FIXED",
          period: "2026-12",
        }),
      }),
    );
    // Amount snapshot: 6,500 monthly ÷ 23 working days (Dec 2026) × 3 days.
    const adjArg = db.payAdjustment.create.mock.calls[0][0] as { data: { amount: number; dailyRate?: number } };
    expect(adjArg.data.amount).toBeCloseTo(847.83, 2);
    // The APPROVED row carries the snapshot too.
    const flipArg = db.leaveEncashment.updateMany.mock.calls[0][0] as { data: { amount: number; dailyRate: number } };
    expect(flipArg.data.amount).toBeCloseTo(847.83, 2);
    expect(flipArg.data.dailyRate).toBeCloseTo(282.61, 2);
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "leave.encashment_approved" }));
  });

  it("re-validates against the LIVE ledger inside the transaction (QA-1)", async () => {
    requirePermissionMock.mockResolvedValue(ADMIN_AUTH);
    // The request validated at 20 available; the balance drained to 7 since.
    db.leaveLedgerEntry.groupBy.mockResolvedValue(projectionGroups(7));
    const res = await decideLeaveEncashment({ encashmentId: "enc-1", decision: "APPROVE" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("2 day(s) are encashable");
    expect(db.leaveLedgerEntry.create).not.toHaveBeenCalled();
    expect(db.payAdjustment.create).not.toHaveBeenCalled();
  });

  it("refuses when the payout period locked since submission", async () => {
    requirePermissionMock.mockResolvedValue(ADMIN_AUTH);
    db.payrollRun.findUnique.mockResolvedValue({ status: "LOCKED" });
    const res = await decideLeaveEncashment({ encashmentId: "enc-1", decision: "APPROVE" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("locked since this request");
  });

  it("refuses an employee with no active salary structure (no rate basis)", async () => {
    requirePermissionMock.mockResolvedValue(ADMIN_AUTH);
    db.salaryStructure.findFirst.mockResolvedValue(null);
    const res = await decideLeaveEncashment({ encashmentId: "enc-1", decision: "APPROVE" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("No active salary structure");
  });

  it("HR outside the approver chain is NOT a decider (chain-scoped privacy)", async () => {
    requirePermissionMock.mockResolvedValue(HR_AUTH);
    const res = await decideLeaveEncashment({ encashmentId: "enc-1", decision: "APPROVE" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("manager (or an admin)");
  });

  it("refuses a non-PENDING row (QA-16 surface)", async () => {
    requirePermissionMock.mockResolvedValue(ADMIN_AUTH);
    db.leaveEncashment.findUnique.mockResolvedValue(encashmentRow({ status: "APPROVED" }));
    const res = await decideLeaveEncashment({ encashmentId: "enc-1", decision: "APPROVE" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("already approved");
  });
});

describe("P2 — decideLeaveEncashment (REJECT)", () => {
  it("flips REJECTED with the guarded write and touches no money", async () => {
    requirePermissionMock.mockResolvedValue(ADMIN_AUTH);
    const res = await decideLeaveEncashment({ encashmentId: "enc-1", decision: "REJECT", note: "Not this quarter" });
    expect(res.ok).toBe(true);
    expect(db.leaveEncashment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "enc-1", status: "PENDING" },
        data: expect.objectContaining({ status: "REJECTED", decisionNote: "Not this quarter" }),
      }),
    );
    expect(db.leaveLedgerEntry.create).not.toHaveBeenCalled();
    expect(db.payAdjustment.create).not.toHaveBeenCalled();
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "leave.encashment_rejected" }));
  });
});

describe("P2 — reads", () => {
  it("getMyEncashments serializes the member's own rows with type names", async () => {
    db.leaveEncashment.findMany.mockResolvedValue([encashmentRow()]);
    db.leaveType.findMany.mockResolvedValue([ANNUAL_TYPE]);
    const res = await getMyEncashments();
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data).toHaveLength(1);
      expect(res.data[0]).toMatchObject({
        id: "enc-1", userName: "Theo", typeName: "Annual Leave", status: "PENDING", days: 3,
        payoutPeriod: "2026-12",
      });
    }
  });

  it("getEncashmentQueue scopes MANAGERs to their subtree (hr:view)", async () => {
    requirePermissionMock.mockResolvedValue({ ...ADMIN_AUTH, role: "MANAGER" });
    const hierarchy = await import("@/lib/hierarchy");
    const spy = vi.spyOn(hierarchy, "getSubtreeUserIds").mockResolvedValue(new Set(["u-theo"]));
    db.leaveEncashment.findMany.mockResolvedValue([encashmentRow()]);
    db.leaveType.findMany.mockResolvedValue([ANNUAL_TYPE]);
    const res = await getEncashmentQueue();
    expect(res.ok).toBe(true);
    const where = db.leaveEncashment.findMany.mock.calls[0][0].where;
    expect(where.status).toBe("PENDING");
    expect(where.userId).toMatchObject({ in: ["u-theo"] });
    spy.mockRestore();
  });
});
