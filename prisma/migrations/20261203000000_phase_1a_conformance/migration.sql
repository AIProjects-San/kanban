-- Phase 1A conformance — the original plan's schema vocabulary lands as a
-- compatible superset of the shipped Phase 0-4 schema:
--   • TaxYear registry + PayrollRun.taxYearId (YTD by NZ tax year)
--   • EmployeeTaxProfile: kiwiSaverRate → kiwiSaverEmployeeRate and
--     employerKiwiSaverRate → kiwiSaverEmployerRate (renames), plus
--     studentLoan / taxCodeSource / autoEnrolExemption / autoEnrolDueDate
--   • Payslip: the statutory snapshot's key facts as real columns
--     (taxCodeApplied, statutoryRuleVersion, employerKiwiSaverGross /
--     employerEsct / employerKiwiSaverNet) for SQL-level aggregation
-- The StatutoryRateSet → StatutoryRule and StatutoryPayeTier → TaxSlab
-- model renames are @@map-only (table names unchanged): no DDL needed.

-- CreateTable
CREATE TABLE "TaxYear" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "isCurrent" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaxYear_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TaxYear_label_key" ON "TaxYear"("label");

-- AlterTable
ALTER TABLE "EmployeeTaxProfile" RENAME COLUMN "kiwiSaverRate" TO "kiwiSaverEmployeeRate";

-- AlterTable
ALTER TABLE "EmployeeTaxProfile" RENAME COLUMN "employerKiwiSaverRate" TO "kiwiSaverEmployerRate";

-- AlterTable
ALTER TABLE "EmployeeTaxProfile" ADD COLUMN     "studentLoan" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "taxCodeSource" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "autoEnrolExemption" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "autoEnrolDueDate" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "PayrollRun" ADD COLUMN     "taxYearId" TEXT NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE "Payslip" ADD COLUMN     "taxCodeApplied" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "statutoryRuleVersion" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "employerKiwiSaverGross" DECIMAL(12,2),
ADD COLUMN     "employerEsct" DECIMAL(12,2),
ADD COLUMN     "employerKiwiSaverNet" DECIMAL(12,2);
