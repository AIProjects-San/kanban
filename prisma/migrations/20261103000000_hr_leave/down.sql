-- Down migration for 20261103000000_hr_leave
-- Reverses: CREATE TABLE LeaveType / LeavePolicy / LeaveRequest / LeaveBalance
--
-- ⚠️ DATA LOSS: destroys every leave request and balance. Audit history for
-- leave.* events lives in AuditLog and is unaffected.
--
-- Prisma doesn't run down.sql automatically; this is a manual rollback aid.
-- Apply with: psql "$DATABASE_URL" -f down.sql

DROP TABLE IF EXISTS "LeaveBalance";
DROP TABLE IF EXISTS "LeaveRequest";
DROP TABLE IF EXISTS "LeavePolicy";
DROP TABLE IF EXISTS "LeaveType";
