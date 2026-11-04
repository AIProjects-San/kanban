-- Down migration for 20261111000000_hiring_foundation
-- Reverses: CREATE TABLE HiringStageConfig + Candidate + CandidateStage
--
-- ⚠️ DATA LOSS: destroys the hiring pipeline (candidates, stage timelines and
-- the stage template). Audit history for hiring.* events lives in AuditLog and
-- is unaffected.
--
-- Prisma doesn't run down.sql automatically; this is a manual rollback aid.
-- Apply with: psql "$DATABASE_URL" -f down.sql

DROP TABLE IF EXISTS "CandidateStage";
DROP TABLE IF EXISTS "Candidate";
DROP TABLE IF EXISTS "HiringStageConfig";
