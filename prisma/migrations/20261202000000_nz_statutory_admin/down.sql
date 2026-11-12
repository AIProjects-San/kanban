-- Phase 3 down: drop the tax-mapping, slab and profile columns. The
-- Phase 3 engine vocabulary (kiwiSaverStatus "NOT_ENROLLED") lives in the
-- existing String column, so no down-migration is needed for it — rows
-- holding it should be re-pointed BEFORE running this (they would compute
-- as unknown elections on the old adapter).

ALTER TABLE "EmployeeTaxProfile" DROP COLUMN IF EXISTS "employmentEndDate";
ALTER TABLE "EmployeeTaxProfile" DROP COLUMN IF EXISTS "employmentStartDate";
ALTER TABLE "EmployeeTaxProfile" DROP COLUMN IF EXISTS "casualHolidayPayInWages";
ALTER TABLE "EmployeeTaxProfile" DROP COLUMN IF EXISTS "employmentType";
ALTER TABLE "EmployeeTaxProfile" DROP COLUMN IF EXISTS "esctRateOverride";
ALTER TABLE "EmployeeTaxProfile" DROP COLUMN IF EXISTS "taxCodeEffectiveFrom";
ALTER TABLE "EmployeeTaxProfile" DROP COLUMN IF EXISTS "stcCertificateExpiry";

ALTER TABLE "SalaryComponent" DROP COLUMN IF EXISTS "isSystemGenerated";
ALTER TABLE "SalaryComponent" DROP COLUMN IF EXISTS "wageBaseRef";
ALTER TABLE "SalaryComponent" DROP COLUMN IF EXISTS "statutoryCategory";
ALTER TABLE "SalaryComponent" DROP COLUMN IF EXISTS "taxApplicable";

ALTER TABLE "StatutorySecondaryRate" DROP COLUMN IF EXISTS "accInclusive";
