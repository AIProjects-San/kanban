-- F1.2 down: drop the ledger (ADR-008 discipline).
-- Reversibility notes:
--   • Dropping the ledger discards the audit story only. LeaveBalance cache
--     values were never re-baselined by F1.2 — every F1.2 write KEEPS the
--     cache equal to the ledger projection (used == -ΣCONSUME etc.), so the
--     pre-F1.2 behavior (cache-as-truth) resumes with the same numbers the
--     ledger had derived. Ledger-only facts lost on down: the per-request
--     consumption story and any drift ADJUST rows (the drift itself already
--     existed in the legacy cache).
--   • Re-applying the migration re-runs the backfill deterministically
--     ('bf-<kind>-<row id>' ids are stable), so down→up is idempotent for
--     rows written by the backfill. Ledger rows written by LIVE F1.2
--     actions (approve/cancel after the up) are not regenerated — their
--     effect survives in the cache, which is what the down restores to.
DROP INDEX IF EXISTS "LeaveLedgerEntry_createdAt_idx";
DROP INDEX IF EXISTS "LeaveLedgerEntry_sourceType_sourceId_idx";
DROP INDEX IF EXISTS "LeaveLedgerEntry_userId_leaveTypeId_year_idx";
DROP TABLE IF EXISTS "LeaveLedgerEntry";
