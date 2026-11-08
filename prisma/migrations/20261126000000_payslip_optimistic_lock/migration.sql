-- F-R2 (S1) — Payslip optimistic lock (docs/Fernly_HR_Payroll_Enhancement_Plan.md
-- §7.1.1 residual sweep). Additive column; no new table, no behavior for
-- existing rows (every stored slip reads as version 0).
--
-- Payslip.version: incremented on every successful updatePayslip edit; the
-- modal sends the version it loaded as expectedVersion and the action
-- refuses a mismatch ("saved by someone else while you were editing") —
-- last-write-wins between two HR editors is no longer possible. LOCKED
-- slips are immutable, so their version never moves after payment.

ALTER TABLE "Payslip" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 0;
