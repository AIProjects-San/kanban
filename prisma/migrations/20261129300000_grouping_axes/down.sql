-- P34 — lossless down: the three axes were additive with '' defaults
-- (unclassified), so dropping them restores the pre-P34 schema exactly.

DROP INDEX "EmployeeProfile_employmentType_idx";
ALTER TABLE "EmployeeProfile" DROP COLUMN "employmentType";
ALTER TABLE "EmployeeProfile" DROP COLUMN "branch";
ALTER TABLE "EmployeeProfile" DROP COLUMN "grade";
