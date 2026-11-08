import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// P3 (PR-13/PR-B11, F3.1) — arrears action tests.
// docs/Fernly_HR_Payroll_Enhancement_Plan.md §7.2.1 payroll sweep, item 3.
// ---------------------------------------------------------------------------

const db = vi.hoisted(() => {
  const models = [
    "user", "employeeProfile", "salaryStructure", "payrollRun", "payslip",
    "payAdjustment", "auditLog",
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

const getWorkspaceConfigMock = vi.fn();
vi.mock("@/lib/config-loader", () => ({
  getWorkspaceConfig: (...a: unknown[]) => getWorkspaceConfigMock(...a),
  bumpConfigCache: vi.fn(),
}));

import { previewArrearsRun, generateArrears } from "../payroll-arrears";

const HR_AUTH = { userId: "u-hr", role: "HR" as const, name: "Remy", email: "remy@x.co" };

const LOCKED_RUN = {
  id: "run-oct", period: "2026-10", status: "LOCKED", workingDays: 22,
  lockedById: "u-hr", lockedAt: new Date(), createdById: "u-hr",
  createdAt: new Date(), updatedAt: new Date(),
};

function slip(overrides: Record<string, unknown> = {}) {
  return {
    id: "ps-1", runId: "run-oct", userId: "u-yuki", slipNo: "PS-2026-10-001",
    earnings: "[]", deductions: "[]", note: "",
    lopDays: 0, lopSource: "AUTO", version: 0,
    paidDays: 22, gross: 6_700, net: 6_700,
    createdAt: new Date(), updatedAt: new Date(),
    ...overrides,
  };
}

const RAISED_STRUCTURE = {
  id: "ss-2", userId: "u-yuki",
  components: JSON.stringify([
    { key: "basic", label: "Basic Salary", kind: "EARNING", mode: "FIXED", amount: 90_000 },
  ]),
  notes: "", effectiveFrom: new Date(), isActive: true,
  createdAt: new Date(), updatedAt: new Date(),
};

beforeEach(() => {
  vi.clearAllMocks();
  requirePermissionMock.mockResolvedValue(HR_AUTH);
  getWorkspaceConfigMock.mockResolvedValue({ workspace: { payrollRoundingMode: "ROUND_2DP" } });
  db.payrollRun.findUnique.mockImplementation(async ({ where }: { where: { id?: string; period?: string } }) => {
    if (where.id === "run-oct") return { ...LOCKED_RUN, payslips: db.__slips ?? [] };
    if (where.period) return null; // no locked target period by default
    return null;
  });
  db.salaryStructure.findMany.mockResolvedValue([RAISED_STRUCTURE]);
  db.payAdjustment.findMany.mockResolvedValue([]);
  db.payAdjustment.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "adj-new", ...data }));
  db.user.findMany.mockResolvedValue([{ id: "u-yuki", name: "Yuki Tanaka" }]);
});

describe("P3 — previewArrearsRun", () => {
  it("re-simulates a LOCKED run under the current structures (positive deltas flagged)", async () => {
    (db as unknown as { __slips: unknown[] }).__slips = [slip()];
    const res = await previewArrearsRun({ runId: "run-oct" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data).toHaveLength(1);
      expect(res.data[0]).toMatchObject({
        userName: "Yuki Tanaka", slipNo: "PS-2026-10-001",
        storedNet: 6_700, simulatedNet: 7_500, delta: 800, owed: true, alreadyArranged: false,
      });
    }
  });

  it("refuses a run that is not LOCKED (arrears re-simulate paid history)", async () => {
    db.payrollRun.findUnique.mockResolvedValueOnce({ ...LOCKED_RUN, status: "OPEN", payslips: [] });
    const res = await previewArrearsRun({ runId: "run-oct" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("LOCKED");
  });

  it("marks slips whose arrears were already arranged (idempotency preview)", async () => {
    (db as unknown as { __slips: unknown[] }).__slips = [slip()];
    db.payAdjustment.findMany.mockResolvedValue([{ sourceId: "ps-1", period: "2026-12", status: "PENDING" }]);
    const res = await previewArrearsRun({ runId: "run-oct" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data[0].alreadyArranged).toBe(true);
  });
});

describe("P3 — generateArrears", () => {
  it("emits positive deltas as ARREARS adapter rows and audits", async () => {
    (db as unknown as { __slips: unknown[] }).__slips = [slip()];
    const res = await generateArrears({ runId: "run-oct", payoutPeriod: "2026-12" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.created).toBe(1);
      expect(res.data.totalDelta).toBe(800);
    }
    expect(db.payAdjustment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: "u-yuki", sourceType: "ARREARS", sourceId: "ps-1",
          label: "Arrears — 2026-10 (PS-2026-10-001)",
          side: "EARNING", recurrence: "ONE_SHOT", calcMode: "FIXED",
          amount: 800, period: "2026-12",
        }),
      }),
    );
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "payroll.arrears_generated" }));
  });

  it("refuses a LOCKED payout period", async () => {
    db.payrollRun.findUnique.mockImplementation(async ({ where }: { where: { id?: string; period?: string } }) => {
      if (where.period === "2026-11") return { status: "LOCKED" };
      if (where.id === "run-oct") return { ...LOCKED_RUN, payslips: [slip()] };
      return null;
    });
    const res = await generateArrears({ runId: "run-oct", payoutPeriod: "2026-11" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("already locked");
  });

  it("refuses when any slip already has arrears arranged (double arrears is double pay)", async () => {
    (db as unknown as { __slips: unknown[] }).__slips = [slip()];
    db.payAdjustment.findMany.mockResolvedValue([{ sourceId: "ps-1", period: "2026-12", status: "PENDING" }]);
    const res = await generateArrears({ runId: "run-oct", payoutPeriod: "2026-12" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("cannot be paid arrears twice");
    expect(db.payAdjustment.create).not.toHaveBeenCalled();
  });

  it("nothing owed → a clean zero no-op (no rows, no audit)", async () => {
    (db as unknown as { __slips: unknown[] }).__slips = [slip({ net: 7_500 })];
    const res = await generateArrears({ runId: "run-oct", payoutPeriod: "2026-12" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data).toEqual({ created: 0, totalDelta: 0 });
    expect(db.payAdjustment.create).not.toHaveBeenCalled();
    expect(logAuditMock).not.toHaveBeenCalled();
  });
});
