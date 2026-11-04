-- R7 — payroll rollback.
DROP TABLE IF EXISTS "Payslip";
DROP INDEX IF EXISTS "PayrollRun_status_idx";
DROP INDEX IF EXISTS "PayrollRun_period_key";
DROP TABLE IF EXISTS "PayrollRun";
DROP INDEX IF EXISTS "SalaryStructure_isActive_idx";
DROP INDEX IF EXISTS "SalaryStructure_userId_idx";
DROP TABLE IF EXISTS "SalaryStructure";
