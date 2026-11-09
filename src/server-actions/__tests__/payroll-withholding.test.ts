import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// P8 (PR-19/PR-B13, F3.3) — salary-withholding action tests.
// RBAC, overlap refusal, the LOCKED-fromPeriod refusal, the transactional
// release (slips flip RELEASED + WITHHELD_RELEASE rows + the window flips),
// and the settled-FnF guard.
// ---------------------------------------------------------------------------

const db = vi.hoisted(() => {
  const models = [
    "user", "payrollRun", "payslip", "payAdjustment", "salaryWithholding",
    "fullAndFinalStatement", "auditLog",
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
  listSalaryWithholdings,
  createSalaryWithholding,
  releaseSalaryWithholding,
} from "../payroll-withholding";

const HR_AUTH = { userId: "u-hr", role: "HR" as const, name: "Remy", email: "remy@x.co" };

const ACTIVE_HOLD = {
  id: "sw-1",
  userId: "u-ingrid",
  fromPeriod: "2026-11",
  untilPeriod: null,
  reason: "Pending dispute resolution",
  status: "ACTIVE",
  createdById: "u-hr",
  releasedById: "",
  releasedAt: null,
  releasePeriod: "",
  createdAt: new Date("2026-11-01T00:00:00.000Z"),
  updatedAt: new Date("2026-11-01T00:00:00.000Z"),
};

const HELD_SLIPS = [
  {
    id: "ps-1", runId: "r-1", userId: "u-ingrid", slipNo: "PS-2026-11-004",
    net: 8_000, withholdStatus: "WITHHELD",
    run: { period: "2026-11" },
  },
  {
    id: "ps-2", runId: "r-2", userId: "u-ingrid", slipNo: "PS-2026-12-004",
    net: 8_100, withholdStatus: "WITHHELD",
    run: { period: "2026-12" },
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  requirePermissionMock.mockResolvedValue(HR_AUTH);
  db.user.findUnique.mockResolvedValue({ id: "u-ingrid", name: "Ingrid Solberg" });
  db.user.findMany.mockResolvedValue([{ id: "u-ingrid", name: "Ingrid Solberg" }]);
  db.payrollRun.findUnique.mockResolvedValue(null);
  db.salaryWithholding.findMany.mockResolvedValue([]);
  db.salaryWithholding.findFirst.mockResolvedValue(null);
  db.salaryWithholding.findUnique.mockResolvedValue(null);
  db.payslip.findMany.mockResolvedValue([]);
  db.fullAndFinalStatement.findFirst.mockResolvedValue(null);
});

describe("P8 — listSalaryWithholdings", () => {
  it("lists rows with the live hold balance per employee", async () => {
    db.salaryWithholding.findMany.mockResolvedValue([ACTIVE_HOLD]);
    db.payslip.findMany.mockResolvedValue([
      { userId: "u-ingrid", net: 8_000 },
      { userId: "u-ingrid", net: 8_100 },
    ]);
    const res = await listSalaryWithholdings();
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data).toHaveLength(1);
      expect(res.data[0]).toMatchObject({
        userName: "Ingrid Solberg",
        status: "ACTIVE",
        heldSlipCount: 2,
        heldTotal: 16_100,
      });
    }
  });

  it("requires payroll:manage", async () => {
    requirePermissionMock.mockRejectedValue(new Error("denied"));
    const res = await listSalaryWithholdings();
    expect(res.ok).toBe(false);
  });
});

describe("P8 — createSalaryWithholding", () => {
  it("creates the ACTIVE window and audits it", async () => {
    db.salaryWithholding.create.mockResolvedValue(ACTIVE_HOLD);
    const res = await createSalaryWithholding({
      userId: "u-ingrid", fromPeriod: "2026-12", untilPeriod: null, reason: "Investigation",
    });
    expect(res.ok).toBe(true);
    expect(db.salaryWithholding.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ userId: "u-ingrid", fromPeriod: "2026-12", status: "ACTIVE" }),
    });
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "payroll.withholding_created" }),
    );
  });

  it("refuses a fromPeriod whose run is already LOCKED (paid)", async () => {
    db.payrollRun.findUnique.mockResolvedValue({ status: "LOCKED" });
    const res = await createSalaryWithholding({
      userId: "u-ingrid", fromPeriod: "2026-10", untilPeriod: null, reason: "",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("already locked");
  });

  it("refuses overlapping ACTIVE windows for the same employee", async () => {
    db.salaryWithholding.findMany.mockResolvedValue([ACTIVE_HOLD]); // 2026-11 → open
    const res = await createSalaryWithholding({
      userId: "u-ingrid", fromPeriod: "2027-05", untilPeriod: "2027-06", reason: "",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("active hold");
    expect(db.salaryWithholding.create).not.toHaveBeenCalled();
  });

  it("allows a disjoint window for the same employee", async () => {
    db.salaryWithholding.findMany.mockResolvedValue([
      { ...ACTIVE_HOLD, fromPeriod: "2026-11", untilPeriod: "2026-12" },
    ]);
    db.salaryWithholding.create.mockResolvedValue({ ...ACTIVE_HOLD, id: "sw-2" });
    const res = await createSalaryWithholding({
      userId: "u-ingrid", fromPeriod: "2027-05", untilPeriod: null, reason: "",
    });
    expect(res.ok).toBe(true);
  });

  it("requires payroll:manage", async () => {
    requirePermissionMock.mockRejectedValue(new Error("denied"));
    const res = await createSalaryWithholding({
      userId: "u-ingrid", fromPeriod: "2026-12", untilPeriod: null, reason: "",
    });
    expect(res.ok).toBe(false);
    expect(logAuditMock).not.toHaveBeenCalled();
  });
});

describe("P8 — releaseSalaryWithholding", () => {
  it("flips the slips RELEASED, writes one WITHHELD_RELEASE row per slip, all in one transaction", async () => {
    db.salaryWithholding.findUnique.mockResolvedValue(ACTIVE_HOLD);
    db.payslip.findMany.mockResolvedValue(HELD_SLIPS);
    db.payAdjustment.create.mockImplementation(async ({ data }) => ({ id: `adj-${data.sourceId}`, ...data }));

    const res = await releaseSalaryWithholding({ withholdingId: "sw-1", releasePeriod: "2027-01", note: "" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data).toEqual({ releasedSlips: 2, adjustmentCount: 2, total: 16_100 });
    }
    expect(db.payAdjustment.create).toHaveBeenCalledTimes(2);
    const first = db.payAdjustment.create.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(first.data).toMatchObject({
      userId: "u-ingrid",
      sourceType: "WITHHOLDING_RELEASE",
      sourceId: "ps-1",
      side: "EARNING",
      recurrence: "ONE_SHOT",
      calcMode: "FIXED",
      amount: 8_000,
      period: "2027-01",
    });
    expect(db.payslip.update).toHaveBeenCalledTimes(2);
    expect(db.payslip.update).toHaveBeenCalledWith({ where: { id: "ps-1" }, data: { withholdStatus: "RELEASED" } });
    expect(db.salaryWithholding.update).toHaveBeenCalledWith({
      where: { id: "sw-1" },
      data: expect.objectContaining({ status: "RELEASED", releasePeriod: "2027-01" }),
    });
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "payroll.withholding_released" }),
    );
  });

  it("refuses releasing a hold that is already RELEASED (terminal)", async () => {
    db.salaryWithholding.findUnique.mockResolvedValue({ ...ACTIVE_HOLD, status: "RELEASED" });
    const res = await releaseSalaryWithholding({ withholdingId: "sw-1", releasePeriod: "2027-01", note: "" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("already released");
  });

  it("refuses a LOCKED release period", async () => {
    db.salaryWithholding.findUnique.mockResolvedValue(ACTIVE_HOLD);
    db.payrollRun.findUnique.mockResolvedValue({ status: "LOCKED" });
    const res = await releaseSalaryWithholding({ withholdingId: "sw-1", releasePeriod: "2026-10", note: "" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("already locked");
  });

  it("refuses releasing for an employee with a SETTLED FnF (frozen exit money)", async () => {
    db.salaryWithholding.findUnique.mockResolvedValue(ACTIVE_HOLD);
    db.fullAndFinalStatement.findFirst.mockResolvedValue({ id: "fnf-1" });
    const res = await releaseSalaryWithholding({ withholdingId: "sw-1", releasePeriod: "2027-01", note: "" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("settled");
    expect(db.payAdjustment.create).not.toHaveBeenCalled();
  });

  it("a hold with no held slips releases the window without money rows", async () => {
    db.salaryWithholding.findUnique.mockResolvedValue(ACTIVE_HOLD);
    db.payslip.findMany.mockResolvedValue([]);
    const res = await releaseSalaryWithholding({ withholdingId: "sw-1", releasePeriod: "2027-01", note: "" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data).toEqual({ releasedSlips: 0, adjustmentCount: 0, total: 0 });
    expect(db.salaryWithholding.update).toHaveBeenCalled();
  });
});
