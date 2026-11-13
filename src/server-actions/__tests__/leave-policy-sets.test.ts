import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// P28 (LV-02/LV-03) — the policy set master + bulk assignment's action
// tests: the RBAC gate (hr:admin), the pure-kernel refusals surfacing as
// friendly errors, the DB guards (duplicate name, item freeze once granted,
// delete-with-references), the bulk tool's per-employee isolation (overlap
// failures named, honest counts, the loud all-fail refusal), the eager
// materialization ONLY for a started window (the future-window doc-alone
// discipline), and the audit rows. The KERNEL's own matrix lives in
// leave-policy-set.test.ts.
// ---------------------------------------------------------------------------

const db = vi.hoisted(() => {
  const models = [
    "leavePolicySet",
    "leavePolicySetItem",
    "leavePolicyAssignment",
    "leaveType",
    "user",
    "employeeProfile",
    "leaveLedgerEntry",
    "leaveBalance",
  ];
  const methods = ["findMany", "findUnique", "findFirst", "create", "update", "delete", "deleteMany", "createMany", "count", "groupBy", "upsert"];
  const obj: Record<string, Record<string, ReturnType<typeof vi.fn>>> = {};
  for (const m of models) {
    obj[m] = {};
    for (const meth of methods) obj[m][meth] = vi.fn();
  }
  (obj as Record<string, unknown>).$transaction = vi.fn();
  return obj;
});

vi.mock("@/lib/infra/db", () => ({ db }));

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

// The engine seam: the tx-scoped materializer + the period loader, mocked
// so the bulk tool's materialization calls are assertable (the real
// materializer's own matrix lives in the hr-leave suites).
const materializeLeaveBalanceTxMock = vi.fn();
const loadLeavePeriodsMock = vi.fn();
vi.mock("@/server-actions/hr-shared", () => ({
  materializeLeaveBalanceTx: (...a: unknown[]) => materializeLeaveBalanceTxMock(...a),
  loadLeavePeriods: () => loadLeavePeriodsMock(),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import {
  listLeavePolicyState,
  createLeavePolicySet,
  updateLeavePolicySet,
  deleteLeavePolicySet,
  bulkAssignLeavePolicySet,
  deleteLeavePolicyAssignment,
} from "../leave-policy-sets";

const ADMIN_AUTH = { userId: "u-admin", role: "ADMIN" as const, name: "Ada", email: "ada@x.co" };

const CURRENT_YEAR = Number(new Date().toISOString().slice(0, 4));
const FUTURE_YEAR = CURRENT_YEAR + 5;

const ITEMS = [
  { leaveTypeId: "t-annual", annualDays: 25 },
  { leaveTypeId: "t-sick", annualDays: 8 },
];

beforeEach(() => {
  vi.clearAllMocks();
  requirePermissionMock.mockResolvedValue(ADMIN_AUTH);
  loadLeavePeriodsMock.mockResolvedValue([]);
  // $transaction runs the callback with db itself as the tx client.
  (db.$transaction as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    async (cb: (tx: unknown) => Promise<unknown>) => cb(db),
  );
  db.leavePolicySet.findMany.mockResolvedValue([]);
  db.leavePolicySetItem.findMany.mockResolvedValue([]);
  db.leavePolicyAssignment.findMany.mockResolvedValue([]);
  db.leavePolicyAssignment.count.mockResolvedValue(0);
  db.leavePolicySet.findUnique.mockResolvedValue(null);
  db.leavePolicySet.create.mockImplementation(async (args: { data: Record<string, unknown> }) => ({
    id: "s-new",
    ...args.data,
  }));
  db.leavePolicySet.update.mockResolvedValue({ id: "s-1" });
  db.leavePolicySetItem.createMany.mockResolvedValue({ count: 2 });
  db.leavePolicySetItem.deleteMany.mockResolvedValue({ count: 2 });
  db.leavePolicyAssignment.findUnique.mockResolvedValue(null);
  db.leavePolicyAssignment.create.mockImplementation(async (args: { data: Record<string, unknown> }) => ({
    id: "a-new",
    ...args.data,
  }));
  db.leavePolicyAssignment.delete.mockResolvedValue({ id: "a-1" });
  db.leaveType.findMany.mockResolvedValue([
    { id: "t-annual", name: "Annual Leave" },
    { id: "t-sick", name: "Sick Leave" },
  ]);
  db.user.findMany.mockResolvedValue([
    { id: "u-admin", name: "Ada" },
    { id: "u-yuki", name: "Yuki Tanaka" },
    { id: "u-hana", name: "Hana Kim" },
  ]);
  db.employeeProfile.findMany.mockResolvedValue([
    { userId: "u-yuki", hireDate: new Date(`${CURRENT_YEAR - 2}-03-15T00:00:00Z`), employmentStatus: "ACTIVE" },
    { userId: "u-hana", hireDate: new Date(`${CURRENT_YEAR}-07-02T00:00:00Z`), employmentStatus: "PROBATION" },
  ]);
  db.leaveLedgerEntry.groupBy.mockResolvedValue([]);
  db.leaveBalance.deleteMany.mockResolvedValue({ count: 0 });
  materializeLeaveBalanceTxMock.mockResolvedValue({ materialized: true });
});

describe("listLeavePolicyState", () => {
  it("is hr:admin-gated (a MANAGER is refused)", async () => {
    requirePermissionMock.mockRejectedValueOnce(new Error("Forbidden"));
    const res = await listLeavePolicyState();
    expect(res.ok).toBe(false);
  });

  it("maps sets, assignments and the granted badge from one compound groupBy", async () => {
    db.leavePolicySet.findMany.mockResolvedValue([
      { id: "s-1", name: "Standard 2027", description: "", active: true, createdAt: new Date() },
    ]);
    db.leavePolicySetItem.findMany.mockResolvedValue([
      { id: "i-1", setId: "s-1", leaveTypeId: "t-annual", annualDays: 25, createdAt: new Date(1) },
      { id: "i-2", setId: "s-1", leaveTypeId: "t-sick", annualDays: 8, createdAt: new Date(2) },
    ]);
    db.leavePolicyAssignment.findMany.mockResolvedValue([
      {
        id: "a-1",
        userId: "u-yuki",
        setId: "s-1",
        bucketYear: FUTURE_YEAR,
        periodId: "",
        assignedAt: new Date("2026-11-01T00:00:00Z"),
        assignedById: "u-admin",
      },
    ]);
    db.leaveLedgerEntry.groupBy.mockResolvedValue([
      // The Annual Leave pair has rows; Sick does not → granted = true.
      { userId: "u-yuki", year: FUTURE_YEAR, leaveTypeId: "t-annual", _count: { id: 1 } },
    ]);
    const res = await listLeavePolicyState();
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.sets).toHaveLength(1);
      expect(res.data.sets[0].items.map((i) => `${i.typeName} ${i.annualDays}`)).toEqual([
        "Annual Leave 25",
        "Sick Leave 8",
      ]);
      expect(res.data.sets[0].assignmentCount).toBe(1);
      expect(res.data.assignments[0]).toMatchObject({
        userName: "Yuki Tanaka",
        setName: "Standard 2027",
        bucketYear: FUTURE_YEAR,
        periodName: null,
        granted: true,
      });
      // No periods → the implicit calendar-year buckets (this year + 2).
      expect(res.data.buckets.map((b) => b.bucketYear)).toEqual([CURRENT_YEAR, CURRENT_YEAR + 1, CURRENT_YEAR + 2]);
      expect(res.data.employees.find((e) => e.userId === "u-hana")?.hireDate).toBe(`${CURRENT_YEAR}-07-02`);
    }
  });
});

describe("createLeavePolicySet", () => {
  it("creates the set + its items in one transaction, audited", async () => {
    const res = await createLeavePolicySet({ name: "Standard 2027", description: "", items: ITEMS });
    expect(res.ok).toBe(true);
    expect(db.leavePolicySet.create).toHaveBeenCalledWith({
      data: { name: "Standard 2027", description: "" },
    });
    expect(db.leavePolicySetItem.createMany).toHaveBeenCalledWith({
      data: [
        { setId: "s-new", leaveTypeId: "t-annual", annualDays: 25 },
        { setId: "s-new", leaveTypeId: "t-sick", annualDays: 8 },
      ],
    });
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "leave.policy_set_created", entityLabel: "Standard 2027" }),
    );
  });

  it("refuses a duplicate name ahead of the unique index", async () => {
    db.leavePolicySet.findUnique.mockResolvedValue({ id: "s-existing" });
    const res = await createLeavePolicySet({ name: "Standard 2027", description: "", items: ITEMS });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("already exists");
  });

  it("refuses a type id that no longer exists (loud, not silent)", async () => {
    db.leaveType.findMany.mockResolvedValue([{ id: "t-annual", name: "Annual Leave" }]); // one of two
    const res = await createLeavePolicySet({ name: "Standard 2027", description: "", items: ITEMS });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("no longer exists");
  });

  it("surfaces the pure kernel's refusal (duplicate type in set)", async () => {
    const res = await createLeavePolicySet({
      name: "Bad",
      description: "",
      items: [
        { leaveTypeId: "t-annual", annualDays: 1 },
        { leaveTypeId: "t-annual", annualDays: 2 },
      ],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("twice");
  });
});

describe("updateLeavePolicySet", () => {
  const EXISTING = { id: "s-1", name: "Standard 2027", description: "", active: true };

  /** findUnique as the action sees it: the id probe returns the set, the
 * duplicate-name probe returns null. */
  function mockFindUnique() {
    db.leavePolicySet.findUnique.mockImplementation(
      async (args: { where: { id?: string; name?: string } }) => {
        if (args.where.id === "s-1") return EXISTING;
        return null;
      },
    );
  }

  it("a metadata-only edit (same items) never rewrites the items", async () => {
    mockFindUnique();
    db.leavePolicySetItem.findMany.mockResolvedValue(ITEMS.map((i) => ({ setId: "s-1", ...i })));
    const res = await updateLeavePolicySet({
      id: "s-1",
      name: "Standard 2027 (renamed)",
      description: "x",
      active: true,
      items: ITEMS,
    });
    expect(res.ok).toBe(true);
    expect(db.leavePolicySetItem.deleteMany).not.toHaveBeenCalled();
    expect(db.leavePolicySet.update).toHaveBeenCalledWith({
      where: { id: "s-1" },
      data: { name: "Standard 2027 (renamed)", description: "x", active: true },
    });
  });

  it("an item edit is REFUSED once a referencing assignment has granted", async () => {
    mockFindUnique();
    db.leavePolicySetItem.findMany.mockResolvedValue([{ setId: "s-1", leaveTypeId: "t-annual", annualDays: 25 }]);
    db.leavePolicyAssignment.findMany.mockResolvedValue([
      { userId: "u-yuki", bucketYear: FUTURE_YEAR, setId: "s-1" },
    ]);
    db.leaveLedgerEntry.groupBy.mockResolvedValue([
      { userId: "u-yuki", year: FUTURE_YEAR, leaveTypeId: "t-annual", _count: { id: 1 } },
    ]);
    const res = await updateLeavePolicySet({
      id: "s-1",
      name: "Standard 2027",
      description: "",
      active: true,
      items: [{ leaveTypeId: "t-annual", annualDays: 30 }],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("frozen");
  });

  it("an item edit BEFORE anything grants rewrites the items (fix-ahead-of-the-window)", async () => {
    mockFindUnique();
    db.leavePolicySetItem.findMany.mockResolvedValue(ITEMS.map((i) => ({ setId: "s-1", ...i })));
    db.leavePolicyAssignment.findMany.mockResolvedValue([
      { userId: "u-yuki", bucketYear: FUTURE_YEAR, setId: "s-1" },
    ]);
    db.leaveLedgerEntry.groupBy.mockResolvedValue([]); // nothing granted
    const res = await updateLeavePolicySet({
      id: "s-1",
      name: "Standard 2027",
      description: "",
      active: true,
      items: [
        { leaveTypeId: "t-annual", annualDays: 30 },
        { leaveTypeId: "t-sick", annualDays: 9 },
      ],
    });
    expect(res.ok).toBe(true);
    expect(db.leavePolicySetItem.deleteMany).toHaveBeenCalledWith({ where: { setId: "s-1" } });
    expect(db.leavePolicySetItem.createMany).toHaveBeenCalledWith({
      data: [
        { setId: "s-1", leaveTypeId: "t-annual", annualDays: 30 },
        { setId: "s-1", leaveTypeId: "t-sick", annualDays: 9 },
      ],
    });
  });
});

describe("deleteLeavePolicySet", () => {
  it("refuses while assignments reference the set", async () => {
    db.leavePolicySet.findUnique.mockResolvedValue({ id: "s-1", name: "Standard 2027" });
    db.leavePolicyAssignment.count.mockResolvedValue(3);
    const res = await deleteLeavePolicySet({ id: "s-1" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("3 assignment(s)");
    expect(db.leavePolicySet.delete).not.toHaveBeenCalled();
  });

  it("deletes the items + the set in one transaction when clean", async () => {
    db.leavePolicySet.findUnique.mockResolvedValue({ id: "s-1", name: "Standard 2027" });
    const res = await deleteLeavePolicySet({ id: "s-1" });
    expect(res.ok).toBe(true);
    expect(db.leavePolicySetItem.deleteMany).toHaveBeenCalledWith({ where: { setId: "s-1" } });
    expect(db.leavePolicySet.delete).toHaveBeenCalledWith({ where: { id: "s-1" } });
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "leave.policy_set_deleted" }),
    );
  });
});

describe("bulkAssignLeavePolicySet", () => {
  beforeEach(() => {
    db.leavePolicySet.findUnique.mockResolvedValue({
      id: "s-1",
      name: "Standard 2027",
      description: "",
      active: true,
    });
    db.leavePolicySetItem.findMany.mockResolvedValue(
      ITEMS.map((i) => ({ id: `i-${i.leaveTypeId}`, setId: "s-1", ...i })),
    );
  });

  it("assigns a FUTURE window as the doc alone — no materialization, honest counts", async () => {
    const res = await bulkAssignLeavePolicySet({
      setId: "s-1",
      bucketYear: FUTURE_YEAR,
      userIds: ["u-yuki", "u-hana"],
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.assigned).toBe(2);
      expect(res.data.pairsMaterialized).toBe(0);
      expect(res.data.failures).toEqual([]);
    }
    expect(db.leavePolicyAssignment.create).toHaveBeenCalledTimes(2);
    expect(db.leavePolicyAssignment.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ userId: "u-yuki", setId: "s-1", bucketYear: FUTURE_YEAR, periodId: "" }),
    });
    expect(materializeLeaveBalanceTxMock).not.toHaveBeenCalled();
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "leave.policy_set_bulk_assigned", entityLabel: "2 employee(s)" }),
    );
  });

  it("a STARTED window eagerly materializes every item with the set's allocation (the override)", async () => {
    const res = await bulkAssignLeavePolicySet({
      setId: "s-1",
      bucketYear: CURRENT_YEAR,
      userIds: ["u-yuki"],
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.assigned).toBe(1);
      expect(res.data.pairsMaterialized).toBe(2);
    }
    expect(materializeLeaveBalanceTxMock).toHaveBeenCalledTimes(2);
    expect(materializeLeaveBalanceTxMock).toHaveBeenCalledWith(
      db, // the $transaction mock passes db itself as the tx client
      "u-yuki",
      "t-annual",
      CURRENT_YEAR,
      undefined, // implicit calendar window (no periods)
      25, // the set's allocation — the override
    );
  });

  it("an already-assigned employee is a NAMED failure; the rest still land (per-employee isolation)", async () => {
    db.leavePolicyAssignment.findMany.mockResolvedValue([
      { userId: "u-yuki", setId: "s-9" }, // assigned by another set
    ]);
    const res = await bulkAssignLeavePolicySet({
      setId: "s-1",
      bucketYear: FUTURE_YEAR,
      userIds: ["u-yuki", "u-hana"],
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.assigned).toBe(1);
      expect(res.data.failures).toEqual([
        {
          userId: "u-yuki",
          reason: expect.stringContaining("already has an assignment"),
        },
      ]);
    }
    expect(db.leavePolicyAssignment.create).toHaveBeenCalledTimes(1); // only Hana
  });

  it("a typo'd user id is a per-employee failure, never a silent skip", async () => {
    const res = await bulkAssignLeavePolicySet({
      setId: "s-1",
      bucketYear: FUTURE_YEAR,
      userIds: ["u-ghost"],
    });
    expect(res.ok).toBe(false); // nothing landed — the loud all-fail refusal
    if (!res.ok) expect(res.error).toContain("employee not found");
  });

  it("refuses a retired set", async () => {
    db.leavePolicySet.findUnique.mockResolvedValue({ id: "s-1", name: "Old", active: false });
    const res = await bulkAssignLeavePolicySet({ setId: "s-1", bucketYear: FUTURE_YEAR, userIds: ["u-yuki"] });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("retired");
  });

  it("refuses the gap bucket when named periods exist but none covers the target", async () => {
    loadLeavePeriodsMock.mockResolvedValue([
      { id: "p1", name: "FY 2031/32", startDate: "2031-04-01", endDate: "2032-03-31" },
    ]);
    const res = await bulkAssignLeavePolicySet({
      setId: "s-1",
      bucketYear: 2035,
      userIds: ["u-yuki"],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("No named allocation window starts in 2035");
  });

  it("targets a named period's window and records its periodId", async () => {
    loadLeavePeriodsMock.mockResolvedValue([
      { id: "p1", name: "FY 2031/32", startDate: "2031-04-01", endDate: "2032-03-31" },
    ]);
    const res = await bulkAssignLeavePolicySet({
      setId: "s-1",
      bucketYear: 2031,
      userIds: ["u-yuki"],
    });
    expect(res.ok).toBe(true);
    expect(db.leavePolicyAssignment.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ userId: "u-yuki", setId: "s-1", bucketYear: 2031, periodId: "p1" }),
    });
    // A future window (2031-04-01 start vs today 2026) — doc alone.
    expect(materializeLeaveBalanceTxMock).not.toHaveBeenCalled();
  });
});

describe("deleteLeavePolicyAssignment", () => {
  it("refuses when any of the assignment's pairs carries ledger rows (history is immutable)", async () => {
    db.leavePolicyAssignment.findUnique.mockResolvedValue({
      id: "a-1",
      userId: "u-yuki",
      setId: "s-1",
      bucketYear: FUTURE_YEAR,
      periodId: "",
      assignedAt: new Date(),
      assignedById: "u-admin",
    });
    db.leavePolicySet.findUnique.mockResolvedValue({ name: "Standard 2027" });
    db.leavePolicySetItem.findMany.mockResolvedValue(ITEMS.map((i) => ({ setId: "s-1", ...i })));
    db.leaveLedgerEntry.groupBy.mockResolvedValue([
      { userId: "u-yuki", year: FUTURE_YEAR, leaveTypeId: "t-annual", _count: { id: 2 } },
    ]);
    const res = await deleteLeavePolicyAssignment({ id: "a-1" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("never deleted");
    expect(db.leavePolicyAssignment.delete).not.toHaveBeenCalled();
  });

  it("a clean assignment deletes with its zero-entitled balance rows (the global-policy world returns)", async () => {
    db.leavePolicyAssignment.findUnique.mockResolvedValue({
      id: "a-1",
      userId: "u-yuki",
      setId: "s-1",
      bucketYear: FUTURE_YEAR,
      periodId: "",
      assignedAt: new Date(),
      assignedById: "u-admin",
    });
    db.leavePolicySet.findUnique.mockResolvedValue({ name: "Standard 2027" });
    db.leavePolicySetItem.findMany.mockResolvedValue(ITEMS.map((i) => ({ setId: "s-1", ...i })));
    db.leaveLedgerEntry.groupBy.mockResolvedValue([]);
    const res = await deleteLeavePolicyAssignment({ id: "a-1" });
    expect(res.ok).toBe(true);
    expect(db.leavePolicyAssignment.delete).toHaveBeenCalledWith({ where: { id: "a-1" } });
    expect(db.leaveBalance.deleteMany).toHaveBeenCalledTimes(2);
    expect(db.leaveBalance.deleteMany).toHaveBeenCalledWith({
      where: { userId: "u-yuki", leaveTypeId: "t-annual", year: FUTURE_YEAR },
    });
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "leave.policy_assignment_deleted" }),
    );
  });
});
