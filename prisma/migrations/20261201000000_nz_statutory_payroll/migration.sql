-- NZ statutory payroll engine — Phase 0 (schema layer): the effective-dated
-- statutory rate sets (PAYE slabs, secondary rates, ACC levy, IETC,
-- KiwiSaver, ESCT, student loan), the per-employee tax profile (IRD
-- number, tax code, casual flag, KiwiSaver election, STC certificate
-- fields), and the two snapshot columns (PayrollRun.rateSetId,
-- Payslip.statutory JSONB). All values are seeded by
-- scripts/seed-statutory.js from IRD primary sources (FY2026-27).

-- AlterTable
ALTER TABLE "PayrollRun" ADD COLUMN     "rateSetId" TEXT NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE "Payslip" ADD COLUMN     "statutory" JSONB;

-- CreateTable
CREATE TABLE "StatutoryRateSet" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "country" TEXT NOT NULL DEFAULT 'NZ',
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),
    "isCurrent" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT NOT NULL DEFAULT '',
    "createdById" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StatutoryRateSet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StatutoryPayeTier" (
    "id" TEXT NOT NULL,
    "setId" TEXT NOT NULL,
    "fromAnnual" DOUBLE PRECISION NOT NULL,
    "toAnnual" DOUBLE PRECISION,
    "rate" DOUBLE PRECISION NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StatutoryPayeTier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StatutorySecondaryRate" (
    "id" TEXT NOT NULL,
    "setId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "rate" DOUBLE PRECISION NOT NULL,
    "label" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StatutorySecondaryRate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StatutoryAccLevy" (
    "setId" TEXT NOT NULL,
    "rate" DOUBLE PRECISION NOT NULL,
    "maxEarnings" DOUBLE PRECISION NOT NULL,
    "maxLevy" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StatutoryAccLevy_pkey" PRIMARY KEY ("setId")
);

-- CreateTable
CREATE TABLE "StatutoryIetc" (
    "setId" TEXT NOT NULL,
    "annualAmount" DOUBLE PRECISION NOT NULL,
    "lowerBound" DOUBLE PRECISION NOT NULL,
    "abateFrom" DOUBLE PRECISION NOT NULL,
    "upperBound" DOUBLE PRECISION NOT NULL,
    "abateRate" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StatutoryIetc_pkey" PRIMARY KEY ("setId")
);

-- CreateTable
CREATE TABLE "StatutoryKiwiSaver" (
    "setId" TEXT NOT NULL,
    "defaultEmployeeRate" DOUBLE PRECISION NOT NULL,
    "allowedEmployeeRates" JSONB NOT NULL,
    "employerRate" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StatutoryKiwiSaver_pkey" PRIMARY KEY ("setId")
);

-- CreateTable
CREATE TABLE "StatutoryEsctTier" (
    "id" TEXT NOT NULL,
    "setId" TEXT NOT NULL,
    "fromAnnual" DOUBLE PRECISION NOT NULL,
    "toAnnual" DOUBLE PRECISION,
    "rate" DOUBLE PRECISION NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StatutoryEsctTier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StatutoryStudentLoan" (
    "setId" TEXT NOT NULL,
    "rate" DOUBLE PRECISION NOT NULL,
    "annualThreshold" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StatutoryStudentLoan_pkey" PRIMARY KEY ("setId")
);

-- CreateTable
CREATE TABLE "EmployeeTaxProfile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "irdNumber" TEXT NOT NULL DEFAULT '',
    "taxCode" TEXT NOT NULL DEFAULT 'M',
    "isCasual" BOOLEAN NOT NULL DEFAULT false,
    "kiwiSaverStatus" TEXT NOT NULL DEFAULT 'ACTIVE',
    "kiwiSaverRate" DECIMAL(6,4),
    "employerKiwiSaverRate" DECIMAL(6,4),
    "taxCodeSpecialRate" DECIMAL(6,4),
    "stcAccTreatment" TEXT DEFAULT 'INC',
    "stcStudentLoanRate" DECIMAL(6,4),
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT NOT NULL DEFAULT '',
    "createdById" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmployeeTaxProfile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StatutoryRateSet_label_key" ON "StatutoryRateSet"("label");

-- CreateIndex
CREATE INDEX "StatutoryRateSet_effectiveFrom_idx" ON "StatutoryRateSet"("effectiveFrom");

-- CreateIndex
CREATE INDEX "StatutoryPayeTier_setId_idx" ON "StatutoryPayeTier"("setId");

-- CreateIndex
CREATE UNIQUE INDEX "StatutoryPayeTier_setId_fromAnnual_key" ON "StatutoryPayeTier"("setId", "fromAnnual");

-- CreateIndex
CREATE INDEX "StatutorySecondaryRate_setId_idx" ON "StatutorySecondaryRate"("setId");

-- CreateIndex
CREATE UNIQUE INDEX "StatutorySecondaryRate_setId_code_key" ON "StatutorySecondaryRate"("setId", "code");

-- CreateIndex
CREATE INDEX "StatutoryEsctTier_setId_idx" ON "StatutoryEsctTier"("setId");

-- CreateIndex
CREATE UNIQUE INDEX "StatutoryEsctTier_setId_fromAnnual_key" ON "StatutoryEsctTier"("setId", "fromAnnual");

-- CreateIndex
CREATE UNIQUE INDEX "EmployeeTaxProfile_userId_key" ON "EmployeeTaxProfile"("userId");

-- AddForeignKey
ALTER TABLE "StatutoryPayeTier" ADD CONSTRAINT "StatutoryPayeTier_setId_fkey" FOREIGN KEY ("setId") REFERENCES "StatutoryRateSet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StatutorySecondaryRate" ADD CONSTRAINT "StatutorySecondaryRate_setId_fkey" FOREIGN KEY ("setId") REFERENCES "StatutoryRateSet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StatutoryAccLevy" ADD CONSTRAINT "StatutoryAccLevy_setId_fkey" FOREIGN KEY ("setId") REFERENCES "StatutoryRateSet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StatutoryIetc" ADD CONSTRAINT "StatutoryIetc_setId_fkey" FOREIGN KEY ("setId") REFERENCES "StatutoryRateSet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StatutoryKiwiSaver" ADD CONSTRAINT "StatutoryKiwiSaver_setId_fkey" FOREIGN KEY ("setId") REFERENCES "StatutoryRateSet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StatutoryEsctTier" ADD CONSTRAINT "StatutoryEsctTier_setId_fkey" FOREIGN KEY ("setId") REFERENCES "StatutoryRateSet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StatutoryStudentLoan" ADD CONSTRAINT "StatutoryStudentLoan_setId_fkey" FOREIGN KEY ("setId") REFERENCES "StatutoryRateSet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

