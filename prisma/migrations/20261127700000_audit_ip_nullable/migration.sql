-- CI repair — align the AuditLog ip/UA columns with schema.prisma.
--
-- 20261101000000_audit_ip_useragent created them as TEXT NOT NULL DEFAULT ''
-- while schema.prisma declares `ipAddress String?` / `userAgent String?`.
-- Latent drift, invisible in the sandbox (db push derives from schema.prisma
-- → nullable columns) and harmless to logAudit (it omits the keys when the
-- request context has no IP/UA, or passes a string when it does — it never
-- writes null), but `prisma migrate deploy` databases differ from `db push`
-- databases and any future Prisma write of an explicit null would fail on
-- the NOT NULL side. Follow-up migration (the original is already applied on
-- real Postgres databases, so it must not be edited in place): drop both the
-- NOT NULL constraint and the default so the migration history produces
-- exactly what db push produces.

ALTER TABLE "AuditLog" ALTER COLUMN "ipAddress" DROP NOT NULL;
ALTER TABLE "AuditLog" ALTER COLUMN "ipAddress" DROP DEFAULT;
ALTER TABLE "AuditLog" ALTER COLUMN "userAgent" DROP NOT NULL;
ALTER TABLE "AuditLog" ALTER COLUMN "userAgent" DROP DEFAULT;
