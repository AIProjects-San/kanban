import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// P2.1 (ADR-022) — the HR master action tests: the delete guards (a
// department with employees or children is refused; a designation with
// holders; a grade with holders or linked designations), the salary-band
// validation on save, the rename → mirror-string cascade, the tree cycle
// guard, and the pickers' payload (inactive rows excluded).
// ---------------------------------------------------------------------------

const db = vi.hoisted(() => {
  const models = ["department", "designation", "grade", "employeeProfile", "auditLog"];
  const methods = ["findMany", "findUnique", "findFirst", "create", "update", "updateMany", "delete", "deleteMany", "count", "groupBy", "aggregate"];
  const obj: Record<string, Record<string, ReturnType<typeof vi.fn>>> = {};
  for (const m of models) {
    obj[m] = {};
    for (const meth of methods) obj[m][meth] = vi.fn();
  }
  (obj as Record<string, unknown>).$transaction = vi.fn(
    async (arr: unknown[]) => Promise.all(arr as Promise<unknown>[]),
  );
  return obj;
});
vi.mock("@/lib/infra/db", () => ({ db }));

const requirePermissionMock = vi.fn();
vi.mock("@/server-actions/auth-guard", () => ({
  requirePermission: (...a: unknown[]) => requirePermissionMock(...a),
  AuthorizationError: class AuthorizationError extends Error {
    readonly digest = "AuthorizationError";
    constructor(m: string) {
      super(m);
      this.name = "AuthorizationError";
    }
  },
}));

const logAuditMock = vi.fn();
vi.mock("@/server-actions/shared", () => ({
  logAudit: (...a: unknown[]) => logAuditMock(...a),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import {
  getDepartments,
  saveDepartment,
  deleteDepartment,
  getDesignations,
  saveDesignation,
  deleteDesignation,
  getGrades,
  saveGrade,
  deleteGrade,
  getHrMasterOptions,
} from "../hr-masters";

const ADMIN_AUTH = { userId: "u-admin", role: "ADMIN" as const, name: "Admin", email: "a@x.co" };

beforeEach(() => {
  vi.clearAllMocks();
  requirePermissionMock.mockResolvedValue(ADMIN_AUTH);
  logAuditMock.mockResolvedValue(undefined);
  db.department.findMany.mockResolvedValue([]);
  db.designation.findMany.mockResolvedValue([]);
  db.grade.findMany.mockResolvedValue([]);
  db.employeeProfile.groupBy.mockResolvedValue([]);
  db.designation.groupBy.mockResolvedValue([]);
  db.department.count.mockResolvedValue(0);
  db.designation.count.mockResolvedValue(0);
  db.employeeProfile.count.mockResolvedValue(0);
  db.department.findUnique.mockResolvedValue(null);
  db.designation.findUnique.mockResolvedValue(null);
  db.grade.findUnique.mockResolvedValue(null);
  db.department.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "dept-1", ...data }));
  db.designation.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "desig-1", ...data }));
  db.grade.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "grade-1", ...data }));
});

// ---------------------------------------------------------------------------
// Departments
// ---------------------------------------------------------------------------

describe("P2.1 departments", () => {
  it("lists departments with live employee counts and parent names", async () => {
    db.department.findMany.mockResolvedValue([
      { id: "d-root", name: "Engineering", code: "ENGINEERING", parentId: null, costCenter: null, isActive: true, createdAt: new Date(), updatedAt: new Date() },
      { id: "d-child", name: "Platform", code: null, parentId: "d-root", costCenter: "CC-1", isActive: true, createdAt: new Date(), updatedAt: new Date() },
    ]);
    db.employeeProfile.groupBy.mockResolvedValue([{ departmentId: "d-root", _count: { _all: 3 } }]);
    const res = await getDepartments();
    if (!res.ok) throw new Error("expected ok");
    expect(res.data).toHaveLength(2);
    expect(res.data[0]).toMatchObject({ id: "d-root", employeeCount: 3, parentName: null });
    expect(res.data[1]).toMatchObject({ id: "d-child", parentName: "Engineering", employeeCount: 0, costCenter: "CC-1" });
  });

  it("refuses a department that would report into its own subtree", async () => {
    db.department.findUnique.mockResolvedValue({ id: "d-child", parentId: "d-root" });
    const res = await saveDepartment({ id: "d-root", name: "Engineering", parentId: "d-child" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("AUTH");
      expect(res.error).toContain("cannot report into itself");
    }
  });

  it("a rename cascades every referencing profile's mirror string atomically", async () => {
    db.department.findUnique.mockResolvedValue({ id: "d-1", name: "Engineering" });
    db.department.update.mockResolvedValue({ id: "d-1", name: "Engineering & Platform", code: null });
    const res = await saveDepartment({ id: "d-1", name: "Engineering & Platform" });
    expect(res).toEqual({ ok: true, data: { id: "d-1" } });
    // The mirror cascade rides the same transaction as the master bump.
    expect(db.employeeProfile.updateMany).toHaveBeenCalledWith({
      where: { departmentId: "d-1" },
      data: { department: "Engineering & Platform" },
    });
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "hr.department_saved" }),
    );
  });

  it("refuses to delete a department with referencing employees (deactivate instead)", async () => {
    db.department.findUnique.mockResolvedValue({ id: "d-1", name: "Engineering" });
    db.employeeProfile.count.mockResolvedValue(4);
    const res = await deleteDepartment({ id: "d-1" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain("4 employee profiles still reference");
      expect(res.error).toContain("deactivate");
    }
    expect(db.department.delete).not.toHaveBeenCalled();
  });

  it("refuses to delete a department with children (move them first)", async () => {
    db.department.findUnique.mockResolvedValue({ id: "d-1", name: "Engineering" });
    db.department.count.mockResolvedValue(2);
    const res = await deleteDepartment({ id: "d-1" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("child department");
    expect(db.department.delete).not.toHaveBeenCalled();
  });

  it("deletes an unreferenced department (documents keep their string snapshots)", async () => {
    db.department.findUnique.mockResolvedValue({ id: "d-1", name: "Old Lab" });
    const res = await deleteDepartment({ id: "d-1" });
    expect(res).toEqual({ ok: true, data: { ok: true } });
    expect(db.department.delete).toHaveBeenCalledWith({ where: { id: "d-1" } });
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "hr.department_deleted" }),
    );
  });
});

// ---------------------------------------------------------------------------
// Designations
// ---------------------------------------------------------------------------

describe("P2.1 designations", () => {
  it("lists designations grade-linked with holder counts", async () => {
    db.designation.findMany.mockResolvedValue([
      { id: "x-1", name: "Backend Engineer", code: null, gradeId: "g-4", grade: { name: "L4" }, isActive: true, createdAt: new Date(), updatedAt: new Date() },
    ]);
    db.employeeProfile.groupBy.mockResolvedValue([{ designationId: "x-1", _count: { _all: 2 } }]);
    const res = await getDesignations();
    if (!res.ok) throw new Error("expected ok");
    expect(res.data[0]).toMatchObject({ name: "Backend Engineer", gradeName: "L4", employeeCount: 2 });
  });

  it("refuses a grade link that does not resolve", async () => {
    db.grade.findUnique.mockResolvedValue(null);
    const res = await saveDesignation({ name: "Backend Engineer", gradeId: "g-404" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("Grade not found");
  });

  it("refuses to delete a designation with holders", async () => {
    db.designation.findUnique.mockResolvedValue({ id: "x-1", name: "Backend Engineer" });
    db.employeeProfile.count.mockResolvedValue(1);
    const res = await deleteDesignation({ id: "x-1" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("1 employee profile still holds");
  });
});

// ---------------------------------------------------------------------------
// Grades — the salary band validates on save
// ---------------------------------------------------------------------------

describe("P2.1 grades", () => {
  it("lists the ladder by level with designation and holder counts", async () => {
    db.grade.findMany.mockResolvedValue([
      { id: "g-3", name: "L3", level: 3, minBase: 55000, maxBase: 70000, isActive: true, createdAt: new Date(), updatedAt: new Date() },
    ]);
    db.employeeProfile.groupBy.mockResolvedValue([{ gradeId: "g-3", _count: { _all: 5 } }]);
    db.designation.groupBy.mockResolvedValue([{ gradeId: "g-3", _count: { _all: 2 } }]);
    const res = await getGrades();
    if (!res.ok) throw new Error("expected ok");
    expect(res.data[0]).toMatchObject({ name: "L3", level: 3, minBase: 55000, maxBase: 70000, employeeCount: 5, designationCount: 2 });
  });

  it("saves a valid band and cascades the grade mirrors on rename", async () => {
    db.grade.findUnique.mockResolvedValue({ id: "g-4", name: "L4" });
    db.grade.update.mockResolvedValue({ id: "g-4", name: "L4 (senior)" });
    const res = await saveGrade({ id: "g-4", name: "L4 (senior)", level: 4, minBase: 60000, maxBase: 90000 });
    expect(res).toEqual({ ok: true, data: { id: "g-4" } });
    expect(db.employeeProfile.updateMany).toHaveBeenCalledWith({
      where: { gradeId: "g-4" },
      data: { grade: "L4 (senior)" },
    });
  });

  it("refuses a band whose minimum exceeds its maximum", async () => {
    const res = await saveGrade({ name: "L4", level: 4, minBase: 90000, maxBase: 60000 });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("AUTH");
      expect(res.error).toContain("minimum cannot exceed its maximum");
    }
    expect(db.grade.create).not.toHaveBeenCalled();
  });

  it("refuses negative bounds (the zod boundary, before the band math)", async () => {
    const min = await saveGrade({ name: "L4", level: 4, minBase: -1 });
    expect(min.ok).toBe(false);
    if (!min.ok) {
      expect(min.code).toBe("VALIDATION");
      expect(min.error).toContain("minBase");
    }
    const max = await saveGrade({ name: "L4", level: 4, maxBase: -5 });
    expect(max.ok).toBe(false);
    if (!max.ok) {
      expect(max.code).toBe("VALIDATION");
      expect(max.error).toContain("maxBase");
    }
  });

  it("one-sided bands are legal (open-ended on the other side)", async () => {
    db.grade.findUnique.mockResolvedValue({ id: "g-1", name: "L1" });
    db.grade.update.mockResolvedValue({ id: "g-1", name: "L1" });
    const res = await saveGrade({ id: "g-1", name: "L1", level: 1, minBase: 40000 });
    expect(res.ok).toBe(true);
  });

  it("refuses to delete a grade with holders or linked designations", async () => {
    db.grade.findUnique.mockResolvedValue({ id: "g-4", name: "L4" });
    db.employeeProfile.count.mockResolvedValue(2);
    db.designation.count.mockResolvedValue(3);
    const res = await deleteGrade({ id: "g-4" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("2 employee profiles and 3 linked designations");
    expect(db.grade.delete).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The pickers' payload
// ---------------------------------------------------------------------------

describe("P2.1 getHrMasterOptions", () => {
  it("offers only ACTIVE rows, ordered for the pickers", async () => {
    db.department.findMany.mockResolvedValue([
      { id: "d-1", name: "Engineering", code: "ENGINEERING" },
    ]);
    db.designation.findMany.mockResolvedValue([
      { id: "x-1", name: "Backend Engineer", gradeId: "g-4" },
    ]);
    db.grade.findMany.mockResolvedValue([
      { id: "g-4", name: "L4", level: 4 },
    ]);
    const res = await getHrMasterOptions();
    if (!res.ok) throw new Error("expected ok");
    expect(res.data).toEqual({
      departments: [{ id: "d-1", label: "Engineering" }],
      designations: [{ id: "x-1", label: "Backend Engineer", gradeId: "g-4" }],
      grades: [{ id: "g-4", label: "L4" }],
    });
    expect(db.department.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { isActive: true } }),
    );
  });
});
