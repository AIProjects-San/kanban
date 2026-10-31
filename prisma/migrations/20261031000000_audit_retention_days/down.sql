-- Down migration for 20261031000000_audit_retention_days
-- Reverses: ADD COLUMN auditRetentionDays on Workspace
--
-- ⚠️ DATA LOSS: drops the auditRetentionDays column. The prune job will
-- fall back to reading auditLogLimit (the old, buggy behaviour) — do NOT
-- run this in production without coordinating with the on-call team.
--
-- Apply with: psql "$DATABASE_URL" -f down.sql

ALTER TABLE "Workspace" DROP COLUMN IF EXISTS "auditRetentionDays";
