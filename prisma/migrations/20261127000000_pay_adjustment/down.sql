-- P1 down: drop the adapter table. Reversibility note (ADR-008): consumed
-- adjustment rows are provenance (which special flow paid what) — dropping
-- the table loses that audit trail but every stored payslip line is a
-- snapshot and survives intact.

DROP INDEX IF EXISTS "PayAdjustment_userId_status_idx";
DROP INDEX IF EXISTS "PayAdjustment_period_status_idx";
DROP TABLE IF EXISTS "PayAdjustment";
