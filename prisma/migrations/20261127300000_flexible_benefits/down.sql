-- P5 down: drop the benefits tables + the structure cap. Reversibility
-- note (ADR-008): dropping the ledger loses the accrued-balance history;
-- every paid claim's adjustment row and payslip line are snapshots and
-- survive intact.

DROP INDEX IF EXISTS "BenefitAccrual_userId_year_componentCode_idx";
DROP TABLE IF EXISTS "BenefitAccrual";
DROP INDEX IF EXISTS "BenefitElection_userId_year_status_idx";
DROP INDEX IF EXISTS "BenefitElection_userId_year_componentCode_key";
DROP TABLE IF EXISTS "BenefitElection";
ALTER TABLE "SalaryStructure" DROP COLUMN "maxBenefits";
