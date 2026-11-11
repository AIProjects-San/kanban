-- P31 (LV-J02 / LV-09's remainder) — the encashment auto-draft switch
-- (the benchmark's daily generate_leave_encashment job gate). Default
-- false: the pre-P31 pass is byte-identical (the job reads the knob and
-- reports a no-op), and drafting encashment requests on members' behalf
-- is a workspace policy choice, never a surprise queue row.

ALTER TABLE "Workspace" ADD COLUMN "autoLeaveEncashment" BOOLEAN NOT NULL DEFAULT false;
