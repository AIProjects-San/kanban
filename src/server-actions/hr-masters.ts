"use server";

// ---------------------------------------------------------------------------
// P2.1 (ADR-022) — the HR masters: Department (tree), Designation
// (grade-linked), Grade (salary band).
//
//   • Reads are hr:view (the pickers feed every HR surface); writes are
//     hr:admin (the hiring:config doc-type discipline).
//   • The EmployeeProfile string mirrors are DENORMALIZED: a rename (or a
//     code change — the mirror is code ?? name) cascades every referencing
//     profile's string inside the same transaction as the master write, so
//     the Phase 1/2 string readers (payroll analytics' dimension charts,
//     the CSV exports) never see a stale label.
//   • Deletes are guarded, not cascaded: a master with referencing
//     employees (or, for departments, child departments; for grades,
//     linked designations) is REFUSED — deactivate it instead. The
//     transfer/promotion documents never block a delete: their FKs are
//     SetNull and their string snapshots are the history truth.
//   • The Grade salary band validates on save (min <= max, both
//     non-negative — lib/hr/masters.ts gradeBandError, one message).
// ---------------------------------------------------------------------------

import { revalidatePath } from "next/cache";
import { db } from "@/lib/infra/db";
import { requirePermission, AuthorizationError } from "./auth-guard";
import {
  saveDepartmentSchema,
  deleteDepartmentSchema,
  saveDesignationSchema,
  deleteDesignationSchema,
  saveGradeSchema,
  deleteGradeSchema,
  parseOrThrow,
} from "@/lib/validation";
import { logAudit } from "./shared";
import { toResult, isUniqueConstraintError } from "./result";
import { gradeBandError } from "@/lib/hr/masters";
import type { ActionResult } from "@/lib/shared/action-result";
import type { DepartmentT, DesignationT, GradeT } from "@/lib/types";

// ---------------------------------------------------------------------------
// Departments
// ---------------------------------------------------------------------------

/** The department master with live employee counts (hr:view). */
export async function getDepartments(): Promise<ActionResult<DepartmentT[]>> {
  return toResult(async () => {
    await requirePermission("hr:view");
    const [rows, counts] = await Promise.all([
      db.department.findMany({ orderBy: [{ name: "asc" }] }),
      db.employeeProfile.groupBy({ by: ["departmentId"], _count: { _all: true } }),
    ]);
    const countBy = new Map(counts.map((c) => [c.departmentId, c._count._all]));
    const nameBy = new Map(rows.map((r) => [r.id, r.name]));
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      code: r.code,
      parentId: r.parentId,
      parentName: r.parentId ? nameBy.get(r.parentId) ?? null : null,
      costCenter: r.costCenter,
      isActive: r.isActive,
      employeeCount: countBy.get(r.id) ?? 0,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }));
  });
}

/** A department cannot be its own ancestor (the tree stays a tree). */
async function assertNoDepartmentCycle(departmentId: string, newParentId: string | null): Promise<void> {
  let cursor = newParentId;
  for (let depth = 0; depth < 50 && cursor; depth++) {
    if (cursor === departmentId) {
      throw new AuthorizationError("A department cannot report into itself or its own subtree — pick a different parent.");
    }
    const parent = await db.department.findUnique({ where: { id: cursor }, select: { parentId: true } });
    cursor = parent?.parentId ?? null;
  }
}

/** Create or edit a department (hr:admin). A rename or code change
 *  cascades every referencing profile's mirror string atomically. */
export async function saveDepartment(input: unknown): Promise<ActionResult<{ id: string }>> {
  return toResult(async () => {
    const auth = await requirePermission("hr:admin");
    const data = parseOrThrow(saveDepartmentSchema, input);

    if (data.parentId) {
      const parent = await db.department.findUnique({ where: { id: data.parentId }, select: { id: true } });
      if (!parent) throw new AuthorizationError("Parent department not found — pick one from the tree.");
      if (data.id) await assertNoDepartmentCycle(data.id, data.parentId);
    }

    const patch = {
      name: data.name,
      code: data.code ?? null,
      parentId: data.parentId ?? null,
      costCenter: data.costCenter ?? null,
      ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
    };

    let row: { id: string; name: string; code: string | null };
    try {
      if (data.id) {
        const existing = await db.department.findUnique({ where: { id: data.id }, select: { id: true } });
        if (!existing) throw new AuthorizationError("Department not found — refresh the list and try again.");
        row = await db.department.update({ where: { id: data.id }, data: patch, select: { id: true, name: true, code: true } });
      } else {
        row = await db.department.create({ data: patch, select: { id: true, name: true, code: true } });
      }
    } catch (e) {
      if (isUniqueConstraintError(e)) {
        throw new AuthorizationError(`Another department already uses that ${/code/i.test(String((e as { meta?: { target?: string[] } }).meta?.target)) ? "code" : "name"} — department names and codes must be unique.`);
      }
      throw e;
    }

    // The mirror cascade: profile.department = code ?? name, kept in
    // lockstep with the master inside one transaction.
    const mirror = row.code ?? row.name;
    await db.$transaction([
      db.department.update({ where: { id: row.id }, data: { updatedAt: new Date() } }),
      db.employeeProfile.updateMany({ where: { departmentId: row.id }, data: { department: mirror } }),
    ]);

    await logAudit({
      actor: auth,
      action: "hr.department_saved",
      entityType: "DEPARTMENT",
      entityId: row.id,
      entityLabel: row.name,
      detail: `${auth.name} ${data.id ? "updated" : "added"} the department "${row.name}"${row.code ? ` (code ${row.code})` : ""}${data.isActive === false ? " — deactivated" : ""}.`,
    });
    revalidatePath("/");
    return { id: row.id };
  });
}

/** Remove a department (hr:admin) — refused while any employee (or child
 *  department) still references it; deactivate instead. */
export async function deleteDepartment(input: unknown): Promise<ActionResult<{ ok: true }>> {
  return toResult(async () => {
    const auth = await requirePermission("hr:admin");
    const data = parseOrThrow(deleteDepartmentSchema, input);
    const row = await db.department.findUnique({ where: { id: data.id } });
    if (!row) throw new AuthorizationError("Department not found — refresh the list and try again.");

    const [employees, children] = await Promise.all([
      db.employeeProfile.count({ where: { departmentId: data.id } }),
      db.department.count({ where: { parentId: data.id } }),
    ]);
    if (employees > 0) {
      throw new AuthorizationError(
        `${employees} employee profile${employees === 1 ? " still references" : "s still reference"} "${row.name}" — move them first, or deactivate the department instead of deleting it.`,
      );
    }
    if (children > 0) {
      throw new AuthorizationError(
        `"${row.name}" has ${children} child department${children === 1 ? "" : "s"} — move or delete them first.`,
      );
    }

    await db.department.delete({ where: { id: data.id } });
    await logAudit({
      actor: auth,
      action: "hr.department_deleted",
      entityType: "DEPARTMENT",
      entityId: row.id,
      entityLabel: row.name,
      detail: `${auth.name} deleted the department "${row.name}" (no employees referenced it; transfer documents keep their string snapshots).`,
    });
    revalidatePath("/");
    return { ok: true as const };
  });
}

// ---------------------------------------------------------------------------
// Designations
// ---------------------------------------------------------------------------

/** The designation master, grade-linked, with live employee counts. */
export async function getDesignations(): Promise<ActionResult<DesignationT[]>> {
  return toResult(async () => {
    await requirePermission("hr:view");
    const [rows, counts] = await Promise.all([
      db.designation.findMany({ orderBy: [{ name: "asc" }], include: { grade: { select: { name: true } } } }),
      db.employeeProfile.groupBy({ by: ["designationId"], _count: { _all: true } }),
    ]);
    const countBy = new Map(counts.map((c) => [c.designationId, c._count._all]));
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      code: r.code,
      gradeId: r.gradeId,
      gradeName: r.grade?.name ?? null,
      isActive: r.isActive,
      employeeCount: countBy.get(r.id) ?? 0,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }));
  });
}

/** Create or edit a designation (hr:admin); renames cascade the jobTitle
 *  mirrors. */
export async function saveDesignation(input: unknown): Promise<ActionResult<{ id: string }>> {
  return toResult(async () => {
    const auth = await requirePermission("hr:admin");
    const data = parseOrThrow(saveDesignationSchema, input);

    if (data.gradeId) {
      const grade = await db.grade.findUnique({ where: { id: data.gradeId }, select: { id: true } });
      if (!grade) throw new AuthorizationError("Grade not found — pick one from the ladder.");
    }

    const patch = {
      name: data.name,
      code: data.code ?? null,
      gradeId: data.gradeId ?? null,
      ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
    };

    let row: { id: string; name: string };
    try {
      if (data.id) {
        const existing = await db.designation.findUnique({ where: { id: data.id }, select: { id: true } });
        if (!existing) throw new AuthorizationError("Designation not found — refresh the list and try again.");
        row = await db.designation.update({ where: { id: data.id }, data: patch, select: { id: true, name: true } });
      } else {
        row = await db.designation.create({ data: patch, select: { id: true, name: true } });
      }
    } catch (e) {
      if (isUniqueConstraintError(e)) {
        throw new AuthorizationError("Another designation already uses that name or code — designations must be unique.");
      }
      throw e;
    }

    await db.$transaction([
      db.designation.update({ where: { id: row.id }, data: { updatedAt: new Date() } }),
      db.employeeProfile.updateMany({ where: { designationId: row.id }, data: { jobTitle: row.name } }),
    ]);

    await logAudit({
      actor: auth,
      action: "hr.designation_saved",
      entityType: "DESIGNATION",
      entityId: row.id,
      entityLabel: row.name,
      detail: `${auth.name} ${data.id ? "updated" : "added"} the designation "${row.name}"${data.isActive === false ? " — deactivated" : ""}.`,
    });
    revalidatePath("/");
    return { id: row.id };
  });
}

/** Remove a designation (hr:admin) — refused while any employee still
 *  holds it. */
export async function deleteDesignation(input: unknown): Promise<ActionResult<{ ok: true }>> {
  return toResult(async () => {
    const auth = await requirePermission("hr:admin");
    const data = parseOrThrow(deleteDesignationSchema, input);
    const row = await db.designation.findUnique({ where: { id: data.id } });
    if (!row) throw new AuthorizationError("Designation not found — refresh the list and try again.");

    const employees = await db.employeeProfile.count({ where: { designationId: data.id } });
    if (employees > 0) {
      throw new AuthorizationError(
        `${employees} employee profile${employees === 1 ? " still holds" : "s still hold"} the designation "${row.name}" — move them first, or deactivate it instead of deleting it.`,
      );
    }

    await db.designation.delete({ where: { id: data.id } });
    await logAudit({
      actor: auth,
      action: "hr.designation_deleted",
      entityType: "DESIGNATION",
      entityId: row.id,
      entityLabel: row.name,
      detail: `${auth.name} deleted the designation "${row.name}" (promotion documents keep their string snapshots).`,
    });
    revalidatePath("/");
    return { ok: true as const };
  });
}

// ---------------------------------------------------------------------------
// Grades
// ---------------------------------------------------------------------------

/** The grade ladder with its salary band and live counts. */
export async function getGrades(): Promise<ActionResult<GradeT[]>> {
  return toResult(async () => {
    await requirePermission("hr:view");
    const [rows, profileCounts, designationCounts] = await Promise.all([
      db.grade.findMany({ orderBy: [{ level: "asc" }] }),
      db.employeeProfile.groupBy({ by: ["gradeId"], _count: { _all: true } }),
      db.designation.groupBy({ by: ["gradeId"], _count: { _all: true } }),
    ]);
    const profilesBy = new Map(profileCounts.map((c) => [c.gradeId, c._count._all]));
    const designationsBy = new Map(designationCounts.map((c) => [c.gradeId, c._count._all]));
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      level: r.level,
      minBase: r.minBase,
      maxBase: r.maxBase,
      isActive: r.isActive,
      designationCount: designationsBy.get(r.id) ?? 0,
      employeeCount: profilesBy.get(r.id) ?? 0,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }));
  });
}

/** Create or edit a grade (hr:admin). The salary band validates on save:
 *  both bounds non-negative, min <= max when both are set. Renames
 *  cascade the grade mirrors. */
export async function saveGrade(input: unknown): Promise<ActionResult<{ id: string }>> {
  return toResult(async () => {
    const auth = await requirePermission("hr:admin");
    const data = parseOrThrow(saveGradeSchema, input);

    const bandError = gradeBandError(data.minBase ?? null, data.maxBase ?? null);
    if (bandError) throw new AuthorizationError(bandError);

    const patch = {
      name: data.name,
      level: data.level,
      minBase: data.minBase ?? null,
      maxBase: data.maxBase ?? null,
      ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
    };

    let row: { id: string; name: string };
    try {
      if (data.id) {
        const existing = await db.grade.findUnique({ where: { id: data.id }, select: { id: true } });
        if (!existing) throw new AuthorizationError("Grade not found — refresh the ladder and try again.");
        row = await db.grade.update({ where: { id: data.id }, data: patch, select: { id: true, name: true } });
      } else {
        row = await db.grade.create({ data: patch, select: { id: true, name: true } });
      }
    } catch (e) {
      if (isUniqueConstraintError(e)) {
        throw new AuthorizationError("Another grade already uses that name — grade names must be unique.");
      }
      throw e;
    }

    await db.$transaction([
      db.grade.update({ where: { id: row.id }, data: { updatedAt: new Date() } }),
      db.employeeProfile.updateMany({ where: { gradeId: row.id }, data: { grade: row.name } }),
    ]);

    await logAudit({
      actor: auth,
      action: "hr.grade_saved",
      entityType: "GRADE",
      entityId: row.id,
      entityLabel: row.name,
      detail:
        `${auth.name} ${data.id ? "updated" : "added"} the grade "${row.name}" (level ${data.level}` +
        `${data.minBase != null || data.maxBase != null ? `, band ${data.minBase ?? "—"} – ${data.maxBase ?? "—"}` : ""})` +
        `${data.isActive === false ? " — deactivated" : ""}.`,
    });
    revalidatePath("/");
    return { id: row.id };
  });
}

/** Remove a grade (hr:admin) — refused while any employee holds it or any
 *  designation links to it. */
export async function deleteGrade(input: unknown): Promise<ActionResult<{ ok: true }>> {
  return toResult(async () => {
    const auth = await requirePermission("hr:admin");
    const data = parseOrThrow(deleteGradeSchema, input);
    const row = await db.grade.findUnique({ where: { id: data.id } });
    if (!row) throw new AuthorizationError("Grade not found — refresh the ladder and try again.");

    const [employees, designations] = await Promise.all([
      db.employeeProfile.count({ where: { gradeId: data.id } }),
      db.designation.count({ where: { gradeId: data.id } }),
    ]);
    if (employees > 0 || designations > 0) {
      const parts: string[] = [];
      if (employees > 0) parts.push(`${employees} employee profile${employees === 1 ? "" : "s"}`);
      if (designations > 0) parts.push(`${designations} linked designation${designations === 1 ? "" : "s"}`);
      throw new AuthorizationError(
        `Grade "${row.name}" is still referenced by ${parts.join(" and ")} — move them first, or deactivate the grade instead of deleting it.`,
      );
    }

    await db.grade.delete({ where: { id: data.id } });
    await logAudit({
      actor: auth,
      action: "hr.grade_deleted",
      entityType: "GRADE",
      entityId: row.id,
      entityLabel: row.name,
      detail: `${auth.name} deleted the grade "${row.name}".`,
    });
    revalidatePath("/");
    return { ok: true as const };
  });
}

// ---------------------------------------------------------------------------
// The pickers' compact payload (one read for every HR form)
// ---------------------------------------------------------------------------

/** id + label lists for the transfer/promotion/directory pickers
 *  (hr:view). Inactive rows are excluded — a picker never offers a
 *  retired master. */
export async function getHrMasterOptions(): Promise<ActionResult<{
  departments: { id: string; label: string }[];
  designations: { id: string; label: string; gradeId: string | null }[];
  grades: { id: string; label: string }[];
}>> {
  return toResult(async () => {
    await requirePermission("hr:view");
    const [departments, designations, grades] = await Promise.all([
      db.department.findMany({ where: { isActive: true }, orderBy: { name: "asc" }, select: { id: true, name: true, code: true } }),
      db.designation.findMany({ where: { isActive: true }, orderBy: { name: "asc" }, select: { id: true, name: true, gradeId: true } }),
      db.grade.findMany({ where: { isActive: true }, orderBy: { level: "asc" }, select: { id: true, name: true, level: true } }),
    ]);
    return {
      departments: departments.map((d) => ({ id: d.id, label: d.name })),
      designations: designations.map((d) => ({ id: d.id, label: d.name, gradeId: d.gradeId })),
      grades: grades.map((g) => ({ id: g.id, label: g.name })),
    };
  });
}
