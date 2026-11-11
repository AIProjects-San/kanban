-- P31 — lossless down: drop the auto-draft switch (the pre-P31 pass was
-- gated off anyway, so the behavioral rollback is a no-op).

ALTER TABLE "Workspace" DROP COLUMN "autoLeaveEncashment";
