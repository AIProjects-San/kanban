-- S14 down: drop the override. Decisions fall back to the manager chain
-- instantly; no data is lost beyond the override assignments themselves.

ALTER TABLE "EmployeeProfile" DROP COLUMN "leaveApproverId";
