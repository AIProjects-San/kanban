-- P39 — lossless down: the SalaryAdvance table is brand new (no rows
-- predate the migration); the PayAdjustment rows it spawned cascade only
-- through their own sourceId provenance (plain string — nothing to undo).

DROP INDEX "SalaryAdvance_status_idx";
DROP INDEX "SalaryAdvance_userId_idx";
DROP TABLE "SalaryAdvance";
