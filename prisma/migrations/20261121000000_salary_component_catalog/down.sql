-- F1.5 down: drop the catalog (ADR-008 discipline).
-- Reversibility notes:
--   • Structures (and offers/templates) keep their component JSON snapshots —
--     the catalog was never a runtime dependency of payslip math, only the
--     picker's source. Dropping it changes no stored number.
--   • Catalog rows edited by hand after the up (renamed labels, retired rows,
--     new codes) are lost on down; re-applying the migration re-runs the
--     deterministic backfill ('bf-cat-<code>' ids are stable for the sourced
--     rows), so down→up restores the auto-derived vocabulary but not manual
--     curation. Acceptable for a picker-convenience table.
DROP INDEX IF EXISTS "SalaryComponent_sortOrder_idx";
DROP INDEX IF EXISTS "SalaryComponent_isActive_idx";
DROP INDEX IF EXISTS "SalaryComponent_code_key";
DROP TABLE IF EXISTS "SalaryComponent";
