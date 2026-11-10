-- P28 (LV-02/LV-03) — reverse the leave policy set master + assignment doc.
DROP INDEX IF EXISTS "LeavePolicyAssignment_bucketYear_idx";
DROP INDEX IF EXISTS "LeavePolicyAssignment_setId_idx";
DROP INDEX IF EXISTS "LeavePolicyAssignment_userId_bucketYear_key";
DROP TABLE IF EXISTS "LeavePolicyAssignment";

DROP INDEX IF EXISTS "LeavePolicySetItem_setId_idx";
DROP INDEX IF EXISTS "LeavePolicySetItem_setId_leaveTypeId_key";
DROP TABLE IF EXISTS "LeavePolicySetItem";

DROP INDEX IF EXISTS "LeavePolicySet_name_key";
DROP TABLE IF EXISTS "LeavePolicySet";
