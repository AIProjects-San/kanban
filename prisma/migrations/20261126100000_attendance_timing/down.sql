-- AT-B02/B03 down: drop the derived timing columns and the reference-day
-- knobs. Reversibility note (ADR-008): the three record columns are derived
-- facts (recomputable from in/out + a reference day); dropping them loses
-- nothing that isn't reconstructible. The workspace knobs are pure config.

ALTER TABLE "AttendanceRecord" DROP COLUMN "workingHours";
ALTER TABLE "AttendanceRecord" DROP COLUMN "earlyMinutes";
ALTER TABLE "AttendanceRecord" DROP COLUMN "lateMinutes";
ALTER TABLE "Workspace" DROP COLUMN "attendanceDayEnd";
ALTER TABLE "Workspace" DROP COLUMN "attendanceDayStart";
