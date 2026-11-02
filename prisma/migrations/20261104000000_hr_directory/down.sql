-- Down migration for 20261104000000_hr_directory
-- Reverses: CREATE TABLE EmployeeProfile
--
-- ⚠️ DATA LOSS: destroys every employee profile (job data, contacts, skills).
--
-- Prisma doesn't run down.sql automatically; this is a manual rollback aid.
-- Apply with: psql "$DATABASE_URL" -f down.sql

DROP TABLE IF EXISTS "EmployeeProfile";
