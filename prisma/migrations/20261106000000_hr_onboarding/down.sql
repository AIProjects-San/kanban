-- Down migration for 20261106000000_hr_onboarding
-- Reverses: CREATE TABLE OnboardingChecklist + OnboardingTask
--
-- ⚠️ DATA LOSS: destroys every onboarding checklist and its tasks.
-- Audit history for onboarding.* events lives in AuditLog and is unaffected.
--
-- Prisma doesn't run down.sql automatically; this is a manual rollback aid.
-- Apply with: psql "$DATABASE_URL" -f down.sql

DROP TABLE IF EXISTS "OnboardingTask";
DROP TABLE IF EXISTS "OnboardingChecklist";
