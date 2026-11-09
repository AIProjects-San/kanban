-- P8 down: drop the withholding table + the payslip stamp. Reversibility
-- note (ADR-008): dropping SalaryWithholding loses the hold windows' audit
-- trail; WITHHELD_RELEASE adjustment rows and released payslips are
-- snapshots and survive intact. Plain slips ("") are unaffected.

ALTER TABLE "Payslip" DROP COLUMN "withholdStatus";
DROP INDEX IF EXISTS "SalaryWithholding_userId_status_idx";
DROP TABLE IF EXISTS "SalaryWithholding";
