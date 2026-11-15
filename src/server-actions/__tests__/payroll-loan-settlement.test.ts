import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// G3 hook — the lock-time loan settlement seam tests: lockPayrollRun calls
// settleLoansForRunTx AFTER the lock transaction commits (the same
// best-effort seam as the GL posting). The contract under test:
//   • a productive settlement audits payroll.loans_settled_for_run;
//   • a no-op settlement audits nothing;
//   • a THROWN settlement never rolls the lock back — the run stays LOCKED,
//     the failure is audited (payroll.loans_settlement_failed) + logged
//     loudly, and the action still resolves ok;
//   • the manual retry (settleLoansForRun) re-runs the real settlement core
//     against the seeded db and books the bookkeeping it missed.
// ---------------------------------------------------------------------------

const db = vi.hoisted(() => {
  const models = [
    // The lock's own reads/writes.
    "user", "payrollRun", "payslip", "payAdjustment", "leaveEncashment",
    "benefitElection", "benefitAccrual", "mailOutbox", "auditLog",
    // The settlement core's reads/writes (the retry test runs the real Tx).
    "loan", "loanSchedule", "loanRepayment", "loanType",
    // G4 — the lock-time APPROVED→LOCKED flip write.
    "timesheet",
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
  queueOutboxMail: vi.fn(),
  deliverOutboxMail: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

vi.mock("@/lib/infra/config-loader", () => ({
  getWorkspaceConfig: async () => ({ workspace: { emailPayslipsOnLock: false } }),
  bumpConfigCache: vi.fn(),
}));

// The GL posting is NOT the seam under test — resolve a journal entry so
// the loan audits below are the only failure-shaped entries in play.
vi.mock("@/lib/accounting/post-payroll-run", () => ({
  postPayrollRun: vi.fn(async () => ({ id: "je-1" })),
}));

// Partially mock the loans module: payroll.ts's import of
// settleLoansForRunTx is replaced with the controllable mock (the failure
// path), while settleLoansForRun stays the REAL action — its internal call
// binds the REAL settlement core, which runs against the mocked db above
// (the retry path).
const settleTxMock = vi.hoisted(() => vi.fn());
vi.mock("../loans", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../loans")>();
  return {
    ...orig,
    settleLoansForRunTx: (...a: unknown[]) => settleTxMock(...a),
  };
});

import { lockPayrollRun } from "../payroll";
import { settleLoansForRun } from "../loans";

const HR_AUTH = { userId: "u-hr", role: "HR" as const, name: "Remy", email: "remy@x.co" };

const OPEN_RUN = {
  id: "run-1", period: "2026-11", status: "OPEN", lockedById: "", lockedAt: null,
  createdById: "u-hr", createdAt: new Date(), updatedAt: new Date(),
};

/** A consumed LOAN_INSTALLMENT adapter row + its schedule/loan/pr payslip
 *  backing — enough for the REAL settlement core (the retry test) to book
 *  one installment and close one loan. */
const CONSUMED_ADAPTER = { sourceId: "sched-1", userId: "u-yuki" };
const SCHEDULE_ROW = {
  id: "sched-1", loanId: "loan-1", installmentNo: 6,
  dueDate: new Date("2026-11-01T00:00:00Z"),
  principalPortion: 975.66, interestPortion: 25, totalAmount: 1_000.66,
  status: "SCHEDULED", paidAt: null, payslipId: null,
};
const ACTIVE_LOAN = {
  id: "loan-1", employeeId: "u-yuki", loanTypeId: "lt-housing",
  principal: 6_000, interestRate: 0.05, termMonths: 6,
  startDate: new Date("2026-05-01T00:00:00Z"), status: "ACTIVE",
  outstandingBalance: 975.66, // exactly the final installment — closes at 0
  approvedById: "u-ada", approvedAt: new Date(), activatedAt: new Date(),
  closedAt: null, reason: "", createdById: "u-hr", createdAt: new Date(),
};

beforeEach(() => {
  vi.clearAllMocks();
  // G4 — the timesheet hook defaults: no consumable sheets, and a
  // successful guarded flip whenever one is seeded (count 1).
  db.timesheet.findMany.mockResolvedValue([]);
  db.timesheet.updateMany.mockResolvedValue({ count: 1 });
  requirePermissionMock.mockResolvedValue(HR_AUTH);
  db.payrollRun.findUnique.mockResolvedValue({
    ...OPEN_RUN,
    payslips: [{ net: 6_700 }],
  });
  db.payAdjustment.findMany.mockResolvedValue([]);
  db.benefitElection.findMany.mockResolvedValue([]);
  db.payslip.findMany.mockResolvedValue([]);
  // The settlement core defaults (the retry test tightens them).
  db.loanSchedule.findMany.mockResolvedValue([]);
  db.loan.findMany.mockResolvedValue([]);
  db.loanSchedule.updateMany.mockResolvedValue({ count: 1 });
  db.loan.updateMany.mockResolvedValue({ count: 1 });
  db.loanRepayment.create.mockResolvedValue({ id: "lr-1" });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("G3 — the lock-time loan settlement hook", () => {
  it("settles the run's loans after the lock commits and audits the counts", async () => {
    settleTxMock.mockResolvedValue({ settled: 2, closed: 1, skipped: 0 });
    const res = await lockPayrollRun({ runId: "run-1" });
    expect(res.ok).toBe(true);
    // The settlement ran for THIS run, after the lock transaction.
    expect(settleTxMock).toHaveBeenCalledWith("run-1");
    expect(db.payrollRun.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "run-1" },
        data: expect.objectContaining({ status: "LOCKED", lockedById: "u-hr" }),
      }),
    );
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({
      action: "payroll.loans_settled_for_run",
      entityType: "PAYROLL_RUN",
      entityId: "run-1",
      entityLabel: "2026-11",
      detail: expect.stringContaining("2 installments booked, 1 loan closed"),
    }));
  });

  it("audits nothing when the settlement is a no-op (no consumed installments)", async () => {
    settleTxMock.mockResolvedValue({ settled: 0, closed: 0, skipped: 0 });
    const res = await lockPayrollRun({ runId: "run-1" });
    expect(res.ok).toBe(true);
    const actions = logAuditMock.mock.calls.map((c) => (c[0] as { action: string }).action);
    expect(actions).not.toContain("payroll.loans_settled_for_run");
    expect(actions).not.toContain("payroll.loans_settlement_failed");
    // The lock itself still audited.
    expect(actions).toContain("payroll.run_locked");
  });

  it("a settlement failure does NOT roll back the committed lock — audited + logged, action still ok", async () => {
    settleTxMock.mockRejectedValue(new Error("boom: loanSchedule table is locked"));
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await lockPayrollRun({ runId: "run-1" });
    expect(res.ok).toBe(true);
    // The lock transaction COMMITTED — the run flip is not rolled back.
    expect(db.payrollRun.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "run-1" },
        data: expect.objectContaining({ status: "LOCKED" }),
      }),
    );
    // The failure audit carries the cause + the fix path.
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({
      action: "payroll.loans_settlement_failed",
      entityType: "PAYROLL_RUN",
      entityId: "run-1",
      detail: expect.stringContaining("boom: loanSchedule table is locked"),
    }));
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({
      action: "payroll.loans_settlement_failed",
      detail: expect.stringContaining("The lock itself is committed"),
    }));
    // Loud on purpose.
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("[payroll] loan settlement FAILED for run run-1"),
    );
    // The lock's own audit still lands after the failure.
    const actions = logAuditMock.mock.calls.map((c) => (c[0] as { action: string }).action);
    expect(actions).toContain("payroll.run_locked");
  });

  it("the retry action re-runs the real settlement core and books what the failed hook missed", async () => {
    // The scenario: the lock-time hook failed earlier (run already LOCKED,
    // schedule row still SCHEDULED, adapter row consumed by the run).
    db.payAdjustment.findMany.mockResolvedValue([CONSUMED_ADAPTER]);
    db.loanSchedule.findMany.mockResolvedValue([SCHEDULE_ROW]);
    db.payslip.findMany.mockResolvedValue([{ id: "ps-1", userId: "u-yuki" }]);
    db.loan.findMany.mockResolvedValue([ACTIVE_LOAN]);
    // settleLoansForRun returns the bare report (throws on a permission
    // failure) — not an ActionResult.
    const report = await settleLoansForRun("run-1");
    // One installment booked, the loan closed (balance walked to exactly 0).
    expect(report).toEqual({ settled: 1, closed: 1, skipped: 0 });
    // The guarded PAID flip + the repayment row + the CLOSED flip.
    expect(db.loanSchedule.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "sched-1", status: "SCHEDULED" },
        data: expect.objectContaining({ status: "PAID", payslipId: "ps-1" }),
      }),
    );
    expect(db.loanRepayment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          loanId: "loan-1", payslipId: "ps-1", amount: 1_000.66, source: "PAYROLL",
        }),
      }),
    );
    expect(db.loan.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "loan-1", status: "ACTIVE" },
        data: expect.objectContaining({ outstandingBalance: 0, status: "CLOSED" }),
      }),
    );
    // The manual retry audits under its own action.
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({
      action: "payroll.loan_settled",
      entityType: "LOAN",
      entityId: "run-1",
    }));
  });
});
