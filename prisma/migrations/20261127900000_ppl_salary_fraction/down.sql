-- Down: drop the P15 columns. Both are additive reads (salaryFraction
-- defaults back to fully-paid; lopDetail is display-only), so the drop is
-- lossless for every pre-P15 behavior.

ALTER TABLE "Payslip" DROP COLUMN "lopDetail";
ALTER TABLE "LeaveType" DROP COLUMN "salaryFraction";
