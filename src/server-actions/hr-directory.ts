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
import { employeeProfileSchema, employeeProfileSelfSchema, parseOrThrow } from "@/lib/validation";
import { isoDateOrNull } from "@/lib/employment";
import { logAudit } from "./shared";
import { toResult } from "./result";
import type { ActionResult } from "@/lib/action-result";

// QA-19: "" (not classified yet) is a valid stored value, so the set is
// keyed by plain strings; the four real departments remain the only
// classifiable keys.
const VALID_DEPARTMENTS = new Set<string>(DEPARTMENT_LABELS.map((d) => d.key));

function serialize(
  row: {
    id: string; userId: string; employeeNumber: string | null; leaveApproverId: string | null; jobTitle: string; department: string;
    hireDate: Date | null; birthDate: Date | null; phone: string; location: string;
    emergencyContactName: string; emergencyContactPhone: string;
    skills: string; notes: string; createdAt: Date; updatedAt: Date;
    employmentStatus: string; probationEndsAt: Date | null;
    noticePeriodWeeks: number | null; lastWorkingDay: Date | null;
  },
  user: { name: string; email: string; role: string; managerName: string | null },
): EmployeeProfileT {
  return {
    id: row.id,
    userId: row.userId,
    employeeNumber: row.employeeNumber,
    leaveApproverId: row.leaveApproverId ?? null,
    name: user.name,
    email: user.email,
    role: user.role,
    managerName: user.managerName,
    jobTitle: row.jobTitle,
    department: row.department as EmployeeProfileT["department"],
    hireDate: row.hireDate ? row.hireDate.toISOString().slice(0, 10) : null,
    birthDate: row.birthDate ? row.birthDate.toISOString().slice(0, 10) : null,
    phone: row.phone,
    location: row.location,
    emergencyContactName: row.emergencyContactName,
    emergencyContactPhone: row.emergencyContactPhone,
    skills: row.skills,
    notes: row.notes,
    // F1.6 — employment lifecycle ("" = not tracked, rendered as "—").
    employmentStatus: row.employmentStatus as EmployeeProfileT["employmentStatus"],
    probationEndsAt: isoDateOrNull(row.probationEndsAt),
    noticePeriodWeeks: row.noticePeriodWeeks,
    lastWorkingDay: isoDateOrNull(row.lastWorkingDay),
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

    // PR-21 — hard caps on both roster queries (a directory beyond ~500
    // people is a paginated-list concern, not a single-render concern).
    const [rows, users] = await Promise.all([
      db.employeeProfile.findMany({ orderBy: { createdAt: "asc" }, take: 500 }),
      db.user.findMany({
        where: { deletedAt: null },
        select: { id: true, name: true, email: true, role: true, managerId: true },
        take: 500,
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
  phone?: string;
  location?: string;
  emergencyContactName?: string;
  emergencyContactPhone?: string;
  skills?: string;
}): Promise<ActionResult<void>> {
  return toResult(async () => {
    const auth = await requirePermission("settings:edit");
    // QA-10: self-service is CONTACT-FIELDS-ONLY (docs/HR_MODULE_PLAN.md §5:
    // "Self-service edit of own contact fields; HR/ADMIN edit everything").
    // The strict self schema rejects jobTitle / department / hireDate /
    // notes — job data used to be self-certifiable (any member could set
    // their own directory job title to "CTO").
    const data = parseOrThrow(employeeProfileSelfSchema, input);

    await db.employeeProfile.upsert({
      where: { userId: auth.userId },
      create: {
        userId: auth.userId,
        jobTitle: "",
        // QA-19: no fabricated classification — "" renders as "—" until HR
        // sets the department via the admin path. (Used to stamp
        // "ENGINEERING", so self-created profiles polluted the shared
        // roster with an HR-owned fact nobody had asserted.)
        department: "",
        hireDate: null,
        phone: data.phone ?? "",
        location: data.location ?? "",
        emergencyContactName: data.emergencyContactName ?? "",
        emergencyContactPhone: data.emergencyContactPhone ?? "",
        skills: data.skills ?? "",
      },
      update: {
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
  /** P25 (PL-02) — the birthday engine's input (null clears it). */
  birthDate?: string | null;
  phone?: string;
  location?: string;
  emergencyContactName?: string;
  emergencyContactPhone?: string;
  skills?: string;
  notes?: string;
  // F1.6 — the three PLAIN employment facts are HR-editable here. The
  // STATUS is not (its strict schema rejects employmentStatus): status
  // changes must go through the guarded transitionEmployment action.
  probationEndsAt?: string | null;
  noticePeriodWeeks?: number | null;
  lastWorkingDay?: string | null;
  /** S14 — the leave-approver override (null clears it back to the
   * reporting-manager rule). */
  leaveApproverId?: string | null;
}): Promise<ActionResult<void>> {
  return toResult(async () => {
    const auth = await requirePermission("hr:admin");
    const data = parseOrThrow(employeeProfileSchema, input);
    if (data.department && !VALID_DEPARTMENTS.has(data.department)) {
      throw new AuthorizationError("Unknown department.");
    }
    const target = await db.user.findUnique({ where: { id: userId }, select: { id: true, name: true, deletedAt: true } });
    if (!target || target.deletedAt) throw new AuthorizationError("User not found.");

    // S14 — the override target must be a real, live member and NOT the
    // employee themselves (deciding your own leave is the manager chain's
    // job, never a self-assignment).
    if (data.leaveApproverId) {
      if (data.leaveApproverId === userId) {
        throw new AuthorizationError("An employee cannot be their own leave approver — pick another member or clear the override.");
      }
      const approver = await db.user.findUnique({
        where: { id: data.leaveApproverId },
        select: { id: true, name: true, deletedAt: true },
      });
      if (!approver || approver.deletedAt) {
        throw new AuthorizationError("Leave approver not found — pick a current member.");
      }
    }

    const hireDate = data.hireDate !== undefined
      ? data.hireDate ? new Date(`${data.hireDate}T00:00:00.000Z`) : null
      : undefined;
    const birthDate = data.birthDate !== undefined
      ? data.birthDate ? new Date(`${data.birthDate}T00:00:00.000Z`) : null
      : undefined;
    const probationEndsAt = data.probationEndsAt !== undefined
      ? data.probationEndsAt ? new Date(`${data.probationEndsAt}T00:00:00.000Z`) : null
      : undefined;
    const lastWorkingDay = data.lastWorkingDay !== undefined
      ? data.lastWorkingDay ? new Date(`${data.lastWorkingDay}T00:00:00.000Z`) : null
      : undefined;

    await db.employeeProfile.upsert({
      where: { userId },
      create: {
        userId,
        jobTitle: data.jobTitle ?? "",
        // QA-19: same no-fabrication rule on the admin create branch — an
        // HR save without a picked department leaves it unset, not
        // "ENGINEERING".
        department: data.department ?? "",
        hireDate: hireDate ?? null,
        birthDate: birthDate ?? null,
        phone: data.phone ?? "",
        location: data.location ?? "",
        emergencyContactName: data.emergencyContactName ?? "",
        emergencyContactPhone: data.emergencyContactPhone ?? "",
        skills: data.skills ?? "",
        notes: data.notes ?? "",
        ...(probationEndsAt ? { probationEndsAt } : {}),
        ...(data.noticePeriodWeeks != null ? { noticePeriodWeeks: data.noticePeriodWeeks } : {}),
        ...(lastWorkingDay ? { lastWorkingDay } : {}),
        ...(data.leaveApproverId !== undefined ? { leaveApproverId: data.leaveApproverId } : {}),
      },
      update: {
        ...(data.jobTitle !== undefined ? { jobTitle: data.jobTitle } : {}),
        ...(data.department !== undefined ? { department: data.department } : {}),
        ...(hireDate !== undefined ? { hireDate } : {}),
        ...(birthDate !== undefined ? { birthDate } : {}),
        ...(data.phone !== undefined ? { phone: data.phone } : {}),
        ...(data.location !== undefined ? { location: data.location } : {}),
        ...(data.emergencyContactName !== undefined ? { emergencyContactName: data.emergencyContactName } : {}),
        ...(data.emergencyContactPhone !== undefined ? { emergencyContactPhone: data.emergencyContactPhone } : {}),
        ...(data.skills !== undefined ? { skills: data.skills } : {}),
        ...(data.notes !== undefined ? { notes: data.notes } : {}),
        ...(probationEndsAt !== undefined ? { probationEndsAt } : {}),
        ...(data.noticePeriodWeeks !== undefined ? { noticePeriodWeeks: data.noticePeriodWeeks } : {}),
        ...(lastWorkingDay !== undefined ? { lastWorkingDay } : {}),
        ...(data.leaveApproverId !== undefined ? { leaveApproverId: data.leaveApproverId } : {}),
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
