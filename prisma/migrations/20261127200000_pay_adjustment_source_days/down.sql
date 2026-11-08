-- P4 down: drop the day-quantity column. Reversibility note (ADR-008):
-- losing sourceDays only loses the reversal-cap arithmetic input; the
-- credit amounts are snapshots on the rows and payslip lines.

ALTER TABLE "PayAdjustment" DROP COLUMN "sourceDays";
