import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// P4 (PR-14/PR-B12, F3.1) — LWP correction action tests.
// ---------------------------------------------------------------------------

const db = vi.hoisted(() => {
  const models = [
    "user", "payslip", "payrollRun", "payAdjustment", "auditLog",
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

import { previewLwpCorrection, reverseLwpDays } from "../payroll-lwp";

const HR_AUTH = { userId: "u-hr", role: "HR" as const, name: "Remy", email: "remy@x.co" };

const LOCKED_SLIP = {
  id: "ps-1", runId: "run-oct", userId: "u-yuki", slipNo: "PS-2026-10-001",
  earnings: JSON.stringify([{ key: "basic", label: "Basic Salary", amount: 6_500 }]),
  deductions: JSON.stringify([{ key: "lop", label: "Loss of pay (2 days)", amount: 609.09 }]),
  note: "", lopDays: 2, lopSource: "AUTO", version: 0, paidDays: 22,
  gross: 6_500, net: 5_890.91,
  createdAt: new Date(), updatedAt: new Date(),
  run: { id: "run-oct", period: "2026-10", status: "LOCKED" },
};

beforeEach(() => {
  vi.clearAllMocks();
  requirePermissionMock.mockResolvedValue(HR_AUTH);
  db.payslip.findUnique.mockResolvedValue(LOCKED_SLIP);
  db.payrollRun.findUnique.mockResolvedValue(null);
  db.payAdjustment.findMany.mockResolvedValue([]);
  db.payAdjustment.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "adj-new", ...data }));
  db.user.findUnique.mockResolvedValue({ id: "u-yuki", name: "Yuki Tanaka" });
});

describe("P4 — previewLwpCorrection", () => {
  it("exposes the stored LOP facts, prior reversals and the per-day price", async () => {
    db.payAdjustment.findMany.mockResolvedValue([{ sourceDays: 0.5, status: "PENDING" }]);
    const res = await previewLwpCorrection({ payslipId: "ps-1" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data).toMatchObject({
        userName: "Yuki Tanaka", slipNo: "PS-2026-10-001",
        storedLopDays: 2, storedLopAmount: 609.09,
        alreadyReversedDays: 0.5, reversibleDays: 1.5,
        perDay: 304.55,
      });
    }
  });

  it("refuses an OPEN slip (corrections are for PAID history)", async () => {
    db.payslip.findUnique.mockResolvedValue({ ...LOCKED_SLIP, run: { id: "run-nov", period: "2026-11", status: "OPEN" } });
    const res = await previewLwpCorrection({ payslipId: "ps-1" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("edited directly");
  });
});

describe("P4 — reverseLwpDays", () => {
  it("creates the LWP_CREDIT adapter row with the days as data and audits", async () => {
    const res = await reverseLwpDays({ payslipId: "ps-1", days: 1, payoutPeriod: "2026-12", note: "Attendance corrected" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.credit).toBe(304.55);
    expect(db.payAdjustment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: "u-yuki", sourceType: "LWP_CREDIT", sourceId: "ps-1", sourceDays: 1,
          label: "LWP correction — 2026-10 (PS-2026-10-001, 1d)",
          side: "EARNING", recurrence: "ONE_SHOT", calcMode: "FIXED",
          amount: 304.55, period: "2026-12",
        }),
      }),
    );
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "payroll.lwp_credit_created" }));
  });

  it("refuses past the reversal cap (Σ sourceDays of prior credits)", async () => {
    db.payAdjustment.findMany.mockResolvedValue([{ sourceDays: 1.5, status: "PENDING" }]);
    const res = await reverseLwpDays({ payslipId: "ps-1", days: 1, payoutPeriod: "2026-12" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("0.5 day(s) are still reversible");
    expect(db.payAdjustment.create).not.toHaveBeenCalled();
  });

  it("SKIPPED prior credits do not consume the cap (their money never landed)", async () => {
    db.payAdjustment.findMany.mockResolvedValue([{ sourceDays: 1.5, status: "SKIPPED" }]);
    const res = await reverseLwpDays({ payslipId: "ps-1", days: 2, payoutPeriod: "2026-12" });
    expect(res.ok).toBe(true);
  });

  it("refuses a LOCKED payout period", async () => {
    db.payrollRun.findUnique.mockResolvedValue({ status: "LOCKED" });
    const res = await reverseLwpDays({ payslipId: "ps-1", days: 1, payoutPeriod: "2026-11" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("already locked");
  });
});
