-- G3 — full loan management: the approval-gated, amortized employee
-- loans with installment recovery through the PayAdjustment adapter.
--
-- Architecture (the P39 salary-advance precedent, per the schema's own
-- roadmap note — "loans proper" ride the same adapter):
--   • ACTIVATION writes the LoanSchedule rows + ONE DEDUCTION-side
--     ONE_SHOT PayAdjustment row per installment (sourceType
--     LOAN_INSTALLMENT, sourceId the schedule row, period the due
--     month). The payroll run consumes those rows generically inside its
--     own creation transaction — createPayrollRun carries no loan code.
--   • The loan bookkeeping (schedule PAID flips + LoanRepayment rows +
--     the outstandingBalance walk + the CLOSED flip) is the settlement
--     writer's job, driven by the adapter rows' consumedRunId back-link
--     (the encashment PAID precedent at run lock).
--
-- Spec adaptations (also recorded in the G3 report):
--   • money columns are DOUBLE PRECISION (Float), not DECIMAL — the codebase's money
--     convention (PayAdjustment.amount and every payroll kernel are
--     float + round2; the amortization is cent-exact by construction:
--     the LAST installment absorbs the rounding remainder);
--   • Loan.status starts at DRAFT (the spec's own flow diagram and test
--     list begin there: DRAFT → PENDING_APPROVAL → APPROVED → ACTIVE).

-- CreateTable
CREATE TABLE "LoanType" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "interestRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "maxAmount" DOUBLE PRECISION,
    "maxTermMonths" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LoanType_name_key" UNIQUE ("name")
);

-- CreateTable
CREATE TABLE "Loan" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "employeeId" TEXT NOT NULL,
    "loanTypeId" TEXT NOT NULL,
    "principal" DOUBLE PRECISION NOT NULL,
    "interestRate" DOUBLE PRECISION NOT NULL,
    "termMonths" INTEGER NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "activatedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "outstandingBalance" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "reason" TEXT NOT NULL DEFAULT '',
    "createdById" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Loan_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Loan_loanTypeId_fkey" FOREIGN KEY ("loanTypeId") REFERENCES "LoanType"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "LoanSchedule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "loanId" TEXT NOT NULL,
    "installmentNo" INTEGER NOT NULL,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "principalPortion" DOUBLE PRECISION NOT NULL,
    "interestPortion" DOUBLE PRECISION NOT NULL,
    "totalAmount" DOUBLE PRECISION NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SCHEDULED',
    "paidAt" TIMESTAMP(3),
    "payslipId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LoanSchedule_loanId_fkey" FOREIGN KEY ("loanId") REFERENCES "Loan"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "LoanRepayment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "loanId" TEXT NOT NULL,
    "payslipId" TEXT,
    "amount" DOUBLE PRECISION NOT NULL,
    "principalPaid" DOUBLE PRECISION NOT NULL,
    "interestPaid" DOUBLE PRECISION NOT NULL,
    "paidAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" TEXT NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoanRepayment_loanId_fkey" FOREIGN KEY ("loanId") REFERENCES "Loan"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "Loan_employeeId_idx" ON "Loan"("employeeId");
CREATE INDEX "Loan_status_idx" ON "Loan"("status");
CREATE UNIQUE INDEX "LoanSchedule_loanId_installmentNo_key" ON "LoanSchedule"("loanId", "installmentNo");
CREATE INDEX "LoanSchedule_loanId_status_idx" ON "LoanSchedule"("loanId", "status");
CREATE INDEX "LoanRepayment_loanId_idx" ON "LoanRepayment"("loanId");
