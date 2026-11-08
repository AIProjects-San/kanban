-- PR-B07 down: drop the knob. Existing payslips keep their derived lopDays
-- (snapshot discipline); only future derivations revert to IGNORED.

ALTER TABLE "Workspace" DROP COLUMN "unmarkedAttendanceMode";
