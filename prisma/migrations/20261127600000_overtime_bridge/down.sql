-- P9 down: drop the derived overtime fact + the payout knob. Reversibility
-- note (ADR-008): payslips carrying Overtime lines are frozen snapshots and
-- survive; only future derivations stop.

ALTER TABLE "Workspace" DROP COLUMN "overtimePayEnabled";
ALTER TABLE "AttendanceRecord" DROP COLUMN "overtimeMinutes";
