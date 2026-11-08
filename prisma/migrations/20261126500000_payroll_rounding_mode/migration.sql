-- PR-B23 (S7) — the payslip rounding policy as workspace data
-- (docs/Fernly_HR_Payroll_Enhancement_Plan.md §7.1.1 residual sweep).
-- Additive column; default ROUND_2DP = the historical discipline
-- byte-for-byte (no rounding line ever). ROUND_NET_NEAREST makes run/slip
-- creation and updatePayslip append an auto "Rounding" line (earning when
-- it pays up, deduction when it docks down) so NET lands on a whole dollar
-- while still equaling Σ lines exactly.

ALTER TABLE "Workspace" ADD COLUMN "payrollRoundingMode" TEXT NOT NULL DEFAULT 'ROUND_2DP';
