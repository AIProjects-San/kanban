-- P36 — lossless down: scope was additive with the CANDIDATE default
-- (every pre-P36 row keeps its meaning), and the EmployeeDocument table is
-- brand new (no rows predate the migration).

DROP INDEX "EmployeeDocument_status_idx";
DROP INDEX "EmployeeDocument_userId_idx";
DROP INDEX "EmployeeDocument_userId_docTypeKey_key";
DROP TABLE "EmployeeDocument";
DROP INDEX "DocumentTypeConfig_scope_idx";
ALTER TABLE "DocumentTypeConfig" DROP COLUMN "scope";
