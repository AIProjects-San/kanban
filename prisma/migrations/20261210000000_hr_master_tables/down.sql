-- Down: P2.1 HR masters. Drops the document/profile links first, then the
-- master tables (the strings were never dropped, so the pre-P2.1 world is
-- exactly what remains).

ALTER TABLE "EmployeeTransfer" DROP CONSTRAINT "EmployeeTransfer_toDepartmentId_fkey";
ALTER TABLE "EmployeeTransfer" DROP CONSTRAINT "EmployeeTransfer_fromDepartmentId_fkey";
ALTER TABLE "EmployeePromotion" DROP CONSTRAINT "EmployeePromotion_toDesignationId_fkey";
ALTER TABLE "EmployeePromotion" DROP CONSTRAINT "EmployeePromotion_fromDesignationId_fkey";
ALTER TABLE "EmployeeTransfer" DROP COLUMN "toDepartmentId";
ALTER TABLE "EmployeeTransfer" DROP COLUMN "fromDepartmentId";
ALTER TABLE "EmployeePromotion" DROP COLUMN "toDesignationId";
ALTER TABLE "EmployeePromotion" DROP COLUMN "fromDesignationId";

ALTER TABLE "EmployeeProfile" DROP CONSTRAINT "EmployeeProfile_gradeId_fkey";
ALTER TABLE "EmployeeProfile" DROP CONSTRAINT "EmployeeProfile_designationId_fkey";
ALTER TABLE "EmployeeProfile" DROP CONSTRAINT "EmployeeProfile_departmentId_fkey";
DROP INDEX "EmployeeProfile_gradeId_idx";
DROP INDEX "EmployeeProfile_designationId_idx";
DROP INDEX "EmployeeProfile_departmentId_idx";
ALTER TABLE "EmployeeProfile" DROP COLUMN "gradeId";
ALTER TABLE "EmployeeProfile" DROP COLUMN "designationId";
ALTER TABLE "EmployeeProfile" DROP COLUMN "departmentId";

DROP TABLE "Designation";
DROP TABLE "Grade";
DROP TABLE "Department";
