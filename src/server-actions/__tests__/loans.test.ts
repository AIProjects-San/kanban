import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// G3 — the loan action tests: creation (validation + the rate snapshot),
// the approval lifecycle (submit / four-eyes approve / reject / cancel /
// activate — guarded flips), the activation's schedule + adapter rows
// (the payroll rider), the lock-time settlement writer (idempotency, the
// balance walk, the CLOSED flip), early repayment (the honesty guard, the
// adapter neutralization, FINAL_SETTLEMENT), and the FnF receivable
// reader. The pure kernel is covered in lib/payroll/__tests__/loans.test.ts.
// ---------------------------------------------------------------------------

const db = vi.hoisted(() => {
  const models = [
    "user", "loanType", "loan", "loanSchedule", "loanRepayment",
    "payAdjustment", "payslip", "auditLog",
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
      typeof fn === "function" ? fn(obj) : Promise.all(fn as unknown[]),
  );
  return obj;
});
vi.mock("@/lib/infra/db", () => ({ db }));

const requirePermissionMock = vi.fn();
vi.mock("@/server-actions/auth-guard", () => ({
  requirePermission: (...a: unknown[]) => requirePermissionMock(...a),
  AuthorizationError: class AuthorizationError extends Error {
    readonly digest = "AuthorizationError";
    constructor(m: string) {
      super(m);
      this.name = "AuthorizationError";
    }
  },
}));

const logAuditMock = vi.fn();
vi.mock("@/server-actions/shared", () => ({
  logAudit: (...a: unknown[]) => logAuditMock(...a),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import {
  createLoan,
  submitLoan,
  approveLoan,
  rejectLoan,
  cancelLoan,
  activateLoan,
  earlyRepayLoan,
  settleLoansForRunTx,
  openLoansFor,
  getLoansOverview,
} from "../loans";

const HR_AUTH = { userId: "u-hr", role: "HR" as const, name: "Remy", email: "remy@x.co" };
const ADMIN_AUTH = { userId: "u-ada", role: "ADMIN" as const, name: "Ada", email: "ada@x.co" };

const EMPLOYEE = { id: "u-theo", name: "Theo Vance", email: "theo@x.co", deletedAt: null };
const HOUSING_TYPE = {
  id: "lt-housing",
  name: "Housing",
  interestRate: 0.05,
  maxAmount: 20_000,
  maxTermMonths: 60,
  isActive: true,
};

function loanRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "loan-1",
    employeeId: "u-theo",
    loanTypeId: "lt-housing",
    principal: 6_000,
    interestRate: 0.05,
    termMonths: 6,
    startDate: new Date("2026-11-01T00:00:00.000Z"),
    status: "DRAFT",
    approvedById: null,
    approvedAt: null,
    activatedAt: null,
    closedAt: null,
    outstandingBalance: 0,
    reason: "relocation",
    createdById: "u-hr",
    createdAt: new Date("2026-11-10T00:00:00.000Z"),
    ...overrides,
  };
}

/** A schedule row for installmentNo (the amortization of loanRow at 0.05). */
function schedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "sched-1",
    loanId: "loan-1",
    installmentNo: 1,
    dueDate: new Date("2026-12-01T00:00:00.000Z"),
    principalPortion: 975.66,
    interestPortion: 25,
    totalAmount: 1_000.66,
    status: "SCHEDULED",
    paidAt: null,
    payslipId: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  requirePermissionMock.mockResolvedValue(HR_AUTH);
  db.user.findUnique.mockResolvedValue(EMPLOYEE);
  db.loanType.findUnique.mockResolvedValue(HOUSING_TYPE);
  db.loan.findUnique.mockResolvedValue(loanRow());
  db.loan.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: "loan-1", ...data,
  }));
  db.loan.updateMany.mockResolvedValue({ count: 1 });
  db.loanSchedule.updateMany.mockResolvedValue({ count: 1 });
  db.loanSchedule.createMany.mockResolvedValue({ count: 6 });
  db.loanSchedule.findMany.mockResolvedValue([]);
  db.loanRepayment.create.mockResolvedValue({ id: "lr-1" });
  db.payAdjustment.findMany.mockResolvedValue([]);
  db.payAdjustment.createMany.mockResolvedValue({ count: 6 });
  db.payAdjustment.updateMany.mockResolvedValue({ count: 1 });
  db.payAdjustment.count.mockResolvedValue(0);
  db.payslip.findMany.mockResolvedValue([]);
});

// ---------------------------------------------------------------------------
// createLoan
// ---------------------------------------------------------------------------

describe("createLoan", () => {
  const input = {
    employeeId: "u-theo",
    loanTypeId: "lt-housing",
    principal: 6_000,
    termMonths: 6,
    startDate: "2027-01-15",
    reason: "relocation",
  };

  it("creates a DRAFT loan with the type's rate snapshotted", async () => {
    const res = await createLoan(input);
    expect(res.ok).toBe(true);
    expect(db.loan.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        employeeId: "u-theo",
        loanTypeId: "lt-housing",
        principal: 6_000,
        interestRate: 0.05, // the snapshot, not a reference
        termMonths: 6,
        status: "DRAFT",
        outstandingBalance: 0,
        createdById: "u-hr",
      }),
    });
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "payroll.loan_created", entityType: "LOAN" }),
    );
  });

  it("refuses an unknown or soft-deleted employee", async () => {
    db.user.findUnique.mockResolvedValue({ ...EMPLOYEE, deletedAt: new Date() });
    const res = await createLoan(input);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/employee not found/i);
    expect(db.loan.create).not.toHaveBeenCalled();
  });

  it("refuses an inactive loan type", async () => {
    db.loanType.findUnique.mockResolvedValue({ ...HOUSING_TYPE, isActive: false });
    const res = await createLoan(input);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/inactive/i);
  });

  it("refuses a start date in the past", async () => {
    const res = await createLoan({ ...input, startDate: "2020-01-01" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/today or in the future/i);
  });

  it("enforces the type's amount and term caps", async () => {
    const over = await createLoan({ ...input, principal: 25_000 });
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.error).toMatch(/maximum/i);

    const long = await createLoan({ ...input, termMonths: 120 });
    expect(long.ok).toBe(false);
    if (!long.ok) expect(long.error).toMatch(/term exceeds/i);
  });
});

// ---------------------------------------------------------------------------
// The lifecycle: submit / approve / reject / cancel
// ---------------------------------------------------------------------------

describe("submitLoan", () => {
  it("flips DRAFT → PENDING_APPROVAL with the status in the WHERE clause", async () => {
    const res = await submitLoan({ loanId: "loan-1" });
    expect(res.ok).toBe(true);
    expect(db.loan.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "loan-1", status: "DRAFT" },
        data: expect.objectContaining({ status: "PENDING_APPROVAL" }),
      }),
    );
  });

  it("refuses a non-draft loan and a non-creator non-admin submitter", async () => {
    db.loan.findUnique.mockResolvedValue(loanRow({ status: "APPROVED" }));
    const res = await submitLoan({ loanId: "loan-1" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/only a draft/i);

    db.loan.findUnique.mockResolvedValue(loanRow({ createdById: "u-someone-else" }));
    requirePermissionMock.mockResolvedValue({ ...HR_AUTH, userId: "u-other-hr" });
    const res2 = await submitLoan({ loanId: "loan-1" });
    expect(res2.ok).toBe(false);
    if (!res2.ok) expect(res2.error).toMatch(/only the creator/i);
  });
});

describe("approveLoan — four-eyes", () => {
  function pending() {
    db.loan.findUnique.mockResolvedValue(loanRow({ status: "PENDING_APPROVAL", createdById: "u-hr" }));
  }

  it("an approver other than the creator (and the employee) approves, guarded", async () => {
    pending();
    requirePermissionMock.mockResolvedValue(ADMIN_AUTH);
    const res = await approveLoan({ loanId: "loan-1", note: "ok" });
    expect(res.ok).toBe(true);
    expect(db.loan.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "loan-1", status: "PENDING_APPROVAL" },
        data: expect.objectContaining({ status: "APPROVED", approvedById: "u-ada" }),
      }),
    );
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "payroll.loan_approved" }),
    );
  });

  it("the creator cannot approve their own loan", async () => {
    pending();
    const res = await approveLoan({ loanId: "loan-1" }); // HR_AUTH = the creator
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/four-eyes/i);
    expect(db.loan.updateMany).not.toHaveBeenCalled();
  });

  it("the employee the loan belongs to cannot approve it", async () => {
    pending();
    requirePermissionMock.mockResolvedValue({ ...ADMIN_AUTH, userId: "u-theo" });
    const res = await approveLoan({ loanId: "loan-1" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/four-eyes/i);
  });
});

describe("rejectLoan / cancelLoan", () => {
  it("a pending loan is rejected (four-eyes, guarded)", async () => {
    db.loan.findUnique.mockResolvedValue(loanRow({ status: "PENDING_APPROVAL", createdById: "u-hr" }));
    requirePermissionMock.mockResolvedValue(ADMIN_AUTH);
    const res = await rejectLoan({ loanId: "loan-1" });
    expect(res.ok).toBe(true);
    expect(db.loan.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "loan-1", status: "PENDING_APPROVAL" },
        data: { status: "REJECTED" },
      }),
    );
  });

  it("the creator cancels an APPROVED loan pre-activation", async () => {
    db.loan.findUnique.mockResolvedValue(loanRow({ status: "APPROVED" }));
    const res = await cancelLoan({ loanId: "loan-1" });
    expect(res.ok).toBe(true);
    expect(db.loan.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "loan-1", status: { in: ["DRAFT", "PENDING_APPROVAL", "APPROVED"] } },
        data: { status: "CANCELLED" },
      }),
    );
  });

  it("an ACTIVE loan cannot be cancelled", async () => {
    db.loan.findUnique.mockResolvedValue(loanRow({ status: "ACTIVE" }));
    const res = await cancelLoan({ loanId: "loan-1" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/cannot be cancelled/i);
  });
});

// ---------------------------------------------------------------------------
// activateLoan — the schedule + the payroll rider
// ---------------------------------------------------------------------------

describe("activateLoan", () => {
  beforeEach(() => {
    db.loan.findUnique.mockResolvedValue(loanRow({ status: "APPROVED" }));
    // The post-create read-back for the adapter rows' sourceIds.
    db.loanSchedule.findMany.mockImplementation(async ({ where }: { where?: { loanId?: string } }) =>
      where?.loanId === "loan-1"
        ? Array.from({ length: 6 }, (_, i) => ({ id: `sched-${i + 1}`, installmentNo: i + 1 }))
        : [],
    );
  });

  it("refuses before the start date", async () => {
    db.loan.findUnique.mockResolvedValue(
      loanRow({ status: "APPROVED", startDate: new Date("2099-01-01T00:00:00.000Z") }),
    );
    const res = await activateLoan({ loanId: "loan-1" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/starts 2099-01-01/i);
  });

  it("writes the schedule + the per-installment adapter rows in ONE transaction", async () => {
    const res = await activateLoan({ loanId: "loan-1" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.installments).toBe(6);

    // The guarded activation flip + the outstanding = principal.
    expect(db.loan.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "loan-1", status: "APPROVED" },
        data: expect.objectContaining({ status: "ACTIVE", outstandingBalance: 6_000 }),
      }),
    );
    // The schedule rows: 6 installments, due monthly from +1 month
    // (start 2026-11-01 → 2026-12-01 … 2027-05-01).
    const expectedDue = (i: number) => {
      const mi = 11 + i; // 0-based month of the start (Nov=10) + (i + 1)
      return new Date(Date.UTC(2026 + Math.floor(mi / 12), mi % 12, 1));
    };
    expect(db.loanSchedule.createMany).toHaveBeenCalledWith({
      data: Array.from({ length: 6 }, (_, i) =>
        expect.objectContaining({
          loanId: "loan-1",
          installmentNo: i + 1,
          dueDate: expectedDue(i),
          status: "SCHEDULED",
        }),
      ),
    });
    // The payroll rider: ONE deduction-side ONE_SHOT adapter row per
    // installment, sourceId the schedule row, period the due month.
    expect(db.payAdjustment.createMany).toHaveBeenCalledWith({
      data: Array.from({ length: 6 }, (_, i) =>
        expect.objectContaining({
          userId: "u-theo",
          sourceType: "LOAN_INSTALLMENT",
          sourceId: `sched-${i + 1}`,
          side: "DEDUCTION",
          recurrence: "ONE_SHOT",
          calcMode: "FIXED",
          period: expectedDue(i).toISOString().slice(0, 7),
        }),
      ),
    });
    // The plan's money: installment 1 = interest on the full principal
    // (6000 * 0.05/12 = 25) + the principal portion.
    const firstAdapter = (db.payAdjustment.createMany.mock.calls[0][0] as { data: Array<{ amount: number; label: string }> }).data[0];
    expect(firstAdapter.amount).toBeGreaterThan(25);
    expect(firstAdapter.label).toContain("Housing");
    expect(firstAdapter.label).toContain("installment 1 of 6");
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "payroll.loan_activated" }),
    );
  });

  it("the guarded flip refuses a concurrent second activation", async () => {
    db.loan.updateMany.mockResolvedValue({ count: 0 });
    const res = await activateLoan({ loanId: "loan-1" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/no longer approved/i);
    expect(db.loanSchedule.createMany).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// settleLoansForRunTx — the lock-time bookkeeping
// ---------------------------------------------------------------------------

describe("settleLoansForRunTx", () => {
  function consumedRun1() {
    db.payAdjustment.findMany.mockResolvedValue([
      { sourceId: "sched-1", userId: "u-theo" },
      { sourceId: "sched-2", userId: "u-theo" },
    ]);
    db.loanSchedule.findMany.mockResolvedValue([
      schedRow({ id: "sched-1", installmentNo: 1, principalPortion: 975.66, interestPortion: 25, totalAmount: 1_000.66 }),
      schedRow({ id: "sched-2", installmentNo: 2, principalPortion: 979.72, interestPortion: 20.94, totalAmount: 1_000.66, dueDate: new Date("2027-01-01T00:00:00.000Z") }),
    ]);
    db.payslip.findMany.mockResolvedValue([{ id: "ps-1", userId: "u-theo" }]);
    db.loan.findMany.mockResolvedValue([
      loanRow({ status: "ACTIVE", outstandingBalance: 6_000 }),
    ]);
    db.loanSchedule.updateMany.mockResolvedValue({ count: 1 });
  }

  it("flips the schedule PAID, writes the repayment rows, walks the balance", async () => {
    consumedRun1();
    const report = await settleLoansForRunTx("run-1");
    expect(report.settled).toBe(2);
    expect(report.closed).toBe(0);
    expect(report.skipped).toBe(0);

    // The guarded PAID flips, one per schedule row.
    expect(db.loanSchedule.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "sched-1", status: "SCHEDULED" },
        data: expect.objectContaining({ status: "PAID", payslipId: "ps-1" }),
      }),
    );
    // The repayment rows carry the principal/interest split + the payslip.
    expect(db.loanRepayment.create).toHaveBeenCalledTimes(2);
    expect(db.loanRepayment.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        loanId: "loan-1",
        payslipId: "ps-1",
        amount: 1_000.66,
        principalPaid: 975.66,
        interestPaid: 25,
        source: "PAYROLL",
      }),
    });
    // The balance walk: 6000 − (975.66 + 979.72) = 4044.62.
    expect(db.loan.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "loan-1", status: "ACTIVE" },
        data: { outstandingBalance: 4_044.62 },
      }),
    );
  });

  it("closes the loan when the balance reaches 0", async () => {
    consumedRun1();
    db.loan.findMany.mockResolvedValue([
      loanRow({ status: "ACTIVE", outstandingBalance: 1_955.38 }),
    ]);
    const report = await settleLoansForRunTx("run-1");
    expect(report.settled).toBe(2);
    expect(report.closed).toBe(1);
    expect(db.loan.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "loan-1", status: "ACTIVE" },
        data: expect.objectContaining({ status: "CLOSED", outstandingBalance: 0 }),
      }),
    );
  });

  it("is idempotent: a re-run skips already-PAID rows and writes nothing", async () => {
    consumedRun1();
    await settleLoansForRunTx("run-1");
    // The second pass: the guarded flips return zero rows (already PAID).
    db.loanSchedule.updateMany.mockResolvedValue({ count: 0 });
    const report = await settleLoansForRunTx("run-1");
    expect(report.settled).toBe(0);
    expect(report.skipped).toBe(2);
    // Still exactly the two repayment rows from the first pass.
    expect(db.loanRepayment.create).toHaveBeenCalledTimes(2);
  });

  it("a run with no consumed loan rows is a no-op", async () => {
    db.payAdjustment.findMany.mockResolvedValue([]);
    const report = await settleLoansForRunTx("run-1");
    expect(report).toEqual({ settled: 0, closed: 0, skipped: 0 });
    expect(db.loanRepayment.create).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// earlyRepayLoan
// ---------------------------------------------------------------------------

describe("earlyRepayLoan", () => {
  function activeLoan() {
    db.loan.findUnique.mockResolvedValue(loanRow({ status: "ACTIVE", outstandingBalance: 4_044.62 }));
    db.loanSchedule.findMany.mockResolvedValue([
      { id: "sched-3" }, { id: "sched-4" }, { id: "sched-5" }, { id: "sched-6" },
    ]);
  }

  it("pays the outstanding + adjustment, closes, and neutralizes the pending deductions", async () => {
    activeLoan();
    const res = await earlyRepayLoan({ loanId: "loan-1", interestAdjustment: 40, source: "MANUAL", note: "" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.total).toBe(4_084.62);

    // The repayment row: the full outstanding principal + the adjustment.
    expect(db.loanRepayment.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        loanId: "loan-1",
        amount: 4_084.62,
        principalPaid: 4_044.62,
        interestPaid: 40,
        source: "MANUAL",
      }),
    });
    // The loan closes at 0.
    expect(db.loan.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "loan-1", status: "ACTIVE" },
        data: expect.objectContaining({ status: "CLOSED", outstandingBalance: 0 }),
      }),
    );
    // The remaining installments flip PAID...
    expect(db.loanSchedule.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { loanId: "loan-1", status: "SCHEDULED" },
        data: expect.objectContaining({ status: "PAID", payslipId: null }),
      }),
    );
    // ...and their pending adapter rows are SKIPPED with a visible reason
    // (exact sourceId provenance — no future run double-charges).
    expect(db.payAdjustment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          sourceType: "LOAN_INSTALLMENT",
          sourceId: { in: ["sched-3", "sched-4", "sched-5", "sched-6"] },
          status: "PENDING",
        },
        data: expect.objectContaining({ status: "SKIPPED" }),
      }),
    );
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "payroll.loan_early_repaid" }),
    );
  });

  it("books a FINAL_SETTLEMENT payoff (the FnF offer)", async () => {
    activeLoan();
    const res = await earlyRepayLoan({ loanId: "loan-1", interestAdjustment: 0, source: "FINAL_SETTLEMENT" });
    expect(res.ok).toBe(true);
    expect(db.loanRepayment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ source: "FINAL_SETTLEMENT", principalPaid: 4_044.62 }),
      }),
    );
  });

  it("refuses when an installment was deducted but not settled yet (the double-charge guard)", async () => {
    activeLoan();
    db.payAdjustment.count.mockResolvedValue(1);
    const res = await earlyRepayLoan({ loanId: "loan-1" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/not settled yet/i);
    expect(db.loanRepayment.create).not.toHaveBeenCalled();
  });

  it("refuses a non-ACTIVE loan and a zero-outstanding loan", async () => {
    db.loan.findUnique.mockResolvedValue(loanRow({ status: "APPROVED" }));
    const res = await earlyRepayLoan({ loanId: "loan-1" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/only an active loan/i);

    db.loan.findUnique.mockResolvedValue(loanRow({ status: "ACTIVE", outstandingBalance: 0 }));
    const res2 = await earlyRepayLoan({ loanId: "loan-1" });
    expect(res2.ok).toBe(false);
    if (!res2.ok) expect(res2.error).toMatch(/nothing outstanding/i);
  });
});

// ---------------------------------------------------------------------------
// openLoansFor — the FnF receivable reader
// ---------------------------------------------------------------------------

describe("openLoansFor", () => {
  it("derives the LIVE outstanding: stored − consumed-but-unsettled installments", async () => {
    db.loan.findMany.mockResolvedValue([
      loanRow({ status: "ACTIVE", outstandingBalance: 6_000 }),
    ]);
    db.loanSchedule.findMany.mockResolvedValue([
      schedRow({ id: "sched-1", principalPortion: 975.66 }),
      schedRow({ id: "sched-2", principalPortion: 979.72, installmentNo: 2 }),
    ]);
    // Only installment 1's deduction was consumed by a run.
    db.payAdjustment.findMany.mockResolvedValue([{ sourceId: "sched-1" }]);
    db.loanType.findMany.mockResolvedValue([{ id: "lt-housing", name: "Housing" }]);

    const rows = await openLoansFor("u-theo");
    expect(rows).toHaveLength(1);
    expect(rows[0].typeName).toBe("Housing");
    expect(rows[0].outstanding).toBe(5_024.34); // 6000 − 975.66
  });

  it("no schedules (all settled) → the stored outstanding as-is", async () => {
    db.loan.findMany.mockResolvedValue([
      loanRow({ status: "ACTIVE", outstandingBalance: 2_500 }),
    ]);
    db.loanSchedule.findMany.mockResolvedValue([]);
    db.loanType.findMany.mockResolvedValue([]);
    const rows = await openLoansFor("u-theo");
    expect(rows[0].outstanding).toBe(2_500);
  });

  it("no active loans → empty", async () => {
    db.loan.findMany.mockResolvedValue([]);
    const rows = await openLoansFor("u-theo");
    expect(rows).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getLoansOverview — the due-this-period join
// ---------------------------------------------------------------------------

describe("getLoansOverview", () => {
  it("lists active loans with the installment due in the period", async () => {
    db.loanType.findMany.mockResolvedValue([HOUSING_TYPE]);
    db.loan.findMany.mockResolvedValue([
      loanRow({ status: "ACTIVE", outstandingBalance: 4_044.62 }),
    ]);
    db.loanSchedule.findMany.mockResolvedValue([
      schedRow({ dueDate: new Date("2026-12-01T00:00:00.000Z") }),
      schedRow({ id: "sched-2", installmentNo: 2, dueDate: new Date("2027-01-01T00:00:00.000Z") }),
    ]);
    db.user.findMany.mockResolvedValue([
      { id: "u-theo", name: "Theo Vance" },
      { id: "u-hr", name: "Remy" },
    ]);

    const res = await getLoansOverview("2026-12");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.periodKey).toBe("2026-12");
    expect(res.data.loans).toHaveLength(1);
    const row = res.data.loans[0];
    expect(row.employeeName).toBe("Theo Vance");
    expect(row.dueThisPeriod).not.toBeNull();
    expect(row.dueThisPeriod?.installmentNo).toBe(1);
    expect(row.dueThisPeriod?.totalAmount).toBe(1_000.66);
  });
});
