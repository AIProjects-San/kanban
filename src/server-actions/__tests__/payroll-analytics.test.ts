import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// P22 (PR-C01–04, PR-N01–06) — getPayrollAnalytics action tests: the
// payroll:manage gate, the LOCKED-run basis, the claims-ledger magnitude
// conversion, and the profile-dimension join feeding the pure kernel.
// ---------------------------------------------------------------------------

const db = vi.hoisted(() => {
  const models = ["payslip", "salaryStructure", "benefitAccrual", "payAdjustment", "employeeProfile"];
  const methods = ["findMany", "count"];
  const obj: Record<string, Record<string, ReturnType<typeof vi.fn>>> = {};
  for (const m of models) {
    obj[m] = {};
    for (const meth of methods) obj[m][meth] = vi.fn();
  }
  return obj;
});

vi.mock("@/lib/db", () => ({ db }));

const requirePermissionMock = vi.fn();
vi.mock("@/server-actions/auth-guard", () => ({
  requirePermission: (...a: unknown[]) => requirePermissionMock(...a),
  getSessionOrThrow: vi.fn(),
  AuthorizationError: class AuthorizationError extends Error {
    readonly digest = "AuthorizationError";
    constructor(m: string) { super(m); this.name = "AuthorizationError"; }
  },
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { getPayrollAnalytics } from "../payroll";

const HR_AUTH = { userId: "u-hr", role: "HR" as const, name: "Remy", email: "remy@x.co" };

// Prisma-shaped locked-run slips (the run relation selected down to period +
// endDate — exactly the columns the action reads).
const lockedSlip = (over: Record<string, unknown> = {}) => ({
  userId: "u-yuki",
  gross: 6_700,
  net: 6_476.67,
  withholdStatus: "",
  run: { period: "2026-11", endDate: new Date("2026-11-30T00:00:00Z") },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  requirePermissionMock.mockResolvedValue(HR_AUTH);
});

describe("getPayrollAnalytics (P22)", () => {
  it("is payroll:manage-gated — a denied caller gets ok:false and no reads", async () => {
    requirePermissionMock.mockRejectedValue(new Error("denied"));
    const res = await getPayrollAnalytics();
    expect(res.ok).toBe(false);
    expect(res.ok ? null : res.error).toBeTruthy();
    expect(db.payslip.findMany).not.toHaveBeenCalled();
  });

  it("reads LOCKED runs' slips only (the where clause pins the basis)", async () => {
    db.payslip.findMany.mockResolvedValue([]);
    db.salaryStructure.count.mockResolvedValue(0);
    db.benefitAccrual.findMany.mockResolvedValue([]);
    db.payAdjustment.findMany.mockResolvedValue([]);
    db.employeeProfile.findMany.mockResolvedValue([]);
    await getPayrollAnalytics();
    expect(db.payslip.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { run: { status: "LOCKED" } } }),
    );
  });

  it("builds the payload: window-end attribution, dimension join, claim magnitudes", async () => {
    db.payslip.findMany.mockResolvedValue([
      lockedSlip({ userId: "u-yuki", gross: 6_700, net: 6_476.67 }),
      // A WITHHELD slip in the same month — its net is NOT outgoing.
      lockedSlip({ userId: "u-ingrid", gross: 5_000, net: 4_800, withholdStatus: "WITHHELD" }),
      // A weekly run ENDING Dec 1 — attributed to December, not November.
      lockedSlip({ userId: "u-soren", gross: 1_000, net: 900, run: { period: "2026-W48", endDate: new Date("2026-12-01T00:00:00Z") } }),
    ]);
    db.salaryStructure.count.mockResolvedValue(3);
    // CLAIM rows store NEGATIVE deltas (append-only ledger discipline).
    db.benefitAccrual.findMany.mockResolvedValue([
      { delta: -250, period: "2026-11", createdAt: new Date("2026-11-20T00:00:00Z") },
    ]);
    db.payAdjustment.findMany.mockResolvedValue([
      { amount: 500 },
      { amount: 250 },
    ]);
    db.employeeProfile.findMany.mockResolvedValue([
      { userId: "u-yuki", department: "ENGINEERING", jobTitle: "Data Engineer" },
      // u-ingrid and u-soren have no profile row → honest fallback buckets.
    ]);

    const res = await getPayrollAnalytics();
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    const data = res.data;

    // The November bucket = the disbursed Nov slip only (the withheld net
    // stays out); the Dec-1-ending weekly run lands in December.
    expect(data.outgoing).toEqual([
      { monthKey: "2026-11", label: "Nov 2026", net: 6_476.67, gross: 6_700 },
      { monthKey: "2026-12", label: "Dec 2026", net: 900, gross: 1_000 },
    ]);
    // The anchor month is the latest paid month; slices join the profile.
    expect(data.departmentSalary.anchorMonth).toBe("2026-12");
    expect(data.departmentSalary.rows).toEqual([
      { label: "No department", amount: 1_000, slipCount: 1 },
    ]);
    expect(data.designationSalary.rows).toEqual([
      { label: "No job title", amount: 1_000, slipCount: 1 },
    ]);
    // Claim magnitude (−250 → 250) + the incentive total.
    expect(data.benefitClaims).toEqual([
      { monthKey: "2026-11", label: "Nov 2026", amount: 250, count: 1 },
    ]);
    expect(data.cards).toMatchObject({
      totalOutgoingSalary: 7_376.67,
      outgoingSalaryMonths: 2,
      totalSalaryStructures: 3,
      benefitClaimsTotal: 250,
      benefitClaimsCount: 1,
      incentiveTotal: 750,
      incentiveCount: 2,
      statutoryDeclined: true,
    });
  });

  it("an empty workspace returns the honest empty payload", async () => {
    db.payslip.findMany.mockResolvedValue([]);
    db.salaryStructure.count.mockResolvedValue(0);
    db.benefitAccrual.findMany.mockResolvedValue([]);
    db.payAdjustment.findMany.mockResolvedValue([]);
    db.employeeProfile.findMany.mockResolvedValue([]);
    const res = await getPayrollAnalytics();
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.data.outgoing).toEqual([]);
    expect(res.data.departmentSalary).toEqual({ anchorMonth: null, rows: [], total: 0 });
    expect(res.data.cards.outgoingSalaryMonths).toBe(0);
    expect(res.data.cards.statutoryDeclined).toBe(true);
  });
});
