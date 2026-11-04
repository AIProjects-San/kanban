-- R7 — payroll: per-employee salary structures, monthly runs, payslips.

CREATE TABLE "SalaryStructure" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "components" TEXT NOT NULL DEFAULT '[]',
    "notes" TEXT NOT NULL DEFAULT '',
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SalaryStructure_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SalaryStructure_userId_idx" ON "SalaryStructure"("userId");
CREATE INDEX "SalaryStructure_isActive_idx" ON "SalaryStructure"("isActive");

-- One payroll run per month; OPEN → LOCKED (paid).
CREATE TABLE "PayrollRun" (
    "id" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "lockedById" TEXT NOT NULL DEFAULT '',
    "lockedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayrollRun_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PayrollRun_period_key" ON "PayrollRun"("period");
CREATE INDEX "PayrollRun_status_idx" ON "PayrollRun"("status");

-- One payslip per employee per run; lines are JSON copies.
CREATE TABLE "Payslip" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "slipNo" TEXT NOT NULL,
    "earnings" TEXT NOT NULL DEFAULT '[]',
    "deductions" TEXT NOT NULL DEFAULT '[]',
    "note" TEXT NOT NULL DEFAULT '',
    "lopDays" INTEGER NOT NULL DEFAULT 0,
    "gross" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "net" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Payslip_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Payslip_runId_userId_key" ON "Payslip"("runId", "userId");
CREATE UNIQUE INDEX "Payslip_slipNo_key" ON "Payslip"("slipNo");
CREATE INDEX "Payslip_userId_idx" ON "Payslip"("userId");

ALTER TABLE "Payslip" ADD CONSTRAINT "Payslip_runId_fkey" FOREIGN KEY ("runId") REFERENCES "PayrollRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
