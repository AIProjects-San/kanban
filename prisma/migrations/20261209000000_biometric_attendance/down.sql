-- G5 — lossless down: the three tables are brand new (no rows predate the
-- migration) and no existing table gained a column (the punch→mark link
-- lives on the Punch side). Dropping the tables returns the db to the
-- exact pre-G5 shape; the biometric UIs degrade to empty lists.

DROP INDEX "Punch_attendanceRecordId_idx";

DROP INDEX "Punch_reconciliationStatus_idx";

DROP INDEX "Punch_employeeId_punchedAt_idx";

DROP INDEX "DeviceUserMapping_employeeId_idx";

DROP INDEX "BiometricDevice_isActive_idx";

DROP TABLE "Punch";

DROP TABLE "DeviceUserMapping";

DROP TABLE "BiometricDevice";
