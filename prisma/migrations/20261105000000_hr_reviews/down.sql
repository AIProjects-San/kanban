-- Down migration for 20261105000000_hr_reviews
-- Reverses: CREATE TABLE PerformanceReview
--
-- ⚠️ DATA LOSS: destroys every performance review (self-assessments,
-- manager feedback, ratings). Audit history for review.* events lives in
-- AuditLog and is unaffected.
--
-- Prisma doesn't run down.sql automatically; this is a manual rollback aid.
-- Apply with: psql "$DATABASE_URL" -f down.sql

DROP TABLE IF EXISTS "PerformanceReview";
