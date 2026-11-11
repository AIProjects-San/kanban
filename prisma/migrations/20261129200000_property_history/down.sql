-- P33 — lossless down: the table was additive (no pre-P33 writer exists),
-- and the retirement-age knob defaulted to NULL (no behavior to restore).

DROP TABLE "EmployeePropertyHistory";
ALTER TABLE "Workspace" DROP COLUMN "retirementAge";
