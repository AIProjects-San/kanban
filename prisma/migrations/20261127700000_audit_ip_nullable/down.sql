-- Down: restore the 20261101000000 shape (NOT NULL DEFAULT '').
-- Best-effort: fails if NULL rows were written while nullable — normalize
-- them to '' first if you need the down path on a populated database.

ALTER TABLE "AuditLog" ALTER COLUMN "ipAddress" SET DEFAULT '';
ALTER TABLE "AuditLog" ALTER COLUMN "ipAddress" SET NOT NULL;
ALTER TABLE "AuditLog" ALTER COLUMN "userAgent" SET DEFAULT '';
ALTER TABLE "AuditLog" ALTER COLUMN "userAgent" SET NOT NULL;
