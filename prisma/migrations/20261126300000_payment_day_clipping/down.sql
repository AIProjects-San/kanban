-- PR-B06 down: drop the paid-days snapshot. Reversibility note (ADR-008):
-- dropping the column loses the window snapshot; the stored earnings
-- lines/gross/net survive as the amounts actually paid (they were scaled
-- at creation). Re-adding recomputes future slips only.

ALTER TABLE "Payslip" DROP COLUMN "paidDays";
