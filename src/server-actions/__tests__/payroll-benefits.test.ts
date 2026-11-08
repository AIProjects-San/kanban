import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// P5 (PR-15–18, PR-B04, F3.2) — flexible-benefits action tests.
// ---------------------------------------------------------------------------

const db = vi.hoisted(() => {
  const models = [
    "user", "salaryStructure", "payrollRun", "payslip", "payAdjustment",
    "benefitElection", "benefitAccrual", "auditLog",
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

import { getBenefitsOverview, electBenefit, cancelBenefitElection, claimBenefit } from "../payroll-benefits";

const HR_AUTH = { userId: "u-hr", role: "HR" as const, name: "Remy", email: "remy@x.co" };

beforeEach(() => {
  vi.clearAllMocks();
  requirePermissionMock.mockResolvedValue(HR_AUTH);
  db.user.findUnique.mockResolvedValue({ id: "u-yuki", name: "Yuki Tanaka" });
  db.user.findMany.mockResolvedValue([{ id: "u-yuki", name: "Yuki Tanaka" }]);
  db.salaryStructure.findMany.mockResolvedValue([{ userId: "u-yuki", maxBenefits: 2_000 }]);
  db.salaryStructure.findFirst.mockResolvedValue({ maxBenefits: 2_000 });
  db.benefitElection.findMany.mockResolvedValue([]);
  db.benefitElection.findUnique.mockResolvedValue(null);
  db.benefitElection.upsert.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "be-new", createdAt: new Date(), updatedAt: new Date(), ...data }));
  db.benefitAccrual.groupBy.mockResolvedValue([]);
  db.benefitAccrual.create.mockResolvedValue({});
  db.payAdjustment.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "adj-new", ...data }));
  db.payrollRun.findUnique.mockResolvedValue(null);
});

describe("P5 — getBenefitsOverview", () => {
  it("joins elections with live balances and caps", async () => {
    db.benefitElection.findMany.mockResolvedValue([{
      id: "be-1", userId: "u-yuki", year: 2026, componentCode: "HEALTH",
      label: "Health insurance", annualAmount: 1_200, status: "ACTIVE",
      createdById: "u-hr", createdAt: new Date(), updatedAt: new Date(),
    }]);
    db.benefitAccrual.groupBy.mockResolvedValue([{ userId: "u-yuki", componentCode: "HEALTH", _sum: { delta: 150 } }]);
    const res = await getBenefitsOverview({ year: 2026 });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.year).toBe(2026);
      expect(res.data.rows[0]).toMatchObject({
        userName: "Yuki Tanaka", componentCode: "HEALTH", annualAmount: 1_200,
        cap: 2_000, balance: 150, status: "ACTIVE",
      });
    }
  });
});

describe("P5 — electBenefit (the capped, replace-on-re-elect writer)", () => {
  it("creates the first election within the cap and audits", async () => {
    const res = await electBenefit({ userId: "u-yuki", year: 2026, componentCode: "HEALTH", label: "Health insurance", annualAmount: 1_200 });
    expect(res.ok).toBe(true);
    const upsertArg = db.benefitElection.upsert.mock.calls[0][0] as { create: Record<string, unknown> };
    expect(upsertArg.create).toMatchObject({ annualAmount: 1_200 });
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "payroll.benefit_elected" }));
  });

  it("refuses past the structure's cap", async () => {
    db.benefitElection.findMany.mockResolvedValue([{
      id: "be-1", userId: "u-yuki", year: 2026, componentCode: "GYM",
      label: "Gym", annualAmount: 1_500, status: "ACTIVE",
      createdById: "u-hr", createdAt: new Date(), updatedAt: new Date(),
    }]);
    const res = await electBenefit({ userId: "u-yuki", year: 2026, componentCode: "HEALTH", label: "Health", annualAmount: 900 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("$2,000");
    expect(db.benefitElection.upsert).not.toHaveBeenCalled();
  });

  it("re-electing the same component REPLACES its amount (the cap counts the new total)", async () => {
    db.benefitElection.findMany.mockResolvedValue([{
      id: "be-1", userId: "u-yuki", year: 2026, componentCode: "HEALTH",
      label: "Health", annualAmount: 1_200, status: "ACTIVE",
      createdById: "u-hr", createdAt: new Date(), updatedAt: new Date(),
    }]);
    const res = await electBenefit({ userId: "u-yuki", year: 2026, componentCode: "HEALTH", label: "Health+", annualAmount: 1_800 });
    // new total = 0 (other) − 1200 (old HEALTH) + 1800 = 600 ≤ 2000 → lawful.
    expect(res.ok).toBe(true);
  });

  it("refuses an employee with no active structure", async () => {
    db.salaryStructure.findFirst.mockResolvedValue(null);
    const res = await electBenefit({ userId: "u-yuki", year: 2026, componentCode: "HEALTH", annualAmount: 500 });
    expect(res.ok).toBe(false);
  });
});

describe("P5 — cancelBenefitElection", () => {
  it("flips ACTIVE → CANCELLED (accrued balance stays claimable)", async () => {
    db.benefitElection.findUnique.mockResolvedValue({
      id: "be-1", userId: "u-yuki", year: 2026, componentCode: "HEALTH",
      label: "Health insurance", annualAmount: 1_200, status: "ACTIVE",
      createdById: "u-hr", createdAt: new Date(), updatedAt: new Date(),
    });
    const res = await cancelBenefitElection({ electionId: "be-1" });
    expect(res.ok).toBe(true);
    expect(db.benefitElection.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "be-1" }, data: { status: "CANCELLED" } }),
    );
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "payroll.benefit_election_cancelled" }));
  });
});

describe("P5 — claimBenefit (consumes accrued balance, pays via the adapter)", () => {
  it("writes the −CLAIM row and the BENEFIT_PAYOUT adjustment in one transaction", async () => {
    db.benefitElection.findUnique.mockResolvedValue({
      id: "be-1", userId: "u-yuki", year: 2026, componentCode: "HEALTH",
      label: "Health insurance", annualAmount: 1_200, status: "ACTIVE",
      createdById: "u-hr", createdAt: new Date(), updatedAt: new Date(),
    });
    db.benefitAccrual.groupBy.mockResolvedValue([{ entryType: "ACCRUAL", _sum: { delta: 150 } }]);
    const res = await claimBenefit({ userId: "u-yuki", year: 2026, componentCode: "HEALTH", amount: 60, payoutPeriod: "2026-12", note: "Dental" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.amount).toBe(60);
    expect(db.payAdjustment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: "u-yuki", sourceType: "BENEFIT_PAYOUT", componentCode: "HEALTH",
          label: "Benefit claim — Health insurance",
          side: "EARNING", recurrence: "ONE_SHOT", calcMode: "FIXED",
          amount: 60, period: "2026-12",
        }),
      }),
    );
    expect(db.benefitAccrual.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: "u-yuki", year: 2026, componentCode: "HEALTH",
          entryType: "CLAIM", delta: -60,
        }),
      }),
    );
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "payroll.benefit_claimed" }));
  });

  it("refuses a claim past the accrued balance", async () => {
    db.benefitElection.findUnique.mockResolvedValue({
      id: "be-1", userId: "u-yuki", year: 2026, componentCode: "HEALTH",
      label: "Health insurance", annualAmount: 1_200, status: "ACTIVE",
      createdById: "u-hr", createdAt: new Date(), updatedAt: new Date(),
    });
    db.benefitAccrual.groupBy.mockResolvedValue([{ entryType: "ACCRUAL", _sum: { delta: 150 } }]);
    const res = await claimBenefit({ userId: "u-yuki", year: 2026, componentCode: "HEALTH", amount: 200, payoutPeriod: "2026-12" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("$150");
    expect(db.payAdjustment.create).not.toHaveBeenCalled();
  });

  it("refuses a LOCKED payout period", async () => {
    db.benefitElection.findUnique.mockResolvedValue({
      id: "be-1", userId: "u-yuki", year: 2026, componentCode: "HEALTH",
      label: "Health insurance", annualAmount: 1_200, status: "ACTIVE",
      createdById: "u-hr", createdAt: new Date(), updatedAt: new Date(),
    });
    db.benefitAccrual.groupBy.mockResolvedValue([{ entryType: "ACCRUAL", _sum: { delta: 150 } }]);
    db.payrollRun.findUnique.mockResolvedValue({ status: "LOCKED" });
    const res = await claimBenefit({ userId: "u-yuki", year: 2026, componentCode: "HEALTH", amount: 60, payoutPeriod: "2026-11" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("already locked");
  });
});
