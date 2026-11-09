-- Down: drop the P18 knob. Default false = the pre-P18 silence, so the
-- drop is lossless.

ALTER TABLE "Workspace" DROP COLUMN "emailPayslipsOnLock";
