-- G5 — biometric attendance (the device-independent core): raw punches
-- from any device (HTTP push / CSV import; vendor fetch adapters are a
-- follow-up), the device-user ↔ employee mapping, and the optional link
-- from a punch onto the AttendanceRecord the reconcile engine derived
-- from it.
--
--   • BiometricDevice — a physical device (master data). config carries
--     the vendor-neutral settings (pushToken for the HTTP endpoint's
--     auth, breakMinutes for the engine's unpaid-break deduction).
--     Restrict FKs from Punch/DeviceUserMapping keep punch history
--     undeletable-with-its-device: retire a device with isActive=false.
--   • DeviceUserMapping — the identity bridge; the two composites pin
--     both directions (device user → one employee, employee → one device
--     user id, per device).
--   • Punch — the raw evidence row. The (deviceId, deviceUserId,
--     punchedAt) UNIQUE is the re-delivery guard; reconciliationStatus
--     walks PENDING → MATCHED → ATTENDED with UNMATCHED / DUPLICATE /
--     IGNORED as side exits; attendanceRecordId is the additive, nullable
--     link onto the derived mark (SetNull — deleting a mark never orphans
--     a punch).

-- CreateTable
CREATE TABLE "BiometricDevice" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "vendor" TEXT NOT NULL,
    "protocol" TEXT NOT NULL,
    "serial" TEXT,
    "location" TEXT,
    "lastSyncAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "config" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BiometricDevice_serial_key" UNIQUE ("serial")
);

-- CreateTable
CREATE TABLE "DeviceUserMapping" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "deviceId" TEXT NOT NULL,
    "deviceUserId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeviceUserMapping_deviceId_deviceUserId_key" UNIQUE ("deviceId", "deviceUserId"),
    CONSTRAINT "DeviceUserMapping_deviceId_employeeId_key" UNIQUE ("deviceId", "employeeId"),
    CONSTRAINT "DeviceUserMapping_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "BiometricDevice"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "DeviceUserMapping_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Punch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "deviceId" TEXT NOT NULL,
    "deviceUserId" TEXT NOT NULL,
    "employeeId" TEXT,
    "punchedAt" TIMESTAMP(3) NOT NULL,
    "direction" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "verifyMethod" TEXT,
    "rawPayload" JSONB,
    "matchedAt" TIMESTAMP(3),
    "reconciliationStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "attendanceRecordId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Punch_deviceId_deviceUserId_punchedAt_key" UNIQUE ("deviceId", "deviceUserId", "punchedAt"),
    CONSTRAINT "Punch_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "BiometricDevice"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Punch_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Punch_attendanceRecordId_fkey" FOREIGN KEY ("attendanceRecordId") REFERENCES "AttendanceRecord"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "BiometricDevice_isActive_idx" ON "BiometricDevice"("isActive");

-- CreateIndex
CREATE INDEX "DeviceUserMapping_employeeId_idx" ON "DeviceUserMapping"("employeeId");

-- CreateIndex
CREATE INDEX "Punch_employeeId_punchedAt_idx" ON "Punch"("employeeId", "punchedAt");

-- CreateIndex
CREATE INDEX "Punch_reconciliationStatus_idx" ON "Punch"("reconciliationStatus");

-- CreateIndex
CREATE INDEX "Punch_attendanceRecordId_idx" ON "Punch"("attendanceRecordId");
