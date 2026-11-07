-- F1.6 down (ADR-008 discipline).
-- Reversibility notes:
--   • Dropping "employmentStatus" loses the classification itself; re-running
--     the up re-derives ACTIVE for every profile with a hireDate (the same
--     predicate), so the automated classification is restored — only statuses
--     that were set by hand afterwards (SUSPENDED / EXITED / PROBATION) are
--     lost. Acceptable: this is the first-ever lifecycle surface.
--   • probationEndsAt / noticePeriodWeeks / lastWorkingDay are plain facts
--     with no derived consumers yet (F2.1 will consume lastWorkingDay); no
--     cascade effects on rollback.
--   • Dropping PerformanceReview."kind" reverts every cycle to the STANDARD
--     default — with the status column also gone, the §9.3 gate has no
--     reader left, so the schema stays self-consistent.
DROP INDEX IF EXISTS "EmployeeProfile_employmentStatus_idx";
ALTER TABLE "EmployeeProfile" DROP COLUMN IF EXISTS "employmentStatus";
ALTER TABLE "EmployeeProfile" DROP COLUMN IF EXISTS "probationEndsAt";
ALTER TABLE "EmployeeProfile" DROP COLUMN IF EXISTS "noticePeriodWeeks";
ALTER TABLE "EmployeeProfile" DROP COLUMN IF EXISTS "lastWorkingDay";
ALTER TABLE "PerformanceReview" DROP COLUMN IF EXISTS "kind";
