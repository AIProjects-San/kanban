"use server";

// ---------------------------------------------------------------------------
// G3 — the loan management server actions (lib/payroll/loans.ts owns the
// pure kernel: the status graph, the amortization, the settlement math).
//
// The document lifecycle (the G6 discipline, ADR-019):
//   create     → DRAFT             (payroll:manage — loans are money, the
//                                   salary-advance permission)
//   submit     → PENDING_APPROVAL  (the creator or an admin)
//   approve    → APPROVED          (payroll:manage + four-eyes: the
//                                   approver is neither the creator nor
//                                   the employee — spec "creator !=
//                                   approver")
//   reject     → REJECTED          (the approver, same four-eyes gate)
//   cancel     → CANCELLED         (the creator before ACTIVE; ADMIN as
//                                   the safety valve)
//   activate   → ACTIVE            (on/after the start date; ONE
//                                   transaction writes the schedule rows,
//                                   sets outstandingBalance = principal
//                                   and spawns ONE DEDUCTION-side ONE_SHOT
//                                   PayAdjustment row per installment —
//                                   the P39 salary-advance precedent, so
//                                   createPayrollRun needs no loan code)
//   (effect)   → CLOSED            (outstandingBalance reaching 0 — the
//                                   settlement or early-repayment writer)
//
// The payroll bookkeeping writer is settleLoansForRun: it flips the
// schedule rows PAID off the adapter rows' consumedRunId back-link (the
// encashment PAID precedent), writes the LoanRepayment rows, walks the
// outstanding balance and closes the loan. It is exported for the
// lock-time hook (proposed, pending review — see the G3 report) and for
// the tests; nothing in payroll.ts calls it yet.
//
// RBAC: everything here is payroll:manage (SUPER_ADMIN + ADMIN + HR — the
// same permission the salary advances and the adjustments console use).
// ---------------------------------------------------------------------------

import { revalidatePath } from "next/cache";
import { db } from "@/lib/infra/db";
import { requirePermission, AuthorizationError } from "./auth-guard";
import {
  parseOrThrow,
  loanTypeSchema,
  createLoanSchema,
  loanActionSchema,
  earlyRepayLoanSchema,
} from "@/lib/validation";
import { logAudit } from "./shared";
import { toResult } from "./result";
import type { ActionResult } from "@/lib/shared/action-result";
import type {
  LoanTypeT,
  LoanT,
  LoanDetailT,
  LoanScheduleT,
  LoanRepaymentT,
  LoansOverviewRowT,
  LoansOverviewT,
} from "@/lib/types";
import {
  amortizeLoan,
  canTransitionLoan,
  installmentsDueInPeriod,
  isCancelableLoan,
  isValidLoanInput,
  loanSummary,
  loanToday,
  LOAN_STATUS_LABELS,
  settlementPlan,
  type LoanStatus,
} from "@/lib/payroll/loans";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

interface AuthCtx {
  userId: string;
  role: string;
  name: string;
  email: string;
}

async function namesFor(userIds: Array<string | null | undefined>): Promise<Map<string, string>> {
  const ids = [...new Set(userIds.filter((x): x is string => typeof x === "string" && x.length > 0))];
  if (ids.length === 0) return new Map();
  const users = await db.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
  return new Map(users.map((u) => [u.id, u.name]));
}

interface LoanRow {
  id: string;
  employeeId: string;
  loanTypeId: string;
  principal: number;
  interestRate: number;
  termMonths: number;
  startDate: Date;
  status: string;
  approvedById: string | null;
  approvedAt: Date | null;
  activatedAt: Date | null;
  closedAt: Date | null;
  outstandingBalance: number;
  reason: string;
  createdById: string;
  createdAt: Date;
}

const LOAN_STATUSES_SET = new Set([
  "DRAFT", "PENDING_APPROVAL", "APPROVED", "ACTIVE", "CLOSED", "REJECTED", "CANCELLED",
]);

function serializeLoan(
  row: LoanRow,
  names: Map<string, string>,
  typeName: string,
): LoanT {
  const summary = loanSummary({
    principal: row.principal,
    outstandingBalance: row.outstandingBalance,
    termMonths: row.termMonths,
  });
  return {
    id: row.id,
    employeeId: row.employeeId,
    employeeName: names.get(row.employeeId) ?? "(former user)",
    typeName,
    principal: row.principal,
    interestRate: row.interestRate,
    termMonths: row.termMonths,
    startDay: row.startDate.toISOString().slice(0, 10),
    status: (LOAN_STATUSES_SET.has(row.status) ? row.status : "DRAFT") as LoanT["status"],
    outstandingBalance: row.outstandingBalance,
    reason: row.reason,
    approvedBy: row.approvedById ? names.get(row.approvedById) ?? null : null,
    approvedAt: row.approvedAt ? row.approvedAt.toISOString() : null,
    activatedAt: row.activatedAt ? row.activatedAt.toISOString() : null,
    closedAt: row.closedAt ? row.closedAt.toISOString() : null,
    createdBy: row.createdById ? names.get(row.createdById) ?? null : null,
    createdAt: row.createdAt.toISOString(),
    summary: summary.summary,
  };
}

function serializeSchedule(row: {
  id: string;
  installmentNo: number;
  dueDate: Date;
  principalPortion: number;
  interestPortion: number;
  totalAmount: number;
  status: string;
  paidAt: Date | null;
  payslipId: string | null;
}): LoanScheduleT {
  const dueDay = row.dueDate.toISOString().slice(0, 10);
  return {
    id: row.id,
    installmentNo: row.installmentNo,
    dueDay,
    duePeriod: dueDay.slice(0, 7),
    principalPortion: row.principalPortion,
    interestPortion: row.interestPortion,
    totalAmount: row.totalAmount,
    status: (["SCHEDULED", "PAID", "SKIPPED", "WRITTEN_OFF"].includes(row.status)
      ? row.status
      : "SCHEDULED") as LoanScheduleT["status"],
    paidAt: row.paidAt ? row.paidAt.toISOString() : null,
    payslipId: row.payslipId,
  };
}

function serializeRepayment(row: {
  id: string;
  amount: number;
  principalPaid: number;
  interestPaid: number;
  paidAt: Date;
  source: string;
  payslipId: string | null;
  note: string;
}): LoanRepaymentT {
  return {
    id: row.id,
    amount: row.amount,
    principalPaid: row.principalPaid,
    interestPaid: row.interestPaid,
    paidAt: row.paidAt.toISOString(),
    source: (["PAYROLL", "MANUAL", "FINAL_SETTLEMENT"].includes(row.source)
      ? row.source
      : "MANUAL") as LoanRepaymentT["source"],
    payslipId: row.payslipId,
    note: row.note,
  };
}

/** The type-name join for a set of loan rows (one query). */
async function typeNamesFor(loanTypeIds: string[]): Promise<Map<string, string>> {
  if (loanTypeIds.length === 0) return new Map();
  const types = await db.loanType.findMany({
    where: { id: { in: [...new Set(loanTypeIds)] } },
    select: { id: true, name: true },
  });
  return new Map(types.map((t) => [t.id, t.name]));
}

// ---------------------------------------------------------------------------
// Reads — loan types
// ---------------------------------------------------------------------------

export async function getLoanTypes(): Promise<ActionResult<LoanTypeT[]>> {
  return toResult(async () => {
    await requirePermission("payroll:manage");
    const rows = await db.loanType.findMany({ orderBy: { name: "asc" } });
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      interestRate: r.interestRate,
      maxAmount: r.maxAmount,
      maxTermMonths: r.maxTermMonths,
      isActive: r.isActive,
    }));
  });
}

// ---------------------------------------------------------------------------
// Reads — loans
// ---------------------------------------------------------------------------

/** One employee's loans (the employee page's list). */
export async function getEmployeeLoans(employeeId: string): Promise<ActionResult<LoanT[]>> {
  return toResult(async () => {
    await requirePermission("payroll:manage");
    const rows = await db.loan.findMany({
      where: { employeeId },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    const [names, typeNames] = await Promise.all([
      namesFor([
        ...rows.map((r) => r.employeeId),
        ...rows.map((r) => r.approvedById),
        ...rows.map((r) => r.createdById),
      ]),
      typeNamesFor(rows.map((r) => r.loanTypeId)),
    ]);
    return rows.map((r) => serializeLoan(r, names, typeNames.get(r.loanTypeId) ?? "Loan"));
  });
}

/** The loan detail: the loan + its schedule + its repayment history. */
export async function getLoanDetail(loanId: string): Promise<ActionResult<LoanDetailT>> {
  return toResult(async () => {
    await requirePermission("payroll:manage");
    const loan = await db.loan.findUnique({ where: { id: loanId } });
    if (!loan) throw new AuthorizationError("Loan not found.");
    const [schedule, repayments, type] = await Promise.all([
      db.loanSchedule.findMany({
        where: { loanId },
        orderBy: { installmentNo: "asc" },
      }),
      db.loanRepayment.findMany({
        where: { loanId },
        orderBy: { paidAt: "desc" },
        take: 200,
      }),
      db.loanType.findUnique({ where: { id: loan.loanTypeId }, select: { name: true } }),
    ]);
    const names = await namesFor([
      loan.employeeId, loan.approvedById, loan.createdById,
    ]);
    return {
      ...serializeLoan(loan, names, type?.name ?? "Loan"),
      schedule: schedule.map(serializeSchedule),
      repayments: repayments.map(serializeRepayment),
    };
  });
}

/** The payroll-admin overview: every ACTIVE loan with the installment due
 *  in the given period (default: the current month). */
export async function getLoansOverview(periodKey?: string): Promise<ActionResult<LoansOverviewT>> {
  return toResult(async () => {
    await requirePermission("payroll:manage");
    const period = periodKey && /^\d{4}-\d{2}$/.test(periodKey)
      ? periodKey
      : loanToday().slice(0, 7);
    const [types, loans] = await Promise.all([
      db.loanType.findMany({ orderBy: { name: "asc" } }),
      db.loan.findMany({
        where: { status: "ACTIVE" },
        orderBy: { outstandingBalance: "desc" },
        take: 300,
      }),
    ]);
    const [names, typeNames, schedules] = await Promise.all([
      namesFor([
        ...loans.map((r) => r.employeeId),
        ...loans.map((r) => r.approvedById),
        ...loans.map((r) => r.createdById),
      ]),
      typeNamesFor(loans.map((r) => r.loanTypeId)),
      loans.length > 0
        ? db.loanSchedule.findMany({
            where: { loanId: { in: loans.map((l) => l.id) } },
            orderBy: { installmentNo: "asc" },
          })
        : Promise.resolve([]),
    ]);
    const dueByLoan = new Map<string, LoanScheduleT>();
    for (const s of schedules) {
      const dueDay = s.dueDate.toISOString().slice(0, 10);
      if (installmentsDueInPeriod([{ dueDay, status: s.status }], period).length > 0) {
        // First due-in-period row wins (the earliest installment).
        if (!dueByLoan.has(s.loanId)) {
          dueByLoan.set(s.loanId, serializeSchedule(s));
        }
      }
    }
    const rows: LoansOverviewRowT[] = loans.map((l) => ({
      ...serializeLoan(l, names, typeNames.get(l.loanTypeId) ?? "Loan"),
      dueThisPeriod: dueByLoan.get(l.id) ?? null,
    }));
    return {
      types: types.map((t) => ({
        id: t.id, name: t.name, interestRate: t.interestRate,
        maxAmount: t.maxAmount, maxTermMonths: t.maxTermMonths, isActive: t.isActive,
      })),
      loans: rows,
      periodKey: period,
    };
  });
}

// ---------------------------------------------------------------------------
// Loan types — writers
// ---------------------------------------------------------------------------

export async function createLoanType(input: unknown): Promise<ActionResult<{ id: string }>> {
  return toResult(async () => {
    const auth = await requirePermission("payroll:manage");
    const data = parseOrThrow(loanTypeSchema, input);
    const clash = await db.loanType.findUnique({ where: { name: data.name }, select: { id: true } });
    if (clash) throw new AuthorizationError("A loan type with that name already exists.");
    const row = await db.loanType.create({ data: { ...data } });
    await logAudit({
      actor: auth,
      action: "payroll.loan_type_created",
      entityType: "LOAN_TYPE",
      entityId: row.id,
      entityLabel: data.name,
      detail: `${auth.name} created the loan type "${data.name}" — ${(data.interestRate * 100).toFixed(2)}% p.a.${data.maxAmount != null ? `, cap $${data.maxAmount.toFixed(2)}` : ""}${data.maxTermMonths != null ? `, max ${data.maxTermMonths} months` : ""}.`,
    });
    revalidatePath("/");
    return { id: row.id };
  });
}

export async function updateLoanType(input: unknown): Promise<ActionResult<void>> {
  return toResult(async () => {
    const auth = await requirePermission("payroll:manage");
    const data = parseOrThrow(loanTypeSchema, input);
    const id = (input as { id?: string }).id;
    if (!id || typeof id !== "string") throw new AuthorizationError("Pick a loan type to update.");
    const existing = await db.loanType.findUnique({ where: { id } });
    if (!existing) throw new AuthorizationError("Loan type not found.");
    const clash = await db.loanType.findUnique({ where: { name: data.name }, select: { id: true } });
    if (clash && clash.id !== id) {
      throw new AuthorizationError("Another loan type with that name already exists.");
    }
    await db.loanType.update({ where: { id }, data: { ...data } });
    await logAudit({
      actor: auth,
      action: "payroll.loan_type_updated",
      entityType: "LOAN_TYPE",
      entityId: id,
      entityLabel: data.name,
      detail: `${auth.name} updated the loan type "${data.name}" — ${(data.interestRate * 100).toFixed(2)}% p.a.${data.isActive ? "" : " (deactivated)"}.`,
    });
    revalidatePath("/");
  });
}

// ---------------------------------------------------------------------------
// Loan — create / submit / approve / reject / cancel / activate
// ---------------------------------------------------------------------------

export async function createLoan(input: unknown): Promise<ActionResult<{ id: string }>> {
  return toResult(async () => {
    const auth = await requirePermission("payroll:manage");
    const data = parseOrThrow(createLoanSchema, input);

    const employee = await db.user.findUnique({
      where: { id: data.employeeId },
      select: { id: true, name: true, deletedAt: true },
    });
    if (!employee || employee.deletedAt) throw new AuthorizationError("Employee not found.");

    const type = await db.loanType.findUnique({ where: { id: data.loanTypeId } });
    if (!type || !type.isActive) {
      throw new AuthorizationError("Loan type not found or inactive.");
    }

    // The start date must be today or in the future (activation happens
    // on/after it; a back-dated loan would skip its notice period).
    if (data.startDate < loanToday()) {
      throw new AuthorizationError("The start date must be today or in the future.");
    }

    const invalid = isValidLoanInput({
      principal: data.principal,
      termMonths: data.termMonths,
      annualRate: type.interestRate,
      maxAmount: type.maxAmount,
      maxTermMonths: type.maxTermMonths,
    });
    if (invalid) throw new AuthorizationError(invalid);

    const loan = await db.loan.create({
      data: {
        employeeId: employee.id,
        loanTypeId: type.id,
        principal: data.principal,
        // Snapshot: the type's rate may change later; this loan's math
        // never moves (the standing snapshot discipline).
        interestRate: type.interestRate,
        termMonths: data.termMonths,
        startDate: new Date(`${data.startDate}T00:00:00.000Z`),
        status: "DRAFT",
        outstandingBalance: 0,
        reason: data.reason,
        createdById: auth.userId,
      },
    });
    await logAudit({
      actor: auth,
      action: "payroll.loan_created",
      entityType: "LOAN",
      entityId: loan.id,
      entityLabel: `${employee.name} — ${type.name} $${data.principal.toFixed(2)}`,
      detail: `${auth.name} drafted a ${type.name} loan for ${employee.name} — $${data.principal.toFixed(2)} over ${data.termMonths} months at ${(type.interestRate * 100).toFixed(2)}% p.a., starting ${data.startDate}.`,
    });
    revalidatePath("/");
    return { id: loan.id };
  });
}

/** Load a loan or throw the friendly not-found. */
async function loanOrThrow(loanId: string) {
  const loan = await db.loan.findUnique({ where: { id: loanId } });
  if (!loan) throw new AuthorizationError("Loan not found.");
  return loan;
}

/** The four-eyes guard: the approver is neither the creator nor the
 *  employee the loan belongs to (spec "creator != approver", plus the
 *  belt: the employee never approves their own loan). */
function assertFourEyes(auth: AuthCtx, loan: { employeeId: string; createdById: string }): void {
  if (auth.userId === loan.createdById) {
    throw new AuthorizationError("Four-eyes rule: you cannot approve a loan you created.");
  }
  if (auth.userId === loan.employeeId) {
    throw new AuthorizationError("Four-eyes rule: the employee a loan belongs to cannot approve it.");
  }
}

export async function submitLoan(input: unknown): Promise<ActionResult<void>> {
  return toResult(async () => {
    const auth = await requirePermission("payroll:manage");
    const data = parseOrThrow(loanActionSchema, input);
    const loan = await loanOrThrow(data.loanId);
    if (auth.userId !== loan.createdById && auth.role !== "ADMIN" && auth.role !== "SUPER_ADMIN") {
      throw new AuthorizationError("Only the creator (or an admin) can submit this loan.");
    }
    if (!canTransitionLoan(loan.status, "PENDING_APPROVAL")) {
      throw new AuthorizationError(`This loan is ${LOAN_STATUS_LABELS[loan.status as LoanStatus] ?? loan.status} — only a draft can be submitted.`);
    }
    const flipped = await db.loan.updateMany({
      where: { id: loan.id, status: "DRAFT" },
      data: { status: "PENDING_APPROVAL" },
    });
    if (flipped.count === 0) {
      throw new AuthorizationError("This loan is no longer a draft — it was just submitted or cancelled elsewhere. Refresh and try again.");
    }
    const employee = await db.user.findUnique({ where: { id: loan.employeeId }, select: { name: true } });
    await logAudit({
      actor: auth,
      action: "payroll.loan_submitted",
      entityType: "LOAN",
      entityId: loan.id,
      entityLabel: `${employee?.name ?? "Employee"} — $${loan.principal.toFixed(2)}`,
      detail: `${auth.name} submitted the loan for approval.${data.note ? ` Note: ${data.note}` : ""}`,
    });
    revalidatePath("/");
  });
}

export async function approveLoan(input: unknown): Promise<ActionResult<void>> {
  return toResult(async () => {
    const auth = await requirePermission("payroll:manage");
    const data = parseOrThrow(loanActionSchema, input);
    const loan = await loanOrThrow(data.loanId);
    if (loan.status !== "PENDING_APPROVAL") {
      throw new AuthorizationError(`This loan is ${LOAN_STATUS_LABELS[loan.status as LoanStatus] ?? loan.status} — only a pending loan can be approved.`);
    }
    assertFourEyes(auth, loan);
    const flipped = await db.loan.updateMany({
      where: { id: loan.id, status: "PENDING_APPROVAL" },
      data: { status: "APPROVED", approvedById: auth.userId, approvedAt: new Date() },
    });
    if (flipped.count === 0) {
      throw new AuthorizationError("This loan is no longer pending — it was just decided elsewhere. Refresh and try again.");
    }
    const employee = await db.user.findUnique({ where: { id: loan.employeeId }, select: { name: true } });
    await logAudit({
      actor: auth,
      action: "payroll.loan_approved",
      entityType: "LOAN",
      entityId: loan.id,
      entityLabel: `${employee?.name ?? "Employee"} — $${loan.principal.toFixed(2)}`,
      detail: `${auth.name} approved the loan.${data.note ? ` Note: ${data.note}` : ""}`,
    });
    revalidatePath("/");
  });
}

export async function rejectLoan(input: unknown): Promise<ActionResult<void>> {
  return toResult(async () => {
    const auth = await requirePermission("payroll:manage");
    const data = parseOrThrow(loanActionSchema, input);
    const loan = await loanOrThrow(data.loanId);
    if (loan.status !== "PENDING_APPROVAL") {
      throw new AuthorizationError(`This loan is ${LOAN_STATUS_LABELS[loan.status as LoanStatus] ?? loan.status} — only a pending loan can be rejected.`);
    }
    assertFourEyes(auth, loan);
    const flipped = await db.loan.updateMany({
      where: { id: loan.id, status: "PENDING_APPROVAL" },
      data: { status: "REJECTED" },
    });
    if (flipped.count === 0) {
      throw new AuthorizationError("This loan is no longer pending — it was just decided elsewhere. Refresh and try again.");
    }
    const employee = await db.user.findUnique({ where: { id: loan.employeeId }, select: { name: true } });
    await logAudit({
      actor: auth,
      action: "payroll.loan_rejected",
      entityType: "LOAN",
      entityId: loan.id,
      entityLabel: `${employee?.name ?? "Employee"} — $${loan.principal.toFixed(2)}`,
      detail: `${auth.name} rejected the loan.${data.note ? ` Note: ${data.note}` : ""}`,
    });
    revalidatePath("/");
  });
}

export async function cancelLoan(input: unknown): Promise<ActionResult<void>> {
  return toResult(async () => {
    const auth = await requirePermission("payroll:manage");
    const data = parseOrThrow(loanActionSchema, input);
    const loan = await loanOrThrow(data.loanId);
    if (auth.userId !== loan.createdById && auth.role !== "ADMIN" && auth.role !== "SUPER_ADMIN") {
      throw new AuthorizationError("Only the creator (or an admin) can cancel this loan.");
    }
    if (!isCancelableLoan(loan.status)) {
      throw new AuthorizationError(`An ${LOAN_STATUS_LABELS[loan.status as LoanStatus] ?? loan.status} loan cannot be cancelled — only drafts, pending and approved loans can.`);
    }
    const flipped = await db.loan.updateMany({
      where: { id: loan.id, status: { in: ["DRAFT", "PENDING_APPROVAL", "APPROVED"] } },
      data: { status: "CANCELLED" },
    });
    if (flipped.count === 0) {
      throw new AuthorizationError("This loan was just activated or cancelled elsewhere. Refresh and try again.");
    }
    const employee = await db.user.findUnique({ where: { id: loan.employeeId }, select: { name: true } });
    await logAudit({
      actor: auth,
      action: "payroll.loan_cancelled",
      entityType: "LOAN",
      entityId: loan.id,
      entityLabel: `${employee?.name ?? "Employee"} — $${loan.principal.toFixed(2)}`,
      detail: `${auth.name} cancelled the loan.${data.note ? ` Note: ${data.note}` : ""}`,
    });
    revalidatePath("/");
  });
}

/** Activate an APPROVED loan on/after its start date: ONE transaction
 *  writes the status flip, the outstanding balance, the amortization
 *  schedule, and the per-installment PayAdjustment rows the run consumes
 *  (the P39 precedent — createPayrollRun stays loan-free). */
export async function activateLoan(input: unknown): Promise<ActionResult<{ installments: number }>> {
  return toResult(async () => {
    const auth = await requirePermission("payroll:manage");
    const data = parseOrThrow(loanActionSchema, input);
    const loan = await loanOrThrow(data.loanId);
    if (loan.status !== "APPROVED") {
      throw new AuthorizationError(`This loan is ${LOAN_STATUS_LABELS[loan.status as LoanStatus] ?? loan.status} — only an approved loan can be activated.`);
    }
    const today = loanToday();
    const startDay = loan.startDate.toISOString().slice(0, 10);
    if (today < startDay) {
      throw new AuthorizationError(`The loan starts ${startDay} — it can be activated on or after that date.`);
    }
    const type = await db.loanType.findUnique({ where: { id: loan.loanTypeId }, select: { name: true } });
    const plan = amortizeLoan({
      principal: loan.principal,
      annualRate: loan.interestRate,
      termMonths: loan.termMonths,
      startDay,
    });
    if (plan.length === 0) throw new AuthorizationError("The amortization schedule could not be built.");

    const installments = await db.$transaction(async (tx) => {
      const flipped = await tx.loan.updateMany({
        where: { id: loan.id, status: "APPROVED" },
        data: { status: "ACTIVE", activatedAt: new Date(), outstandingBalance: loan.principal },
      });
      if (flipped.count === 0) {
        throw new AuthorizationError("This loan is no longer approved — it was just activated or cancelled elsewhere. Refresh and try again.");
      }
      const scheduleRows = await tx.loanSchedule.createMany({
        data: plan.map((p) => ({
          loanId: loan.id,
          installmentNo: p.installmentNo,
          dueDate: new Date(`${p.dueDay}T00:00:00.000Z`),
          principalPortion: p.principalPortion,
          interestPortion: p.interestPortion,
          totalAmount: p.totalAmount,
          status: "SCHEDULED",
        })),
      });
      // The payroll rider: ONE DEDUCTION-side ONE_SHOT adapter row per
      // installment (sourceId = the schedule row). The run's generic
      // consumption carries the money; the settlement flips the schedule
      // PAID off the consumedRunId back-link.
      const created = await tx.loanSchedule.findMany({
        where: { loanId: loan.id },
        select: { id: true, installmentNo: true },
        orderBy: { installmentNo: "asc" },
      });
      await tx.payAdjustment.createMany({
        data: created.map((s) => {
          const p = plan[s.installmentNo - 1];
          return {
            userId: loan.employeeId,
            sourceType: "LOAN_INSTALLMENT",
            sourceId: s.id,
            label: `Loan repayment — ${type?.name ?? "Loan"} installment ${s.installmentNo} of ${plan.length}`,
            side: "DEDUCTION",
            recurrence: "ONE_SHOT",
            calcMode: "FIXED",
            amount: p.totalAmount,
            period: p.duePeriod,
            status: "PENDING",
            note: `Loan ${loan.id} activated ${today} (${loan.reason || "no reason recorded"}).`,
            createdById: auth.userId,
          };
        }),
      });
      return scheduleRows.count;
    });

    const employee = await db.user.findUnique({ where: { id: loan.employeeId }, select: { name: true } });
    await logAudit({
      actor: auth,
      action: "payroll.loan_activated",
      entityType: "LOAN",
      entityId: loan.id,
      entityLabel: `${employee?.name ?? "Employee"} — $${loan.principal.toFixed(2)}`,
      detail: `${auth.name} activated the ${type?.name ?? "loan"} for ${employee?.name ?? "the employee"} — $${loan.principal.toFixed(2)} over ${installments} installments, first due ${plan[0].dueDay}.`,
    });
    revalidatePath("/");
    return { installments };
  });
}

// ---------------------------------------------------------------------------
// Early repayment / final settlement
// ---------------------------------------------------------------------------

/** Pay off the remaining balance (optionally with an interest
 *  adjustment): ONE transaction writes the repayment row, closes the
 *  loan, marks every remaining SCHEDULED installment paid and neutralizes
 *  the still-PENDING adapter rows so no future run double-charges. */
export async function earlyRepayLoan(input: unknown): Promise<ActionResult<{ total: number }>> {
  return toResult(async () => {
    const auth = await requirePermission("payroll:manage");
    const data = parseOrThrow(earlyRepayLoanSchema, input);
    const loan = await loanOrThrow(data.loanId);
    if (loan.status !== "ACTIVE") {
      throw new AuthorizationError(`This loan is ${LOAN_STATUS_LABELS[loan.status as LoanStatus] ?? loan.status} — only an active loan can be repaid early.`);
    }
    if (!(loan.outstandingBalance > 0)) {
      throw new AuthorizationError("This loan has nothing outstanding to repay.");
    }
    // Honesty guard: installments a payroll run already DEDUCTED but the
    // settlement has not yet booked must settle FIRST — their principal
    // is still inside the stored outstanding, so paying it here would
    // charge the employee twice for the same installment.
    const scheduledRows = await db.loanSchedule.findMany({
      where: { loanId: loan.id, status: "SCHEDULED" },
      select: { id: true },
    });
    if (scheduledRows.length > 0) {
      const consumedUnsettled = await db.payAdjustment.count({
        where: {
          sourceType: "LOAN_INSTALLMENT",
          sourceId: { in: scheduledRows.map((s) => s.id) },
          status: "CONSUMED",
        },
      });
      if (consumedUnsettled > 0) {
        throw new AuthorizationError(
          `${consumedUnsettled} installment${consumedUnsettled === 1 ? " was" : "s were"} already deducted by a payroll run but not settled yet — settle the run's loans first, then repay the remainder.`,
        );
      }
    }
    const plan = settlementPlan({
      outstandingBalance: loan.outstandingBalance,
      interestAdjustment: data.interestAdjustment,
    });
    const type = await db.loanType.findUnique({ where: { id: loan.loanTypeId }, select: { name: true } });

    const settled = await db.$transaction(async (tx) => {
      // The remaining SCHEDULED installments (collected BEFORE the flip —
      // their ids are the exact provenance for neutralizing the pending
      // adapter rows below; no note-parsing).
      const remaining = await tx.loanSchedule.findMany({
        where: { loanId: loan.id, status: "SCHEDULED" },
        select: { id: true },
      });
      // They flip PAID (guarded — a concurrent settlement's flips make
      // this a zero-row no-op).
      const flipped = await tx.loanSchedule.updateMany({
        where: { loanId: loan.id, status: "SCHEDULED" },
        data: { status: "PAID", paidAt: new Date(), payslipId: null },
      });
      // The repayment row: the outstanding principal + the interest
      // adjustment (source MANUAL or FINAL_SETTLEMENT — the FnF offer).
      await tx.loanRepayment.create({
        data: {
          loanId: loan.id,
          payslipId: null,
          amount: plan.total,
          principalPaid: plan.principal,
          interestPaid: plan.interest,
          source: data.source,
          note: data.note || `Early repayment — ${flipped.count} remaining installment(s) settled, future interest ${plan.interest > 0 ? `adjusted by $${plan.interest.toFixed(2)}` : "waived"}.`,
        },
      });
      // Close the loan.
      const closed = await tx.loan.updateMany({
        where: { id: loan.id, status: "ACTIVE" },
        data: { status: "CLOSED", closedAt: new Date(), outstandingBalance: 0 },
      });
      if (closed.count === 0) {
        throw new AuthorizationError("The loan was just settled elsewhere. Refresh and try again.");
      }
      // Neutralize the still-PENDING adapter rows of those installments
      // (the unpaid future deductions) — SKIPPED with a visible reason,
      // never a silent delete; exact sourceId provenance, no note-parsing.
      if (remaining.length > 0) {
        await tx.payAdjustment.updateMany({
          where: {
            sourceType: "LOAN_INSTALLMENT",
            sourceId: { in: remaining.map((s) => s.id) },
            status: "PENDING",
          },
          data: { status: "SKIPPED", skipReason: "loan repaid early — installment settled outside payroll" },
        });
      }
      return { flipped: flipped.count, total: plan.total };
    });

    const employee = await db.user.findUnique({ where: { id: loan.employeeId }, select: { name: true } });
    await logAudit({
      actor: auth,
      action: "payroll.loan_early_repaid",
      entityType: "LOAN",
      entityId: loan.id,
      entityLabel: `${employee?.name ?? "Employee"} — $${settled.total.toFixed(2)}`,
      detail: `${auth.name} repaid the ${type?.name ?? "loan"} in full — $${plan.principal.toFixed(2)} principal${plan.interest > 0 ? ` + $${plan.interest.toFixed(2)} interest adjustment` : ""} (${data.source === "FINAL_SETTLEMENT" ? "from final settlement dues" : "direct payment"}).`,
    });
    revalidatePath("/");
    return { total: settled.total };
  });
}

// ---------------------------------------------------------------------------
// The payroll settlement (the lock-time bookkeeping writer)
// ---------------------------------------------------------------------------

export interface LoanSettlementReport {
  settled: number;
  closed: number;
  skipped: number;
}

/** The system identity the lock-time hook (and any scheduler) settles
 *  under — the CRON_ACTOR convention. */
export const LOAN_SETTLEMENT_ACTOR = {
  userId: "cron:loan-settlement",
  name: "Loan settlement pass",
  role: "SYSTEM",
};

/** Settle the loan bookkeeping for a LOCKED run: every CONSUMED
 *  LOAN_INSTALLMENT adapter row whose consumedRunId names this run flips
 *  its schedule row PAID (guarded — idempotent), writes its LoanRepayment
 *  row, walks the loan's outstanding balance and closes loans that reach
 *  0. The encashment PAID precedent, loan-shaped: driven purely by the
 *  adapter's back-link, no payroll-side coupling.
 *
 *  NOT yet wired into lockPayrollRun — the exact hook placement is
 *  pending review (the G3 report carries the proposed diff). Safe to run
 *  any time after a run locks: the guarded schedule flips make repeats
 *  no-ops. */
export async function settleLoansForRun(runId: string): Promise<LoanSettlementReport> {
  const auth = await requirePermission("payroll:manage");
  const report = await settleLoansForRunTx(runId);
  if (report.settled > 0 || report.closed > 0) {
    await logAudit({
      actor: auth,
      action: "payroll.loan_settled",
      entityType: "LOAN",
      entityId: runId,
      entityLabel: `Run ${runId}`,
      detail: `${auth.name} settled the run's loan bookkeeping — ${report.settled} installment${report.settled === 1 ? "" : "s"} booked, ${report.closed} loan${report.closed === 1 ? "" : "s"} closed${report.skipped > 0 ? `, ${report.skipped} skipped (already settled)` : ""}.`,
    });
    revalidatePath("/");
  }
  return report;
}

/** The settlement core (no permission gate, no audit — the action adds
 *  the payroll:manage gate and its audit entry; the future lock-time
 *  hook audits at its call site under LOAN_SETTLEMENT_ACTOR). */
export async function settleLoansForRunTx(runId: string): Promise<LoanSettlementReport> {
  const report: LoanSettlementReport = { settled: 0, closed: 0, skipped: 0 };
  const consumed = await db.payAdjustment.findMany({
    where: { sourceType: "LOAN_INSTALLMENT", status: "CONSUMED", consumedRunId: runId },
    select: { sourceId: true, userId: true },
  });
  if (consumed.length === 0) return report;
  const scheduleIds = consumed.map((c) => c.sourceId).filter((id) => id.length > 0);
  if (scheduleIds.length === 0) return report;
  const [schedules, payslips] = await Promise.all([
    db.loanSchedule.findMany({ where: { id: { in: scheduleIds } } }),
    db.payslip.findMany({ where: { runId }, select: { id: true, userId: true } }),
  ]);
  if (schedules.length === 0) return report;
  const payslipByUser = new Map(payslips.map((p) => [p.userId, p.id]));

  // Group by loan so the balance walk is one update per loan.
  const byLoan = new Map<string, typeof schedules>();
  for (const s of schedules) {
    const list = byLoan.get(s.loanId);
    if (list) list.push(s);
    else byLoan.set(s.loanId, [s]);
  }
  const loans = await db.loan.findMany({ where: { id: { in: [...byLoan.keys()] } } });
  const loanById = new Map(loans.map((l) => [l.id, l]));

  await db.$transaction(async (tx) => {
    const principalByLoan = new Map<string, number>();
    for (const s of schedules) {
      const loan = loanById.get(s.loanId);
      if (!loan || loan.status !== "ACTIVE") {
        report.skipped += 1;
        continue;
      }
      const payslipId = payslipByUser.get(loan.employeeId) ?? null;
      // The guarded PAID flip — the idempotency anchor (QA-16): a
      // re-settlement finds the row already PAID and skips it.
      const flipped = await tx.loanSchedule.updateMany({
        where: { id: s.id, status: "SCHEDULED" },
        data: { status: "PAID", paidAt: new Date(), payslipId },
      });
      if (flipped.count === 0) {
        report.skipped += 1;
        continue;
      }
      await tx.loanRepayment.create({
        data: {
          loanId: s.loanId,
          payslipId,
          amount: s.totalAmount,
          principalPaid: s.principalPortion,
          interestPaid: s.interestPortion,
          source: "PAYROLL",
          note: `Installment ${s.installmentNo} deducted by payroll run ${runId}.`,
        },
      });
      report.settled += 1;
      principalByLoan.set(s.loanId, (principalByLoan.get(s.loanId) ?? 0) + s.principalPortion);
    }
    // The balance walk + the CLOSED flip, one guarded update per loan.
    for (const [loanId, principalSum] of principalByLoan) {
      const loan = loanById.get(loanId);
      if (!loan) continue;
      const next = Math.max(0, Math.round((loan.outstandingBalance - principalSum) * 100) / 100);
      if (next <= 0) {
        const closed = await tx.loan.updateMany({
          where: { id: loanId, status: "ACTIVE" },
          data: { outstandingBalance: 0, status: "CLOSED", closedAt: new Date() },
        });
        if (closed.count > 0) report.closed += 1;
      } else {
        // Guarded: a concurrent close (early repayment) makes this a
        // no-op instead of resurrecting a balance on a CLOSED loan.
        await tx.loan.updateMany({
          where: { id: loanId, status: "ACTIVE" },
          data: { outstandingBalance: next },
        });
      }
    }
  });
  return report;
}

// ---------------------------------------------------------------------------
// The FnF receivable reader (hr-offboarding consumes it — the P39
// openAdvancesFor twin)
// ---------------------------------------------------------------------------

export interface FnFOpenLoan {
  id: string;
  typeName: string;
  principal: number;
  outstanding: number;
  installments: number;
}

/** The employee's ACTIVE loans as FnF receivable facts. The live
 *  outstanding respects CONSUMED-but-unsettled deductions (the stored
 *  balance walks only at settlement): outstanding = stored − the
 *  principal portions of schedule rows whose adapter row is CONSUMED but
 *  whose schedule row is still SCHEDULED. */
export async function openLoansFor(userId: string): Promise<FnFOpenLoan[]> {
  const loans = await db.loan.findMany({
    where: { employeeId: userId, status: "ACTIVE" },
    take: 50,
  });
  if (loans.length === 0) return [];
  const schedules = await db.loanSchedule.findMany({
    where: { loanId: { in: loans.map((l) => l.id) }, status: "SCHEDULED" },
    select: { id: true, loanId: true, principalPortion: true },
  });
  if (schedules.length === 0) {
    return loans.map((l) => ({
      id: l.id,
      typeName: "",
      principal: l.principal,
      outstanding: l.outstandingBalance,
      installments: l.termMonths,
    }));
  }
  const consumedAdapters = await db.payAdjustment.findMany({
    where: { sourceType: "LOAN_INSTALLMENT", sourceId: { in: schedules.map((s) => s.id) }, status: "CONSUMED" },
    select: { sourceId: true },
  });
  const consumedSourceIds = new Set(consumedAdapters.map((a) => a.sourceId));
  const unsettledPrincipalByLoan = new Map<string, number>();
  for (const s of schedules) {
    if (!consumedSourceIds.has(s.id)) continue;
    unsettledPrincipalByLoan.set(
      s.loanId,
      (unsettledPrincipalByLoan.get(s.loanId) ?? 0) + s.principalPortion,
    );
  }
  const types = await db.loanType.findMany({
    where: { id: { in: loans.map((l) => l.loanTypeId) } },
    select: { id: true, name: true },
  });
  const typeNameById = new Map(types.map((t) => [t.id, t.name]));
  return loans.map((l) => ({
    id: l.id,
    typeName: typeNameById.get(l.loanTypeId) ?? "Loan",
    principal: l.principal,
    outstanding: Math.max(
      0,
      Math.round((l.outstandingBalance - (unsettledPrincipalByLoan.get(l.id) ?? 0)) * 100) / 100,
    ),
    installments: l.termMonths,
  }));
}
