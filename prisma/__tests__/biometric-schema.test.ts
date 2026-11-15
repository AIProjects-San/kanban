import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// G5 — biometric attendance schema contracts (the schema-contracts.test.ts
// discipline): the three models exist with their unique guards, the
// re-delivery + identity uniques, the punch → attendance link, and the
// migration that creates them (with a down).
// ---------------------------------------------------------------------------

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const schema = readFileSync(resolve(__dirname, "../schema.prisma"), "utf-8");

function modelBlock(name: string): string {
  const re = new RegExp(`model ${name}\\s*\\{([\\s\\S]*?)^\\}`, "m");
  const match = schema.match(re);
  if (!match) throw new Error(`model ${name} not found in schema.prisma`);
  return match[1];
}

describe("G5 biometric attendance models", () => {
  describe("BiometricDevice", () => {
    const m = modelBlock("BiometricDevice");
    it("has the vendor/protocol string columns (comment-pinned vocabularies)", () => {
      expect(m).toMatch(/vendor\s+String/);
      expect(m).toMatch(/protocol\s+String/);
      expect(m).toMatch(/isActive\s+Boolean\s+@default\(true\)/);
      expect(m).toMatch(/config\s+Json\?/);
    });
    it("has a unique serial", () => {
      expect(m).toMatch(/serial\s+String\?\s+@unique/);
    });
  });

  describe("DeviceUserMapping", () => {
    const m = modelBlock("DeviceUserMapping");
    it("pins both directions of the identity bridge", () => {
      expect(m).toMatch(/@@unique\(\[deviceId, deviceUserId\]\)/);
      expect(m).toMatch(/@@unique\(\[deviceId, employeeId\]\)/);
    });
    it("references the device + the employee", () => {
      expect(m).toMatch(/device\s+BiometricDevice\s+@relation\(fields: \[deviceId\], references: \[id\]\)/);
      expect(m).toMatch(/employee\s+User\s+@relation\(fields: \[employeeId\], references: \[id\]\)/);
    });
  });

  describe("Punch", () => {
    const m = modelBlock("Punch");
    it("carries the re-delivery guard", () => {
      expect(m).toMatch(/@@unique\(\[deviceId, deviceUserId, punchedAt\]\)/);
    });
    it("has the reconciliation lifecycle + the optional employee + record link", () => {
      expect(m).toMatch(/reconciliationStatus String @default\("PENDING"\)/);
      expect(m).toMatch(/employeeId\s+String\?/);
      expect(m).toMatch(/attendanceRecordId String\?/);
      expect(m).toMatch(/attendanceRecord\s+AttendanceRecord\? @relation\(fields: \[attendanceRecordId\], references: \[id\], onDelete: SetNull\)/);
    });
    it("indexes the hot paths", () => {
      expect(m).toMatch(/@@index\(\[employeeId, punchedAt\]\)/);
      expect(m).toMatch(/@@index\(\[reconciliationStatus\]\)/);
    });
  });

  describe("the AttendanceRecord + User links", () => {
    it("AttendanceRecord carries the punch back-relation + the BIOMETRIC source", () => {
      const m = modelBlock("AttendanceRecord");
      expect(m).toMatch(/punches\s+Punch\[\]/);
      expect(m).toMatch(/BIOMETRIC/);
    });
    it("User carries the mapping + punch back-relations", () => {
      const m = modelBlock("User");
      expect(m).toMatch(/deviceUserMappings DeviceUserMapping\[\]/);
      expect(m).toMatch(/punches\s+Punch\[\]/);
    });
  });
});

describe("the G5 migration", () => {
  const dir = resolve(__dirname, "../migrations/20261209000000_biometric_attendance");
  const sql = readFileSync(resolve(dir, "migration.sql"), "utf-8");

  it("exists with a lossless down", () => {
    expect(existsSync(resolve(dir, "down.sql"))).toBe(true);
  });

  it("creates the three tables with the unique guards the schema declares", () => {
    expect(sql).toContain('CREATE TABLE "BiometricDevice"');
    expect(sql).toContain('CREATE TABLE "DeviceUserMapping"');
    expect(sql).toContain('CREATE TABLE "Punch"');
    expect(sql).toContain('CONSTRAINT "BiometricDevice_serial_key" UNIQUE ("serial")');
    expect(sql).toContain('CONSTRAINT "DeviceUserMapping_deviceId_deviceUserId_key" UNIQUE ("deviceId", "deviceUserId")');
    expect(sql).toContain('CONSTRAINT "DeviceUserMapping_deviceId_employeeId_key" UNIQUE ("deviceId", "employeeId")');
    expect(sql).toContain('CONSTRAINT "Punch_deviceId_deviceUserId_punchedAt_key" UNIQUE ("deviceId", "deviceUserId", "punchedAt")');
  });

  it("keeps punch history with Restrict device FKs and SetNull employee/record FKs", () => {
    expect(sql).toContain('CONSTRAINT "Punch_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "BiometricDevice"("id") ON DELETE RESTRICT');
    expect(sql).toContain('CONSTRAINT "Punch_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "User"("id") ON DELETE SET NULL');
    expect(sql).toContain('CONSTRAINT "Punch_attendanceRecordId_fkey" FOREIGN KEY ("attendanceRecordId") REFERENCES "AttendanceRecord"("id") ON DELETE SET NULL');
  });
});
