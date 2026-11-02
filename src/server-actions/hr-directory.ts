"use server";

// ---------------------------------------------------------------------------
// HR Module feature 2 — employee directory server actions
// (docs/HR_MODULE_PLAN.md §5).
//
// RBAC:
//   hr:view     — read the full directory (Admin, Manager, HR)
//   hr:admin    — edit ANY profile (Admin, HR)
//   settings:edit — edit YOUR OWN profile (self-service baseline)
//
// The org chart (manager display) comes from User.managerId — this module
// never writes it (role:manage owns that in users.ts).
// ---------------------------------------------------------------------------

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requirePermission, AuthorizationError } from "./auth-guard";
import { hasPermission } from "@/lib/rbac";
import { DEPARTMENT_LABELS } from "@/lib/config";
import type { EmployeeProfileT } from "@/lib/types";
import { employeeProfileSchema, parseOrThrow } from "@/lib/validation";
import { logAudit } from "./shared";
import { toResult } from "./result";
import type { ActionResult } from "@/lib/action-result";

const VALID_DEPARTMENTS = new Set(DEPARTMENT_LABELS.map((d) => d.key));

function serialize(
  row: {
    id: string; userId: string; jobTitle: string; department: string;
    hireDate: Date | null; phone: string; location: string;
    emergencyContactName: string; emergencyContactPhone: string;
    skills: string; notes: string; createdAt: Date; updatedAt: Date;
  },
  user: { name: string; email: string; role: string; managerName: string | null },
): EmployeeProfileT {
  return {
    id: row.id,
    userId: row.userId,
    name: user.name,
    email: user.email,
    role: user.role,
    managerName: user.managerName,
    jobTitle: row.jobTitle,
    department: row.department as EmployeeProfileT["department"],
    hireDate: row.hireDate ? row.hireDate.toISOString().slice(0, 10) : null,
    phone: row.phone,
    location: row.location,
    emergencyContactName: row.emergencyContactName,
    emergencyContactPhone: row.emergencyContactPhone,
    skills: row.skills,
    notes: row.notes,
  };
}

/** Resolve the manager display name from the org chart (User.managerId). */
async function managerNameOf(userId: string, usersById: Map<string, { name: string; email: string; role: string; managerId: string | null }>): Promise<string | null> {
  const u = usersById.get(userId);
  if (!u?.managerId) return null;
  return usersById.get(u.managerId)?.name ?? null;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getDirectory(): Promise<
  ActionResult<{ profiles: EmployeeProfileT[]; canAdmin: boolean }>
> {
  return toResult(async () => {
    const auth = await requirePermission("hr:view");

    const [rows, users] = await Promise.all([
      db.employeeProfile.findMany({ orderBy: { createdAt: "asc" } }),
      db.user.findMany({
        where: { deletedAt: null },
        select: { id: true, name: true, email: true, role: true, managerId: true },
      }),
    ]);
    const usersById = new Map(users.map((u) => [u.id, u]));

    const profiles: EmployeeProfileT[] = [];
    for (const row of rows) {
      const u = usersById.get(row.userId);
      if (!u) continue; // profile of a deleted user — hidden from the roster
      profiles.push(serialize(row, { name: u.name, email: u.email, role: u.role, managerName: await managerNameOf(row.userId, usersById) }));
    }
    return { profiles, canAdmin: hasPermission(auth.role as never, "hr:admin") };
  });
}

export async function getMyProfile(): Promise<ActionResult<EmployeeProfileT | null>> {
  return toResult(async () => {
    const auth = await requirePermission("settings:edit");
    const row = await db.employeeProfile.findUnique({ where: { userId: auth.userId } });
    if (!row) return null;
    const me = await db.user.findUnique({
      where: { id: auth.userId },
      select: { name: true, email: true, role: true, managerId: true },
    });
    if (!me) return null;
    const manager = me.managerId
      ? await db.user.findUnique({ where: { id: me.managerId }, select: { name: true } })
      : null;
    return serialize(row, { name: me.name, email: me.email, role: me.role, managerName: manager?.name ?? null });
  });
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export async function upsertMyProfile(input: {
  jobTitle?: string;
  department?: string;
  hireDate?: string | null;
  phone?: string;
  location?: string;
  emergencyContactName?: string;
  emergencyContactPhone?: string;
  skills?: string;
}): Promise<ActionResult<void>> {
  return toResult(async () => {
    const auth = await requirePermission("settings:edit");
    const data = parseOrThrow(employeeProfileSchema, input);
    if (data.department && !VALID_DEPARTMENTS.has(data.department)) {
      throw new AuthorizationError("Unknown department.");
    }

    await db.employeeProfile.upsert({
      where: { userId: auth.userId },
      create: {
        userId: auth.userId,
        jobTitle: data.jobTitle ?? "",
        department: data.department ?? "ENGINEERING",
        hireDate: data.hireDate ? new Date(`${data.hireDate}T00:00:00.000Z`) : null,
        phone: data.phone ?? "",
        location: data.location ?? "",
        emergencyContactName: data.emergencyContactName ?? "",
        emergencyContactPhone: data.emergencyContactPhone ?? "",
        skills: data.skills ?? "",
      },
      update: {
        ...(data.jobTitle !== undefined ? { jobTitle: data.jobTitle } : {}),
        ...(data.department !== undefined ? { department: data.department } : {}),
        ...(data.hireDate !== undefined ? { hireDate: data.hireDate ? new Date(`${data.hireDate}T00:00:00.000Z`) : null } : {}),
        ...(data.phone !== undefined ? { phone: data.phone } : {}),
        ...(data.location !== undefined ? { location: data.location } : {}),
        ...(data.emergencyContactName !== undefined ? { emergencyContactName: data.emergencyContactName } : {}),
        ...(data.emergencyContactPhone !== undefined ? { emergencyContactPhone: data.emergencyContactPhone } : {}),
        ...(data.skills !== undefined ? { skills: data.skills } : {}),
      },
    });

    await logAudit({
      actor: auth,
      action: "profile.updated",
      entityType: "EMPLOYEE_PROFILE",
      entityId: auth.userId,
      entityLabel: auth.name,
      detail: `${auth.name} updated their employee profile.`,
    });
    revalidatePath("/");
  });
}

export async function updateProfileAsAdmin(userId: string, input: {
  jobTitle?: string;
  department?: string;
  hireDate?: string | null;
  phone?: string;
  location?: string;
  emergencyContactName?: string;
  emergencyContactPhone?: string;
  skills?: string;
  notes?: string;
}): Promise<ActionResult<void>> {
  return toResult(async () => {
    const auth = await requirePermission("hr:admin");
    const data = parseOrThrow(employeeProfileSchema, input);
    if (data.department && !VALID_DEPARTMENTS.has(data.department)) {
      throw new AuthorizationError("Unknown department.");
    }
    const target = await db.user.findUnique({ where: { id: userId }, select: { id: true, name: true, deletedAt: true } });
    if (!target || target.deletedAt) throw new AuthorizationError("User not found.");

    const hireDate = data.hireDate !== undefined
      ? data.hireDate ? new Date(`${data.hireDate}T00:00:00.000Z`) : null
      : undefined;

    await db.employeeProfile.upsert({
      where: { userId },
      create: {
        userId,
        jobTitle: data.jobTitle ?? "",
        department: data.department ?? "ENGINEERING",
        hireDate: hireDate ?? null,
        phone: data.phone ?? "",
        location: data.location ?? "",
        emergencyContactName: data.emergencyContactName ?? "",
        emergencyContactPhone: data.emergencyContactPhone ?? "",
        skills: data.skills ?? "",
        notes: data.notes ?? "",
      },
      update: {
        ...(data.jobTitle !== undefined ? { jobTitle: data.jobTitle } : {}),
        ...(data.department !== undefined ? { department: data.department } : {}),
        ...(hireDate !== undefined ? { hireDate } : {}),
        ...(data.phone !== undefined ? { phone: data.phone } : {}),
        ...(data.location !== undefined ? { location: data.location } : {}),
        ...(data.emergencyContactName !== undefined ? { emergencyContactName: data.emergencyContactName } : {}),
        ...(data.emergencyContactPhone !== undefined ? { emergencyContactPhone: data.emergencyContactPhone } : {}),
        ...(data.skills !== undefined ? { skills: data.skills } : {}),
        ...(data.notes !== undefined ? { notes: data.notes } : {}),
      },
    });

    await logAudit({
      actor: auth,
      action: "profile.updated",
      entityType: "EMPLOYEE_PROFILE",
      entityId: userId,
      entityLabel: target.name,
      detail: `${auth.name} updated ${target.name}'s employee profile (HR console).`,
    });
    revalidatePath("/");
  });
}
