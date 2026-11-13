-- Phase 2 (payday filing) — IRD Employment Information (EI) file upload:
-- the payday itself (PayrollRun.payDate), the employer filing identity
-- (PayrollSettings singleton), the filing state machine (PaydayFiling +
-- PaydayFilingLine), Employee Details notifications
-- (EmployeeDetailsFiling) and EIA2 amendments (PaydayAmendmentFiling).

-- Step 1 — add the payDate column as nullable first, so the backfill can
-- run before the NOT NULL constraint lands (ADR-018 documents the
-- assumption: payDate = COALESCE(endDate, startDate, createdAt) — the pay
-- period's end is the best available proxy for legacy rows).
ALTER TABLE "PayrollRun" ADD COLUMN "payDate" TIMESTAMP(3);

UPDATE "PayrollRun"
SET "payDate" = COALESCE("endDate", "startDate", "createdAt");

ALTER TABLE "PayrollRun" ALTER COLUMN "payDate" SET NOT NULL;

-- CreateTable
CREATE TABLE "PayrollSettings" (
    "id" TEXT NOT NULL,
    "employerIrdNumber" TEXT NOT NULL,
    "employerName" TEXT NOT NULL,
    "payeIntermediaryIrd" TEXT,
    "payrollContactName" TEXT NOT NULL,
    "payrollContactPhone" TEXT NOT NULL,
    "payrollContactEmail" TEXT NOT NULL,
    "payrollPackageIdentifier" TEXT NOT NULL,
    "irFormVersionNumber" TEXT NOT NULL DEFAULT '0001',
    "nzBusinessHolidays" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayrollSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaydayFiling" (
    "id" TEXT NOT NULL,
    "employerIrd" TEXT NOT NULL,
    "payDate" TIMESTAMP(3) NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "payCycle" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "fileContent" TEXT,
    "fileHash" TEXT,
    "totalEmployeeLines" INTEGER NOT NULL DEFAULT 0,
    "totalGrossCents" INTEGER NOT NULL DEFAULT 0,
    "totalPayeCents" INTEGER NOT NULL DEFAULT 0,
    "totalKiwisaverEmployeeCents" INTEGER NOT NULL DEFAULT 0,
    "totalKiwisaverEmployerNetCents" INTEGER NOT NULL DEFAULT 0,
    "totalEsctCents" INTEGER NOT NULL DEFAULT 0,
    "totalStudentLoanCents" INTEGER NOT NULL DEFAULT 0,
    "generatedAt" TIMESTAMP(3),
    "generatedById" TEXT,
    "filedAt" TIMESTAMP(3),
    "filedById" TEXT,
    "irdReference" TEXT,
    "acceptedAt" TIMESTAMP(3),
    "rejectedAt" TIMESTAMP(3),
    "irdErrorReport" TEXT,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "overdueFlaggedAt" TIMESTAMP(3),
    "amendedByFilingId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaydayFiling_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaydayFilingLine" (
    "id" TEXT NOT NULL,
    "filingId" TEXT NOT NULL,
    "payslipId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "employeeIrd" TEXT NOT NULL,
    "employeeName" TEXT NOT NULL,
    "taxCode" TEXT NOT NULL,
    "employmentStart" TIMESTAMP(3),
    "employmentEnd" TIMESTAMP(3),
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "payCycle" TEXT NOT NULL,
    "hoursPaidCents" INTEGER NOT NULL DEFAULT 0,
    "grossCents" INTEGER NOT NULL,
    "priorGrossAdjCents" INTEGER NOT NULL DEFAULT 0,
    "notLiableAccCents" INTEGER NOT NULL DEFAULT 0,
    "lumpSumIndicator" TEXT NOT NULL DEFAULT '0',
    "payeCents" INTEGER NOT NULL,
    "priorPayeAdjCents" INTEGER NOT NULL DEFAULT 0,
    "childSupportCents" INTEGER NOT NULL DEFAULT 0,
    "childSupportCode" TEXT,
    "studentLoanCents" INTEGER NOT NULL DEFAULT 0,
    "slcirCents" INTEGER NOT NULL DEFAULT 0,
    "slborCents" INTEGER NOT NULL DEFAULT 0,
    "kiwisaverEmployeeCents" INTEGER NOT NULL DEFAULT 0,
    "kiwisaverEmployerNetCents" INTEGER NOT NULL DEFAULT 0,
    "esctCents" INTEGER NOT NULL DEFAULT 0,
    "donationsCents" INTEGER NOT NULL DEFAULT 0,
    "familyTaxCreditCents" INTEGER NOT NULL DEFAULT 0,
    "shareSchemeCents" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "PaydayFilingLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmployeeDetailsFiling" (
    "id" TEXT NOT NULL,
    "employerIrd" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "employeeIrd" TEXT NOT NULL,
    "employeeName" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'GENERATED',
    "fileContent" TEXT,
    "fileHash" TEXT,
    "generatedAt" TIMESTAMP(3),
    "generatedById" TEXT,
    "filedAt" TIMESTAMP(3),
    "filedById" TEXT,
    "acceptedAt" TIMESTAMP(3),
    "rejectedAt" TIMESTAMP(3),
    "irdErrorReport" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmployeeDetailsFiling_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaydayAmendmentFiling" (
    "id" TEXT NOT NULL,
    "originalFilingId" TEXT NOT NULL,
    "employerIrd" TEXT NOT NULL,
    "payDate" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'GENERATED',
    "fileContent" TEXT,
    "fileHash" TEXT,
    "correctionCount" INTEGER NOT NULL DEFAULT 0,
    "generatedAt" TIMESTAMP(3),
    "generatedById" TEXT,
    "filedAt" TIMESTAMP(3),
    "filedById" TEXT,
    "acceptedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaydayAmendmentFiling_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PaydayFiling_employerIrd_payDate_key" ON "PaydayFiling"("employerIrd", "payDate");

-- CreateIndex
CREATE INDEX "PaydayFiling_status_idx" ON "PaydayFiling"("status");

-- CreateIndex
CREATE INDEX "PaydayFiling_dueDate_idx" ON "PaydayFiling"("dueDate");

-- CreateIndex
CREATE UNIQUE INDEX "PaydayFilingLine_payslipId_key" ON "PaydayFilingLine"("payslipId");

-- CreateIndex
CREATE INDEX "PaydayFilingLine_filingId_idx" ON "PaydayFilingLine"("filingId");

-- AddForeignKey
ALTER TABLE "PaydayFilingLine" ADD CONSTRAINT "PaydayFilingLine_filingId_fkey" FOREIGN KEY ("filingId") REFERENCES "PaydayFiling"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateIndex
CREATE UNIQUE INDEX "EmployeeDetailsFiling_employeeId_kind_key" ON "EmployeeDetailsFiling"("employeeId", "kind");

-- CreateIndex
CREATE INDEX "EmployeeDetailsFiling_status_idx" ON "EmployeeDetailsFiling"("status");

-- CreateIndex
CREATE INDEX "PaydayAmendmentFiling_originalFilingId_idx" ON "PaydayAmendmentFiling"("originalFilingId");

-- CreateIndex
CREATE INDEX "PaydayAmendmentFiling_status_idx" ON "PaydayAmendmentFiling"("status");
