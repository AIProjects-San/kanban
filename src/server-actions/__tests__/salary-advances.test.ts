import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// P39 (EM-16's advances half) — salary advances: the action layer (issue
// with the adapter rows in one transaction; the live outstanding read).
// ---------------------------------------------------------------------------

const db = vi.hoisted(() => {
  const models = ["salaryAdvance", "payAdjustment", "user", "auditLog"];
  const methods = [
    "findMany", "findUnique", "findFirst", "create", "createMany", "update",
    "updateMany", "delete", "deleteMany", "upsert", "count", "aggregate", "groupBy",
  ];
  const obj: Record<string, Record<string, ReturnType<typeof vi.fn>>> = {};
  for (const m of models) {
    obj[m] = {};
    for (const meth of methods) obj[m][meth] = vi.fn();
  }
  (obj as Record<string, unknown>).$transaction = vi.fn(
    async (fn: unknown) =>
      typeof fn === "function" ? fn(obj) : Promise.all(fn as unknown[]),
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
vi.mock("@/server-actions/shared", () => ({ logAudit: (...a: unknown[]) => logAuditMock(...a) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { getSalaryAdvances, issueSalaryAdvance } from "../salary-advances";

const HR_AUTH = { userId: "u-hr", role: "HR" as const, name: "Remy", email: "remy@x.co" };
const MEMBER_AUTH = { userId: "u-diego", role: "MEMBER" as const, name: "Diego", email: "diego@x.co" };

beforeEach(() => {
  vi.clearAllMocks();
  requirePermissionMock.mockResolvedValue(HR_AUTH);
  db.user.findUnique.mockResolvedValue({ id: "u-diego", name: "Diego Morales", deletedAt: null });
  db.user.findMany.mockResolvedValue([{ id: "u-diego", name: "Diego Morales" }, { id: "u-hr", name: "Remy Laurent" }]);
  db.salaryAdvance.findMany.mockResolvedValue([]);
  db.salaryAdvance.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "sa-new", issuedAt: new Date(), ...data }));
  db.payAdjustment.findMany.mockResolvedValue([]);
  db.payAdjustment.createMany.mockResolvedValue({ count: 0 });
});

describe("issueSalaryAdvance (payroll:manage)", () => {
  it("creates the advance + N equal DEDUCTION adapter rows in ONE transaction", async () => {
    const res = await issueSalaryAdvance({
      userId: "u-diego", amount: 1_200, installments: 4, startPeriod: "2026-12", reason: "relocation",
    });
    expect(res.ok).toBe(true);
    expect(db.salaryAdvance.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: "u-diego", amount: 1_200, installments: 4, status: "OPEN",
          startPeriod: "2026-12", adjustmentCount: 4,
        }),
      }),
    );
    expect(db.payAdjustment.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.arrayContaining([
          expect.objectContaining({
            sourceType: "SALARY_ADVANCE", side: "DEDUCTION", calcMode: "FIXED",
            amount: 300, period: "2026-12", status: "PENDING",
          }),
          expect.objectContaining({ amount: 300, period: "2027-03" }),
        ]),
      }),
    );
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "payroll.advance_issued" }),
    );
  });

  it("the installment periods walk month-over-month from startPeriod", async () => {
    await issueSalaryAdvance({ userId: "u-diego", amount: 900, installments: 3, startPeriod: "2026-11" });
    const rows = db.payAdjustment.createMany.mock.calls[0][0].data as Array<{ period: string }>;
    expect(rows.map((r) => r.period)).toEqual(["2026-11", "2026-12", "2027-01"]);
  });

  it("the rounding remainder rides the LAST installment (1000 / 3)", async () => {
    await issueSalaryAdvance({ userId: "u-diego", amount: 1_000, installments: 3, startPeriod: "2026-12" });
    const rows = db.payAdjustment.createMany.mock.calls[0][0].data as Array<{ amount: number }>;
    expect(rows.map((r) => r.amount)).toEqual([333.33, 333.33, 333.34]);
  });

  it("refuses a ghost employee (QA-12 discipline)", async () => {
    db.user.findUnique.mockResolvedValue(null);
    const res = await issueSalaryAdvance({ userId: "u-ghost", amount: 500, installments: 1, startPeriod: "2026-12" });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/employee not found/i);
    expect(db.salaryAdvance.create).not.toHaveBeenCalled();
  });

  it("validation bounds: bad period / zero amount / 25 installments refuse", async () => {
    expect((await issueSalaryAdvance({ userId: "u-diego", amount: 500, installments: 1, startPeriod: "2026-13" })).ok).toBe(false);
    expect((await issueSalaryAdvance({ userId: "u-diego", amount: 0, installments: 1, startPeriod: "2026-12" })).ok).toBe(false);
    expect((await issueSalaryAdvance({ userId: "u-diego", amount: 500, installments: 25, startPeriod: "2026-12" })).ok).toBe(false);
  });

  it("a MEMBER cannot issue (payroll:manage)", async () => {
    requirePermissionMock.mockImplementation(async (perm: string) => {
      if (perm === "payroll:manage") throw new (class extends Error { digest = "AuthorizationError"; })("denied");
      return MEMBER_AUTH;
    });
    const res = await issueSalaryAdvance({ userId: "u-diego", amount: 500, installments: 1, startPeriod: "2026-12" });
    expect(res.ok).toBe(false);
    expect(db.salaryAdvance.create).not.toHaveBeenCalled();
  });
});

describe("getSalaryAdvances (payroll:manage)", () => {
  it("derives the live outstanding from the CONSUMED adapter rows (provenance-linked)", async () => {
    db.salaryAdvance.findMany.mockResolvedValue([
      { id: "sa-1", userId: "u-diego", amount: 1_200, status: "OPEN", installments: 4, startPeriod: "2026-12", reason: "relocation", issuedById: "u-hr", issuedAt: new Date(), recoveredAt: null },
      { id: "sa-2", userId: "u-diego", amount: 500, status: "RECOVERED", installments: 1, startPeriod: "2026-10", reason: "", issuedById: "u-hr", issuedAt: new Date(), recoveredAt: new Date() },
    ]);
    db.payAdjustment.findMany.mockResolvedValue([
      { sourceId: "sa-1", status: "CONSUMED", amount: 300 },
      { sourceId: "sa-1", status: "CONSUMED", amount: 300 },
      { sourceId: "sa-1", status: "PENDING", amount: 300 }, // not yet consumed
      { sourceId: "sa-2", status: "CONSUMED", amount: 500 },
    ]);
    const res = await getSalaryAdvances();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const open = res.data.find((a) => a.id === "sa-1");
    expect(open).toMatchObject({ status: "OPEN", consumedCount: 2, consumedTotal: 600, outstanding: 600 });
    expect(open?.summary).toBe("$600.00 outstanding · 2 of 4 installments repaid");
    const recovered = res.data.find((a) => a.id === "sa-2");
    expect(recovered).toMatchObject({ status: "RECOVERED", outstanding: 0 });
  });

  it("empty state resolves cleanly", async () => {
    const res = await getSalaryAdvances();
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data).toEqual([]);
  });
});
