-- Phase 2 (payday filing) — reverse.

-- DropTable
DROP TABLE "PaydayAmendmentFiling";
-- DropTable
DROP TABLE "EmployeeDetailsFiling";
-- DropTable
DROP TABLE "PaydayFilingLine";
-- DropTable
DROP TABLE "PaydayFiling";
-- DropTable
DROP TABLE "PayrollSettings";

-- RemoveColumn
ALTER TABLE "PayrollRun" DROP COLUMN "payDate";
