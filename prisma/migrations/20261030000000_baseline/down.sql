-- Down migration for 20261030000000_baseline
--
-- The baseline migration creates the entire schema (every table, index, FK).
-- A meaningful down.sql would be `DROP SCHEMA public CASCADE; CREATE SCHEMA public;`
-- which is almost never what you want in production.
--
-- If you genuinely need to roll back the baseline, coordinate with the
-- on-call team and use `prisma migrate reset` (which drops + recreates
-- everything) instead of running a hand-written down.sql.
--
-- This file exists so the convention (every migration has a companion
-- down.sql) holds, but it intentionally does NOT contain destructive DDL.

-- No-op. See header comment.
SELECT 1;
