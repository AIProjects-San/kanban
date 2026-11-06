-- F1.4 down: reverse the provenance column and the type widenings.
-- Reversibility notes (ADR-008 discipline):
--   • DOUBLE PRECISION → INTEGER is an assignment cast in Postgres: values
--     are ROUNDED, so fractional LOP days (0.5/0.25) lose their fraction.
--     A down-migration of a period that used half-day semantics therefore
--     changes stored amounts' inputs — the honest reversal is to re-derive
--     or manually re-enter those slips after downing, not to trust the
--     rounded integers.
--   • Dropping lopSource discards provenance only; lopDays values survive.

ALTER TABLE "PayrollRun" ALTER COLUMN "workingDays" SET DATA TYPE INTEGER;
ALTER TABLE "Payslip" ALTER COLUMN "lopDays" SET DATA TYPE INTEGER;
ALTER TABLE "Payslip" DROP COLUMN "lopSource";
