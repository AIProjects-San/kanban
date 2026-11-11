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
import { getWorkspaceConfig } from "@/lib/config-loader";
import type { EmployeeProfileT } from "@/lib/types";
import { employeeProfileSchema, employeeProfileSelfSchema, parseOrThrow } from "@/lib/validation";
import { isoDateOrNull, EMPLOYMENT_STATUS_LABELS } from "@/lib/employment";
import { logAudit } from "./shared";
import { toResult } from "./result";
import type { ActionResult } from "@/lib/action-result";
import { employeeInformationCsv, type DirectoryReportRow } from "@/lib/directory-report";

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
  ActionResult<{ profiles: EmployeeProfileT[]; canAdmin: boolean; retirementAge: number | null }>
> {
  return toResult(async () => {
    const auth = await requirePermission("hr:view");

    // PR-21 — hard caps on both roster queries (a directory beyond ~500
    // people is a paginated-list concern, not a single-render concern).
    const [rows, users, config] = await Promise.all([
      db.employeeProfile.findMany({ orderBy: { createdAt: "asc" }, take: 500 }),
      db.user.findMany({
        where: { deletedAt: null },
        select: { id: true, name: true, email: true, role: true, managerId: true },
        take: 500,
      }),
      // P33 (EM-B02) — the retirement-age display knob (cached 60s like
      // every config read; null = not configured → the modal renders no
      // projection).
      getWorkspaceConfig(),
    ]);
    const usersById = new Map(users.map((u) => [u.id, u]));

    const profiles: EmployeeProfileT[] = [];
    for (const row of rows) {
      const u = usersById.get(row.userId);
      if (!u) continue; // profile of a deleted user — hidden from the roster
      profiles.push(serialize(row, { name: u.name, email: u.email, role: u.role, managerName: await managerNameOf(row.userId, usersById) }));
    }
    return {
      profiles,
      canAdmin: hasPermission(auth.role as never, "hr:admin"),
      retirementAge: config.workspace.retirementAge,
    };
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
// P32 (EM-R02) — the employee_information report export
// ---------------------------------------------------------------------------

/**
 * The employee_information report (benchmark: hrms employee_information):
 * the directory roster rendered as CSV — one row per live member, columns
 * mirroring the roster card's facts (birthday, emergency contact and the
 * HR notes are deliberately NOT exported — the card never displays them
 * and the PII posture keeps them out of data files). hr:view gated (the
 * directory's own gate). Audited like every report export.
 */
export async function exportDirectoryCsv(): Promise<ActionResult<{ filename: string; csv: string; mime: string }>> {
  return toResult(async () => {
    const auth = await requirePermission("hr:view");

    // getDirectory's own reads (PR-21 caps; profiles of deleted users are
    // hidden exactly like the roster cards).
    const [rows, users] = await Promise.all([
      db.employeeProfile.findMany({ orderBy: { createdAt: "asc" }, take: 500 }),
      db.user.findMany({
        where: { deletedAt: null },
        select: { id: true, name: true, email: true, role: true, managerId: true },
        take: 500,
      }),
    ]);
    const usersById = new Map(users.map((u) => [u.id, u]));

    const reportRows: DirectoryReportRow[] = [];
    for (const row of rows) {
      const u = usersById.get(row.userId);
      if (!u) continue; // profile of a deleted user — never exported
      const managerName = u.managerId ? usersById.get(u.managerId)?.name ?? null : null;
      reportRows.push({
        employeeNumber: row.employeeNumber,
        name: u.name,
        email: u.email,
        role: u.role,
        jobTitle: row.jobTitle,
        // The roster card's label (QA-19: "" stays unclassified, not
        // fabricated); an unknown key renders raw, never silently blank.
        department: row.department
          ? DEPARTMENT_LABELS.find((d) => d.key === row.department)?.label ?? row.department
          : "",
        managerName,
        employmentStatus: EMPLOYMENT_STATUS_LABELS[row.employmentStatus as keyof typeof EMPLOYMENT_STATUS_LABELS] ?? row.employmentStatus,
        hireDate: row.hireDate ? row.hireDate.toISOString().slice(0, 10) : "",
        location: row.location,
        skills: row.skills,
      });
    }

    const csv = employeeInformationCsv({ rows: reportRows });
    const today = new Date().toISOString().slice(0, 10);
    await logAudit({
      actor: auth,
      action: "directory.report_exported",
      entityType: "EMPLOYEE_PROFILE",
      entityId: "all",
      entityLabel: "directory export",
      detail: `${auth.name} exported the employee information report (${reportRows.length} member row(s)).`,
    });
    return {
      filename: `employee-information-${today}.csv`,
      csv,
      mime: "text/csv; charset=utf-8",
    };
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
