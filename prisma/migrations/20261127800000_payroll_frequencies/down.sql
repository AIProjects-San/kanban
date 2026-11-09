-- Down: drop the P10 cadence columns. The backfilled window dates are
-- re-derivable from `period` (monthly keys), so nothing is lost.

ALTER TABLE "PayrollRun" DROP COLUMN "endDate";
ALTER TABLE "PayrollRun" DROP COLUMN "startDate";
ALTER TABLE "PayrollRun" DROP COLUMN "frequency";
ALTER TABLE "SalaryStructure" DROP COLUMN "frequency";
