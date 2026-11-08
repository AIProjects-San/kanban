-- EM-B01 (S13) — the employee-number series
-- (docs/Fernly_HR_Payroll_Enhancement_Plan.md §7.1.1 residual sweep).
-- Additive nullable + unique column, then a DETERMINISTIC backfill:
-- existing profiles get EMP-0001… ordered by (createdAt, id) — the same
-- order the directory renders, so the numbers read like a sane register.
-- New profiles receive the next number at creation (hr-shared
-- nextEmployeeNumber, inside the creating transaction).

ALTER TABLE "EmployeeProfile" ADD COLUMN "employeeNumber" TEXT;
CREATE UNIQUE INDEX "EmployeeProfile_employeeNumber_key" ON "EmployeeProfile"("employeeNumber");

-- Backfill: row_number over the deterministic order, zero-padded to 4.
WITH ordered AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY "createdAt", id) AS seq
  FROM "EmployeeProfile"
)
UPDATE "EmployeeProfile" AS ep
SET "employeeNumber" = 'EMP-' || LPAD(o.seq::TEXT, 4, '0')
FROM ordered AS o
WHERE ep.id = o.id;
