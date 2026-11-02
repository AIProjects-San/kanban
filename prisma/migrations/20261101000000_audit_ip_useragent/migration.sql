-- P1 (production-readiness re-audit) — audit log source IP + user agent.
--
-- Two new nullable columns on AuditLog so post-incident forensics can tie an
-- audit event to a source network + browser. Both default to empty string
-- (NOT NULL with a default) so existing INSERT statements that don't set
-- them keep working without modification; the application reads them from
-- `headers()` and passes them through `logAudit`.
--
-- Additive only — no data loss, no rewrite. Safe to apply on a running
-- database (Postgres takes an ACCESS EXCLUSIVE lock for ~ms on a default
-- add; the audit table can have millions of rows without blocking).

ALTER TABLE "AuditLog" ADD COLUMN "ipAddress" TEXT NOT NULL DEFAULT '';
ALTER TABLE "AuditLog" ADD COLUMN "userAgent" TEXT NOT NULL DEFAULT '';
