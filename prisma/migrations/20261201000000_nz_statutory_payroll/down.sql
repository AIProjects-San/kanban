-- Down: drop the NZ statutory engine Phase 0 schema. All additions are new
-- tables plus two additive columns; rate-set rows are SUPER_ADMIN master
-- data (reseedable via scripts/seed-statutory.js) and EmployeeTaxProfile
-- rows are per-user elections (re-enterable), so nothing irreplaceable is
-- destroyed.

ALTER TABLE "StatutoryStudentLoan" DROP CONSTRAINT "StatutoryStudentLoan_setId_fkey";
ALTER TABLE "StatutoryEsctTier" DROP CONSTRAINT "StatutoryEsctTier_setId_fkey";
ALTER TABLE "StatutoryKiwiSaver" DROP CONSTRAINT "StatutoryKiwiSaver_setId_fkey";
ALTER TABLE "StatutoryIetc" DROP CONSTRAINT "StatutoryIetc_setId_fkey";
ALTER TABLE "StatutoryAccLevy" DROP CONSTRAINT "StatutoryAccLevy_setId_fkey";
ALTER TABLE "StatutorySecondaryRate" DROP CONSTRAINT "StatutorySecondaryRate_setId_fkey";
ALTER TABLE "StatutoryPayeTier" DROP CONSTRAINT "StatutoryPayeTier_setId_fkey";

DROP TABLE "EmployeeTaxProfile";
DROP TABLE "StatutoryStudentLoan";
DROP TABLE "StatutoryEsctTier";
DROP TABLE "StatutoryKiwiSaver";
DROP TABLE "StatutoryIetc";
DROP TABLE "StatutoryAccLevy";
DROP TABLE "StatutorySecondaryRate";
DROP TABLE "StatutoryPayeTier";
DROP TABLE "StatutoryRateSet";

ALTER TABLE "Payslip" DROP COLUMN "statutory";
ALTER TABLE "PayrollRun" DROP COLUMN "rateSetId";
