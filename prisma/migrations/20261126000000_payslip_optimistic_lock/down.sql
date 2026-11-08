-- F-R2 down: drop the optimistic-lock column. Reversibility note (ADR-008):
-- dropping version only loses the edit counter (a concurrency guard, not
-- payroll data); earnings/deductions/gross/net/lopDays all survive.

ALTER TABLE "Payslip" DROP COLUMN "version";
