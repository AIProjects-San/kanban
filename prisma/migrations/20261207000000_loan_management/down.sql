-- G3 — lossless down: all four tables are brand new (no rows predate the
-- migration). The PayAdjustment rows a loan spawns reference it only
-- through their sourceId provenance (a plain string — nothing to undo);
-- dropping the tables leaves those rows visible-but-orphaned, the same
-- posture as the P39 advance down.

DROP INDEX "LoanRepayment_loanId_idx";
DROP INDEX "LoanSchedule_loanId_status_idx";
DROP INDEX "LoanSchedule_loanId_installmentNo_key";
DROP INDEX "Loan_status_idx";
DROP INDEX "Loan_employeeId_idx";
DROP TABLE "LoanRepayment";
DROP TABLE "LoanSchedule";
DROP TABLE "Loan";
DROP TABLE "LoanType";
