-- NZ statutory payroll engine — Phase 3 (super-admin admin UI):
-- Task 3.1: StatutorySecondaryRate.accInclusive (combined-rate rows).
-- Task 3.3: SalaryComponent tax mapping (taxApplicable /
--   statutoryCategory / wageBaseRef / isSystemGenerated).
-- Task 3.4-r1: EmployeeTaxProfile Section A/C fields (taxCodeEffectiveFrom,
--   stcCertificateExpiry, esctRateOverride, employmentType,
--   casualHolidayPayInWages, employmentStartDate / EndDate).

-- AlterTable
ALTER TABLE "StatutorySecondaryRate" ADD COLUMN     "accInclusive" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "SalaryComponent" ADD COLUMN     "taxApplicable" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "statutoryCategory" TEXT NOT NULL DEFAULT 'TAXABLE_EARNING',
ADD COLUMN     "wageBaseRef" TEXT NOT NULL DEFAULT 'GROSS',
ADD COLUMN     "isSystemGenerated" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "EmployeeTaxProfile" ADD COLUMN     "taxCodeEffectiveFrom" TIMESTAMP(3),
ADD COLUMN     "stcCertificateExpiry" TIMESTAMP(3),
ADD COLUMN     "esctRateOverride" DECIMAL(6,4),
ADD COLUMN     "employmentType" TEXT,
ADD COLUMN     "casualHolidayPayInWages" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "employmentStartDate" TIMESTAMP(3),
ADD COLUMN     "employmentEndDate" TIMESTAMP(3);

-- Backfill (Task 3.3): every pre-Phase-3 catalog row was seeded by the
-- system (the demo workspace catalog) — the mapping editor treats them as
-- read-only. The category/base defaults follow the row's kind so existing
-- data lands on the semantics the engine expects.
UPDATE "SalaryComponent" SET "isSystemGenerated" = true;
UPDATE "SalaryComponent" SET "statutoryCategory" = 'POST_TAX_DEDUCTION', "wageBaseRef" = 'NONE', "taxApplicable" = false WHERE "kind" = 'DEDUCTION';
UPDATE "SalaryComponent" SET "statutoryCategory" = 'EMPLOYER_CONTRIBUTION', "wageBaseRef" = 'NONE', "taxApplicable" = false WHERE "kind" = 'EMPLOYER_CONTRIBUTION';
UPDATE "SalaryComponent" SET "statutoryCategory" = 'STATISTICAL', "wageBaseRef" = 'NONE', "taxApplicable" = false WHERE "kind" = 'STATISTICAL';
