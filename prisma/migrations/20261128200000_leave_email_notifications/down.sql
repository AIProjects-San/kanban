-- Down: drop the P21 knob. Default false = the F-R17 zero-mail silence,
-- so the drop is lossless.

ALTER TABLE "Workspace" DROP COLUMN "emailLeaveNotifications";
