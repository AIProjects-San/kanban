import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// P2.1 (ADR-022) — the HR masters' schema contracts (the
// schema-contracts.test.ts discipline): the three master models exist with
// their unique guards + tree/grade links, EmployeeProfile carries the FK
// columns beside the string mirrors, the transfer/promotion documents carry
// their FK links with SetNull (the string snapshots survive a master
// deletion), and the migration that creates them (with a down).
// ---------------------------------------------------------------------------

const schema = readFileSync(resolve(__dirname, "../schema.prisma"), "utf-8");
const MIGRATION_DIR = resolve(__dirname, "../migrations/20261210000000_hr_master_tables");

function modelBlock(name: string): string {
  const re = new RegExp(`model ${name}\\s*\\{([\\s\\S]*?)^\\}`, "m");
  const match = schema.match(re);
  if (!match) throw new Error(`model ${name} not found in schema.prisma`);
  return match[1];
}

describe("P2.1 HR master models", () => {
  describe("Department", () => {
    const m = modelBlock("Department");
    it("pins the unique name + optional unique code", () => {
      expect(m).toMatch(/name\s+String\s+@unique/);
      expect(m).toMatch(/code\s+String\?\s+@unique/);
    });
    it("carries the self-referencing tree + the cost center + the active flag", () => {
      expect(m).toMatch(/parent\s+Department\?\s+@relation\("DeptTree", fields: \[parentId\], references: \[id\]\)/);
      expect(m).toMatch(/children\s+Department\[\]\s+@relation\("DeptTree"\)/);
      expect(m).toMatch(/costCenter\s+String\?/);
      expect(m).toMatch(/isActive\s+Boolean\s+@default\(true\)/);
    });
    it("backs both EmployeeProfile and the transfer documents", () => {
      expect(m).toMatch(/employees\s+EmployeeProfile\[\]/);
      expect(m).toMatch(/transferSources\s+EmployeeTransfer\[\]\s+@relation\("TransferFromDepartment"\)/);
      expect(m).toMatch(/transferTargets\s+EmployeeTransfer\[\]\s+@relation\("TransferToDepartment"\)/);
    });
  });

  describe("Designation", () => {
    const m = modelBlock("Designation");
    it("pins the unique name + optional unique code + the grade link", () => {
      expect(m).toMatch(/name\s+String\s+@unique/);
      expect(m).toMatch(/code\s+String\?\s+@unique/);
      expect(m).toMatch(/grade\s+Grade\?\s+@relation\(fields: \[gradeId\], references: \[id\]\)/);
    });
    it("backs both EmployeeProfile and the promotion documents", () => {
      expect(m).toMatch(/employees\s+EmployeeProfile\[\]/);
      expect(m).toMatch(/promotionSources\s+EmployeePromotion\[\]\s+@relation\("PromotionFromDesignation"\)/);
      expect(m).toMatch(/promotionTargets\s+EmployeePromotion\[\]\s+@relation\("PromotionToDesignation"\)/);
    });
  });

  describe("Grade", () => {
    const m = modelBlock("Grade");
    it("pins the unique name, the ordering level and the salary band", () => {
      expect(m).toMatch(/name\s+String\s+@unique/);
      expect(m).toMatch(/level\s+Int/);
      expect(m).toMatch(/minBase\s+Float\?/);
      expect(m).toMatch(/maxBase\s+Float\?/);
    });
    it("backs designations and employees", () => {
      expect(m).toMatch(/designations\s+Designation\[\]/);
      expect(m).toMatch(/employees\s+EmployeeProfile\[\]/);
    });
  });

  describe("EmployeeProfile master links", () => {
    const m = modelBlock("EmployeeProfile");
    it("carries the three nullable FK columns beside the string mirrors", () => {
      expect(m).toMatch(/departmentId\s+String\?/);
      expect(m).toMatch(/departmentMaster\s+Department\?\s+@relation\(fields: \[departmentId\], references: \[id\]\)/);
      expect(m).toMatch(/designationId\s+String\?/);
      expect(m).toMatch(/designationMaster\s+Designation\?\s+@relation\(fields: \[designationId\], references: \[id\]\)/);
      expect(m).toMatch(/gradeId\s+String\?/);
      expect(m).toMatch(/gradeMaster\s+Grade\?\s+@relation\(fields: \[gradeId\], references: \[id\]\)/);
    });
    it("keeps the legacy string axes (the denormalized mirrors)", () => {
      expect(m).toMatch(/department\s+String\s+@default\(""\)/);
      expect(m).toMatch(/jobTitle\s+String\s+@default\(""\)/);
      expect(m).toMatch(/grade\s+String\s+@default\(""\)/);
    });
    it("indexes the FK lookups", () => {
      expect(m).toMatch(/@@index\(\[departmentId\]\)/);
      expect(m).toMatch(/@@index\(\[designationId\]\)/);
      expect(m).toMatch(/@@index\(\[gradeId\]\)/);
    });
  });

  describe("the transfer/promotion document links", () => {
    it("EmployeeTransfer carries from/to department FKs with SetNull", () => {
      const m = modelBlock("EmployeeTransfer");
      expect(m).toMatch(/fromDepartmentId\s+String\?/);
      expect(m).toMatch(/fromDepartmentRef\s+Department\?\s+@relation\("TransferFromDepartment", fields: \[fromDepartmentId\], references: \[id\], onDelete: SetNull\)/);
      expect(m).toMatch(/toDepartmentId\s+String\?/);
      expect(m).toMatch(/toDepartmentRef\s+Department\?\s+@relation\("TransferToDepartment", fields: \[toDepartmentId\], references: \[id\], onDelete: SetNull\)/);
    });
    it("EmployeePromotion carries from/to designation FKs with SetNull", () => {
      const m = modelBlock("EmployeePromotion");
      expect(m).toMatch(/fromDesignationId\s+String\?/);
      expect(m).toMatch(/fromDesignationRef\s+Designation\?\s+@relation\("PromotionFromDesignation", fields: \[fromDesignationId\], references: \[id\], onDelete: SetNull\)/);
      expect(m).toMatch(/toDesignationId\s+String\?/);
      expect(m).toMatch(/toDesignationRef\s+Designation\?\s+@relation\("PromotionToDesignation", fields: \[toDesignationId\], references: \[id\], onDelete: SetNull\)/);
    });
  });

  describe("the migration", () => {
    it("exists with a down", () => {
      expect(existsSync(resolve(MIGRATION_DIR, "migration.sql"))).toBe(true);
      expect(existsSync(resolve(MIGRATION_DIR, "down.sql"))).toBe(true);
    });
    it("backfills masters from the distinct strings and links every profile", () => {
      const sql = readFileSync(resolve(MIGRATION_DIR, "migration.sql"), "utf-8");
      expect(sql).toMatch(/INSERT INTO "Department"/);
      expect(sql).toMatch(/WHEN 'ENGINEERING' THEN 'Engineering'/);
      expect(sql).toMatch(/INSERT INTO "Designation"/);
      expect(sql).toMatch(/INSERT INTO "Grade"/);
      expect(sql).toMatch(/UPDATE "EmployeeProfile" AS ep\s+SET "departmentId" = d\."id"/);
      expect(sql).toMatch(/SET "designationId" = desig\."id"/);
      expect(sql).toMatch(/SET "gradeId" = gr\."id"/);
    });
    it("uses RESTRICT on the profile links and SET NULL on the document links", () => {
      const sql = readFileSync(resolve(MIGRATION_DIR, "migration.sql"), "utf-8");
      expect(sql).toMatch(/"EmployeeProfile_departmentId_fkey" FOREIGN KEY \("departmentId"\) REFERENCES "Department"\("id"\) ON DELETE RESTRICT/);
      expect(sql).toMatch(/"EmployeeTransfer_toDepartmentId_fkey" FOREIGN KEY \("toDepartmentId"\) REFERENCES "Department"\("id"\) ON DELETE SET NULL/);
    });
  });
});
