-- PR-B02 down: drop the catalog knob. Snapshot copies in structure/payslip
-- JSON survive harmlessly (absent = true in the readers); only future
-- catalog edits lose the toggle.

ALTER TABLE "SalaryComponent" DROP COLUMN "dependsOnPaymentDays";
