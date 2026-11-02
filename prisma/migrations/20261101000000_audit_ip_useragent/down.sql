-- Down migration for 20261101000000_audit_ip_useragent
-- Reverses: ADD COLUMN ipAddress + userAgent on AuditLog
--
-- Dropping these columns loses the source IP + user agent for every audit
-- event captured after the migration was applied. The audit trail itself
-- (actor, action, entity, detail) is unaffected.
--
-- Apply with: psql "$DATABASE_URL" -f down.sql

ALTER TABLE "AuditLog" DROP COLUMN IF EXISTS "ipAddress";
ALTER TABLE "AuditLog" DROP COLUMN IF EXISTS "userAgent";
