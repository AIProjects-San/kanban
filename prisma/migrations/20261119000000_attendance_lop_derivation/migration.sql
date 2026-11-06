-- F1.4 — attendance→LOP derivation (docs/Fernly_HR_Payroll_Enhancement_Plan.md
-- §7.1). Additive column + two type widenings; no new table.
--
-- Payslip.lopSource: provenance of lopDays. AUTO (default) = derived at run
-- creation from attendance (ABSENT/HALF_DAY) + unpaid approved leave via the
-- F1.1 holiday-aware denominator; MANUAL = an HR override saved through
-- updatePayslip (audited). Existing rows keep their stored lopDays and read
-- as AUTO — honest: pre-F1.4 LOP values were HR-entered, but every existing
-- row either has lopDays 0 (nothing to attribute) or is a seeded/edited
-- showcase where AUTO-vs-MANUAL carries no behavioral difference (the value
-- is a snapshot either way; only future saves flip the flag).
--
-- Payslip.lopDays INTEGER → DOUBLE PRECISION: HALF_DAY attendance charges
-- 0.5 days (and HALF_DAY on a half-day holiday charges 0.25).
--
-- PayrollRun.workingDays INTEGER → DOUBLE PRECISION: a latent F1.1 type lie —
-- workingDaysInPeriod() already returns 0.5 fractions when the holiday
-- calendar has isHalfDay entries, but the column was declared INTEGER
-- (SQLite tolerates the dynamic type; Postgres, the canonical provider,
-- would reject the write). Widening makes the schema tell the truth.

ALTER TABLE "Payslip" ADD COLUMN "lopSource" TEXT NOT NULL DEFAULT 'AUTO',
ALTER COLUMN "lopDays" SET DEFAULT 0,
ALTER COLUMN "lopDays" SET DATA TYPE DOUBLE PRECISION;
ALTER TABLE "PayrollRun" ALTER COLUMN "workingDays" SET DEFAULT 0,
ALTER COLUMN "workingDays" SET DATA TYPE DOUBLE PRECISION;
