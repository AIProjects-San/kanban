-- PR-B23 down: drop the knob. Existing slips keep their stored rounding
-- lines (they are ordinary money); only future saves stop emitting them.

ALTER TABLE "Workspace" DROP COLUMN "payrollRoundingMode";
