-- Down migration for 20261107000000_qa3_department_default
-- Reverses: department default '' -> 'ENGINEERING'.
--
-- NOTE: rows created while the default was '' keep their '' value; this
-- only restores the old default for future inserts.
--
-- Apply with: psql "$DATABASE_URL" -f down.sql

ALTER TABLE "EmployeeProfile" ALTER COLUMN "department" SET DEFAULT 'ENGINEERING';
