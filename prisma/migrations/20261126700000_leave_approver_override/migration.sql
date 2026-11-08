-- EM-B04/LV-B13 (S14) — the leave-approver override
-- (docs/Fernly_HR_Payroll_Enhancement_Plan.md §7.1.1 residual sweep).
-- Additive nullable column; NULL (everyone) = the reporting-manager rule
-- stays exactly as-is. Setting it routes THAT employee's leave decisions
-- and notifications to the chosen user (override → manager → ADMINs).

ALTER TABLE "EmployeeProfile" ADD COLUMN "leaveApproverId" TEXT;
