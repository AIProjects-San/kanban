"use server";

// ---------------------------------------------------------------------------
// P37 (EM-19, PF-07, EM-18) — the skill master + employee skill maps
// (docs/Fernly_HR_Payroll_Enhancement_Plan.md §7.2 P37).
//
// The benchmark's Skill master is SHARED between employee skill maps and
// interview Expected Skill Sets; the free-text profile `skills` string was
// Fernly's only skill surface. This module owns the master CRUD and the
// per-employee rated map:
//
//   • the master (hr:admin CRUD — the hiring:config doc-type discipline;
//     the same rows later feed the interview round templates)
//   • the map (hr:admin writes the rating; every signed-in user reads their
//     own map; the profile card renders the summary + top skills)
//
// The free-text string stays (the quick self-service summary); the map is
// the structured record — one row per (userId, skillKey), label
// snapshotted, rating 1–5 with the proficiency label derived at read.
// ---------------------------------------------------------------------------

import { revalidatePath } from "next/cache";
import { db } from "@/lib/infra/db";
import { requirePermission, checkPermission, AuthorizationError } from "./auth-guard";
import {
  saveSkillSchema,
  deleteSkillSchema,
  upsertEmployeeSkillSchema,
  removeEmployeeSkillSchema,
  parseOrThrow,
} from "@/lib/validation";
import { logAudit } from "./shared";
import { toResult } from "./result";
import type { ActionResult } from "@/lib/action-result";
import type { SkillT, EmployeeSkillT, SkillMapT } from "@/lib/types";
import { skillMapSummary, skillProficiencyLabel } from "@/lib/hr/skills";

// ---------------------------------------------------------------------------
// The master (EM-19 / PF-07)
// ---------------------------------------------------------------------------

/** All skill rows (hr:view — the master feeds every skill surface). */
export async function getSkills(): Promise<ActionResult<SkillT[]>> {
  return toResult(async () => {
    await requirePermission("hr:view");
    const rows = await db.skill.findMany({
      orderBy: [{ sortOrder: "asc" }, { key: "asc" }],
    });
    return rows.map(serialize);
  });
}

function serialize(t: {
  id: string; key: string; label: string; description: string;
  isActive: boolean; sortOrder: number;
}): SkillT {
  return {
    id: t.id, key: t.key, label: t.label, description: t.description,
    isActive: t.isActive, sortOrder: t.sortOrder,
  };
}

/** Create or edit one skill row (hr:admin; the key stays immutable on
 *  edit — rows reference it). */
export async function saveSkill(input: unknown): Promise<ActionResult<{ id: string }>> {
  return toResult(async () => {
    const auth = await requirePermission("hr:admin");
    const data = parseOrThrow(saveSkillSchema, input);
    const row = data.id
      ? await db.skill.update({ where: { id: data.id }, data })
      : await db.skill.create({ data });
    await logAudit({
      actor: auth,
      action: "hr.skill_saved",
      entityType: "SKILL",
      entityId: row.id,
      entityLabel: row.label,
      detail: `${auth.name} ${data.id ? "updated" : "added"} the skill "${row.label}"${data.isActive ? "" : " (inactive)"}.`,
    });
    revalidatePath("/");
    return { id: row.id };
  });
}

/** Remove one skill row (hr:admin). Employee maps keep their history —
 *  the row is gone from the pickers, existing ratings stay (label
 *  snapshotted); map rows referencing the deleted key are removable but
 *  never silently rewritten. */
export async function deleteSkill(input: unknown): Promise<ActionResult<{ ok: true }>> {
  return toResult(async () => {
    const auth = await requirePermission("hr:admin");
    const data = parseOrThrow(deleteSkillSchema, input);
    const row = await db.skill.delete({ where: { id: data.id } });
    await logAudit({
      actor: auth,
      action: "hr.skill_deleted",
      entityType: "SKILL",
      entityId: row.id,
      entityLabel: row.label,
      detail: `${auth.name} removed the skill "${row.label}" from the master (existing map rows keep their history).`,
    });
    revalidatePath("/");
    return { ok: true };
  });
}

// ---------------------------------------------------------------------------
// The employee map (EM-18)
// ---------------------------------------------------------------------------

/** One employee's rated skill map + the ACTIVE master (hr:view for any
 *  employee; a member reading their own gets their rows, canManage false). */
export async function getSkillMap(input: {
  userId?: string;
}): Promise<ActionResult<SkillMapT>> {
  return toResult(async () => {
    const auth = await requirePermission("settings:edit");
    const isSelf = !input.userId || input.userId === auth.userId;
    const canManage = await checkPermission(auth.role, "hr:view");
    if (!isSelf && !canManage) {
      throw new AuthorizationError("You can only view your own skill map.");
    }
    const userId = isSelf ? auth.userId : input.userId!;
    const [rows, skills, users] = await Promise.all([
      db.employeeSkill.findMany({ where: { userId }, orderBy: { label: "asc" } }),
      db.skill.findMany({ where: { isActive: true }, orderBy: [{ sortOrder: "asc" }, { key: "asc" }] }),
      db.user.findMany({
        where: { id: { in: [userId] } },
        select: { id: true, name: true },
      }),
    ]);
    const names = new Map(users.map((u) => [u.id, u.name]));
    const entries: EmployeeSkillT[] = rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      userName: names.get(r.userId) ?? "(former user)",
      skillKey: r.skillKey,
      label: r.label,
      rating: r.rating,
      proficiency: skillProficiencyLabel(r.rating),
      notes: r.notes,
      assessedBy: r.assessedById ? names.get(r.assessedById) ?? null : null,
      assessedAt: r.assessedAt ? r.assessedAt.toISOString() : null,
    }));
    return {
      entries,
      skills: skills.map(serialize),
      summary: skillMapSummary(entries).summary,
      canManage,
    };
  });
}

/** HR rates one skill on an employee's map — idempotent upsert on
 *  (userId, skillKey) with the label snapshot and the assessor stamped. */
export async function upsertEmployeeSkill(input: unknown): Promise<ActionResult<{ id: string }>> {
  return toResult(async () => {
    const auth = await requirePermission("hr:admin");
    const data = parseOrThrow(upsertEmployeeSkillSchema, input);
    const [employee, skill] = await Promise.all([
      db.user.findUnique({ where: { id: data.userId }, select: { id: true, name: true, deletedAt: true } }),
      db.skill.findUnique({ where: { key: data.skillKey } }),
    ]);
    if (!employee || employee.deletedAt) throw new AuthorizationError("Employee not found.");
    if (!skill || !skill.isActive) {
      throw new AuthorizationError("Unknown or inactive skill.");
    }
    const row = await db.employeeSkill.upsert({
      where: { userId_skillKey: { userId: employee.id, skillKey: skill.key } },
      create: {
        userId: employee.id,
        skillKey: skill.key,
        label: skill.label, // snapshot — renames don't rewrite history
        rating: data.rating,
        notes: data.notes,
        assessedById: auth.userId,
        assessedAt: new Date(),
      },
      update: {
        rating: data.rating,
        notes: data.notes,
        assessedById: auth.userId,
        assessedAt: new Date(),
      },
    });
    await logAudit({
      actor: auth,
      action: "hr.employee_skill_rated",
      entityType: "EMPLOYEE_SKILL",
      entityId: row.id,
      entityLabel: `${employee.name} — ${skill.label}`,
      detail: `${auth.name} rated "${skill.label}" ${data.rating}/5 (${skillProficiencyLabel(data.rating)}) for ${employee.name}.`,
    });
    revalidatePath("/");
    return { id: row.id };
  });
}

/** HR removes one rating from an employee's map (hr:admin). */
export async function removeEmployeeSkill(input: unknown): Promise<ActionResult<{ ok: true }>> {
  return toResult(async () => {
    const auth = await requirePermission("hr:admin");
    const data = parseOrThrow(removeEmployeeSkillSchema, input);
    const row = await db.employeeSkill.findUnique({ where: { id: data.id } });
    if (!row) throw new AuthorizationError("Skill rating not found.");
    await db.employeeSkill.delete({ where: { id: row.id } });
    await logAudit({
      actor: auth,
      action: "hr.employee_skill_removed",
      entityType: "EMPLOYEE_SKILL",
      entityId: row.id,
      entityLabel: row.label,
      detail: `${auth.name} removed the "${row.label}" rating from the map.`,
    });
    revalidatePath("/");
    return { ok: true };
  });
}
