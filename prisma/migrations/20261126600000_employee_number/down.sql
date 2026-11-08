-- EM-B01 down: drop the series. Reversibility note (ADR-008): dropping
-- loses the numbering (a display identity, not payroll data); re-running
-- the up re-derives the same order (createdAt, id are immutable).

DROP INDEX "EmployeeProfile_employeeNumber_key";
ALTER TABLE "EmployeeProfile" DROP COLUMN "employeeNumber";
