-- PR-B02 (S6) — per-component depends_on_payment_days
-- (docs/Fernly_HR_Payroll_Enhancement_Plan.md §7.1.1 residual sweep).
-- Additive column; default TRUE = the pre-S6 implicit semantics for every
-- component (all lines scaled with the payment window and were docked by
-- loss-of-pay). Flipping a catalog row to FALSE exempts its lines from both
-- the S5 employment-window scaling and the LOP basis (a flat allowance).
-- Structures and payslips keep sparse snapshot copies in their JSON (only
-- false is written — existing JSON stays byte-identical).

ALTER TABLE "SalaryComponent" ADD COLUMN "dependsOnPaymentDays" BOOLEAN NOT NULL DEFAULT true;
