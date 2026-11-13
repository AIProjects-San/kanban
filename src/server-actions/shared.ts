// SERVER-ONLY shared helpers for the server-action modules.
//
// NOTE: This file intentionally does NOT have "use server" — it exports
// non-async values and is imported by the domain action modules below,
// never by client components.

import { db } from "@/lib/infra/db";
import { hasPermission, type Role } from "@/lib/auth/rbac";
import { getSubtreeUserIds } from "@/lib/auth/hierarchy";
import { checkPermission } from "./auth-guard";
import { AuthorizationError } from "@/lib/auth/authorization-error";
import { Prisma } from "@prisma/client";
import {
  resolveTemplateAssignee,
  templateForKind,
  type OnboardingTemplateTaskRow,
} from "@/lib/hr/onboarding-template";
import { addWorkingDays, type HolidayLookup } from "@/lib/working-days";

// Audit + outbox infrastructure lives in lib (cron jobs and lib kernels use
// it without importing the action layer); re-exported here for the action
// files' existing imports.
export { logAudit, logAuditOn, getClientInfo } from "@/lib/audit/audit";
export {
  sendOutboxMail,
  queueOutboxMail,
  deliverOutboxMail,
} from "@/lib/email/mail-outbox";

/** Short day-month for audit detail lines (Date input, no year — the
 *  detail string carries the full context). The client-side iso-string
 *  formatter with the year lives in lib/format.ts. */
export function fmtDayDate(d: Date) {
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

/**
 * PR-18 (production-readiness audit) — read an admin-editable display limit
 * from the Workspace row. The three limits (auditLogLimit, entityHistoryLimit,
 * dashboardNotifLimit) were admin-editable in Workspace Settings but the read
 * paths hardcoded the defaults (300 / 50 / 20) — the app's own audit standard
 * is "a setting must either work or be absent". This helper honours the
 * configured value with the previous default as fallback, clamped to `max` so
 * a fat-fingered 1,000,000 can't OOM a view. Tolerant of a missing/erroring
 * Workspace row (defaults apply), so it is safe on every read path.
 */
export async function getWorkspaceLimit(
  field: "auditLogLimit" | "entityHistoryLimit" | "dashboardNotifLimit",
  fallback: number,
  max: number,
): Promise<number> {
  try {
    const ws = await db.workspace.findFirst({
      where: { id: "default" },
      select: { [field]: true },
    });
    const v = ws?.[field];
    return typeof v === "number" && v > 0 ? Math.min(Math.floor(v), max) : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Resolve the TeamMember id that belongs to the signed-in user. Prefers
 * the stable TeamMember.userId link; falls back to a unique-email match for
 * rows not yet linked. Returns null if the user has no team-member record.
 */
export async function getMyTeamMemberId(auth: { userId: string; email: string }): Promise<string | null> {
  // P2 (edge-case audit) — filter deletedAt: null on both lookups. A soft-
  // deleted TeamMember row (set by deleteUser) should not authorise task
  // edits via assertTaskEditPermission. The JWT refresh window (5 min) means
  // a soft-deleted user's token is still valid briefly; this filter closes
  // the gap so they can't edit "their" tasks during that window.
  const byUser = await db.teamMember.findUnique({
    where: { userId: auth.userId, deletedAt: null },
    select: { id: true },
  });
  if (byUser) return byUser.id;
  const member = await db.teamMember.findUnique({
    where: { email: auth.email.toLowerCase(), deletedAt: null },
    select: { id: true },
  });
  return member?.id ?? null;
}

// ---------------------------------------------------------------------------
// Deep-dive review F-03 — one canonical data-scoping helper.
//
// getDashboardData always scoped MEMBER/MANAGER reads to "projects you own,
// have tasks in, or are explicitly assigned to". Several later read paths
// (pagination, search, project members) forgot that rule and returned
// workspace-wide data to any signed-in user. Everything now funnels through
// this helper so the scopes can never drift apart again.
//
// Returns:
//   • null  → unscoped (ADMIN) — the caller sees the whole workspace.
//   • Set   → the caller's project ids (possibly empty).
// ---------------------------------------------------------------------------

export async function getScopedProjectIds(
  auth: { userId: string; role: string },
): Promise<Set<string> | null> {
  if (auth.role === "ADMIN") return null;
  // PR-21 — safety caps on the three scoping queries. A user genuinely
  // associated with >1000 projects is a pagination/reporting concern; the
  // cap bounds the Set size (and the IN-clauses built from it) instead.
  const [owned, assignedProjects, explicitAssignments] = await Promise.all([
    db.project.findMany({
      where: { ownerUserId: auth.userId },
      select: { id: true },
      take: 1000,
    }),
    db.task.findMany({
      where: { assignee: { userId: auth.userId } },
      select: { projectId: true },
      distinct: ["projectId"],
      take: 1000,
    }),
    db.projectAssignment.findMany({
      where: { userId: auth.userId },
      select: { projectId: true },
      take: 1000,
    }),
  ]);
  return new Set([
    ...owned.map((p) => p.id),
    ...assignedProjects.map((t) => t.projectId).filter(Boolean) as string[],
    ...explicitAssignments.map((a) => a.projectId),
  ]);
}

// ---------------------------------------------------------------------------
// PR-53 — visible-member resolution for the time-entries read path.
//
// getDashboardData scopes time entries to "members the viewer can already
// see" (members of their projects + themselves) — a data-minimization rule
// that prevents a MEMBER from seeing another member's time logs just
// because they happen to share a project. getTimeEntriesPage previously
// used a different, project-centric scope (`projectId in scoped OR member
// is me`) which leaked: a non-visible member's entry on a visible project
// was returned with that member's name. This helper mirrors the dashboard's
// member-visibility rule so the two read paths can't drift apart.
//
// Returns:
//   • null  → unscoped (ADMIN) — the caller sees every member's entries.
//   • Set   → the TeamMember ids whose entries the caller may see
//             (possibly empty — a scoped user with no visible members
//             sees no entries at all, which is correct).
//
// ---------------------------------------------------------------------------

/** The member-visibility where-clause every scoped read path shares:
 *  members with tasks in the viewer's projects, members staffed on them,
 *  and the viewer. getDashboardData builds its memberWhere from this and
 *  getVisibleMemberIds queries it directly — one rule, two read paths. */
export async function visibleMemberWhere(
  projectIdArray: string[],
  viewerUserId: string,
): Promise<Prisma.TeamMemberWhereInput> {
  const assignedUserIds = await db.projectAssignment.findMany({
    where: { projectId: { in: projectIdArray } },
    select: { userId: true },
    take: 1000,
  }).then((rows) => rows.map((r) => r.userId));
  return {
    OR: [
      { tasks: { some: { projectId: { in: projectIdArray } } } },
      { userId: { in: assignedUserIds } },
      { userId: viewerUserId },
    ],
  };
}

export async function getVisibleMemberIds(
  auth: { userId: string; role: string },
  scopedIds: Set<string> | null,
): Promise<Set<string> | null> {
  // ADMIN → unscoped. Mirrors getScopedProjectIds returning null for admins.
  if (scopedIds === null) return null;

  // Scoped user with no projects — only their own member row (if any).
  // A roster-less user (no TeamMember row) sees no time entries.
  if (scopedIds.size === 0) {
    const me = await db.teamMember.findUnique({
      where: { userId: auth.userId, deletedAt: null },
      select: { id: true },
    });
    return me?.id ? new Set([me.id]) : new Set();
  }

  const projectIdArray = Array.from(scopedIds);
  const members = await db.teamMember.findMany({
    where: { ...(await visibleMemberWhere(projectIdArray, auth.userId)), deletedAt: null },
    select: { id: true },
    take: 1000,
  });
  return new Set(members.map((m) => m.id));
}

// ---------------------------------------------------------------------------
// Project association — the canonical "user is associated with a project"
// rule used by every assignee validation.
//
// A user is associated with a project when they are EXPLICITLY staffed on it
// (a ProjectAssignment row — the admin "assign user to project" relation) or
// when they own the project (Project.ownerUserId). Task-assignee history is
// deliberately NOT part of the rule: "you can be assigned because you were
// assigned" is circular and would let stale assignments bootstrap themselves.
//
// Enforced at write time by:
//   • createTask / updateTask / bulkUpdateTasks (Task.assigneeId)
//   • createBug / updateBug / assignBug (Bug.assigneeUserId)
// Read paths (dashboards, boards) do not re-validate legacy rows.
// ---------------------------------------------------------------------------

/**
 * Resolve the set of user ids associated with a project (explicit
 * ProjectAssignment rows + the project owner). Returns null when the project
 * does not exist or is soft-deleted, so callers can distinguish "unknown
 * project" from "known project with zero associated users".
 */
export async function getProjectAssociatedUserIds(
  projectId: string,
): Promise<Set<string> | null> {
  const project = await db.project.findUnique({
    where: { id: projectId },
    select: { ownerUserId: true, deletedAt: true },
  });
  if (!project || project.deletedAt) return null;
  const assignments = await db.projectAssignment.findMany({
    where: { projectId },
    select: { userId: true },
    // PR-21 — safety cap.
    take: 1000,
  });
  const ids = new Set(assignments.map((a) => a.userId));
  if (project.ownerUserId) ids.add(project.ownerUserId);
  return ids;
}

/**
 * Assert that a USER may be assigned work in a project: they must be
 * explicitly staffed on it (ProjectAssignment) or own it.
 */
export async function assertUserAssociatedWithProject(
  userId: string,
  projectId: string,
): Promise<void> {
  const ids = await getProjectAssociatedUserIds(projectId);
  if (ids === null) throw new AuthorizationError("Project not found.");
  if (!ids.has(userId)) {
    throw new AuthorizationError(
      "This user is not assigned to that project. Assign the user to the project first (Team → project assignments).",
    );
  }
}

/**
 * Assert that a TEAM MEMBER (task assignees are TeamMember ids) may be
 * assigned work in a project. Resolves the member's linked User account —
 * roster entries without a login can never satisfy the project-association
 * rule, so they are rejected with a clear message.
 */
export async function assertTeamMemberAssociatedWithProject(
  memberId: string,
  projectId: string,
): Promise<void> {
  const member = await db.teamMember.findUnique({
    where: { id: memberId },
    select: { userId: true, deletedAt: true },
  });
  if (!member || member.deletedAt) throw new AuthorizationError("Assignee not found.");
  if (!member.userId) {
    throw new AuthorizationError(
      "This team member has no linked user account and cannot be assigned to project work.",
    );
  }
  await assertUserAssociatedWithProject(member.userId, projectId);
}

/**
 * Enforce task edit rights for the signed-in user.
 * `task:edit:any` — may edit anything. `task:edit:own` (without :any) — may
 * only edit tasks assigned to them; anything else is an authorization error.
 */
export async function assertTaskEditPermission(
  auth: { userId: string; email: string; role: Role },
  task: { assigneeId: string | null },
) {
  if (hasPermission(auth.role, "task:edit:any")) return;
  const myMemberId = await getMyTeamMemberId(auth);
  if (!task.assigneeId || task.assigneeId !== myMemberId) {
    throw new AuthorizationError("You can only edit tasks that are assigned to you.");
  }
}

// PR-61 — task-delete rights are row-level, not a blanket RBAC grant:
// `task:delete` stays ADMIN-only in the matrix, and this helper layers the
// user-approved rules on top for everyone else:
//
//   1. ADMIN                       — any task (the blanket permission).
//   2. the assigned user           — their own task, whatever their role.
//   3. the project owner           — any task in a project they own
//                                    (ownership implies stewardship), any role.
//   4. a MANAGER of that team      — tasks whose assignee OR project owner
//                                    reports to them (direct or transitive —
//                                    getSubtreeUserIds walks the managerId
//                                    chain). Managers outside the chain, and
//                                    any other role, are rejected.
//
// Unassigned tasks in projects nobody "owns" for the caller are deletable by
// ADMIN (and a chain manager of the project owner) only. The client mirrors
// this predicate in lib/task-delete.ts to decide whether to render the
// Delete button; the server remains the source of truth.
export async function assertTaskDeletePermission(
  auth: { userId: string; email: string; role: Role },
  task: { assigneeId: string | null; projectId: string | null },
) {
  // 1. The blanket task:delete permission — static floor OR the DB ceiling
  //    (the client mirror reads the same effective set).
  if (await checkPermission(auth.role, "task:delete")) return;

  // 2. The assigned user may delete their own task (any role).
  const myMemberId = await getMyTeamMemberId(auth);
  if (task.assigneeId && task.assigneeId === myMemberId) return;

  // Project context — fetched once for rules 3 + 4.
  let ownerUserId: string | null = null;
  if (task.projectId) {
    const project = await db.project.findUnique({
      where: { id: task.projectId },
      select: { ownerUserId: true },
    });
    ownerUserId = project?.ownerUserId ?? null;

    // 3. The project owner may delete tasks in their project (any role).
    if (ownerUserId && ownerUserId === auth.userId) return;
  }

  // 4. MANAGER — the assignee or the project owner must report to them.
  if (auth.role === "MANAGER") {
    const subjects: string[] = [];
    if (task.assigneeId) {
      const assignee = await db.teamMember.findUnique({
        where: { id: task.assigneeId },
        select: { userId: true },
      });
      if (assignee?.userId) subjects.push(assignee.userId);
    }
    if (ownerUserId) subjects.push(ownerUserId);
    if (subjects.length > 0) {
      const subtree = await getSubtreeUserIds(auth.userId);
      if (subjects.some((s) => subtree.has(s))) return;
    }
  }

  throw new AuthorizationError(
    "Only the assigned user, the project owner, a manager of that team, or an admin can delete this task.",
  );
}

/**
 * Recompute the denormalized workload counters on a team member after any
 * task mutation that could change them.
 *
 * Capacity is read from `Workspace.workloadFullCapacity` (admin-editable in
 * Workspace Settings) — closing L-P0-16. Falls back to 6 if the workspace
 * row is missing or the configured value is invalid (<= 0).
 */
export async function recalcMemberStats(memberId: string | null) {
  if (!memberId) return;
  // PR-20 (production-readiness audit) — two indexed COUNT queries instead of
  // fetching every task row and counting in JS. A member with a long task
  // history used to transfer all of it on every task mutation (and once per
  // distinct assignee in bulk updates); the counts are O(index) now.
  const [open, completed] = await Promise.all([
    db.task.count({ where: { assigneeId: memberId, status: { not: "DONE" } } }),
    db.task.count({ where: { assigneeId: memberId, status: "DONE" } }),
  ]);
  const workspace = await db.workspace.findUnique({
    where: { id: "default" },
    select: { workloadFullCapacity: true },
  });
  const capacity = workspace?.workloadFullCapacity && workspace.workloadFullCapacity > 0
    ? workspace.workloadFullCapacity
    : 6;
  const workload = Math.min(100, Math.round((open / capacity) * 100));
  await db.teamMember.update({
    where: { id: memberId },
    data: { openTasks: open, completedTasks: completed, workload },
  });
}

// F2.10 — joining-hardening shared helpers (used by hiring.ts AND
// hr-onboarding.ts). The outbox senders live in lib/email/mail-outbox.

/**
 * F2.10 (F-R8) — read the onboarding template rows for a kind, falling back
 * to the canonical constants when the table has no ACTIVE rows for it (a
 * fresh install is never template-less). One read path shared by
 * createChecklist and markJoined — the third copy (joiner-handout's client
 * list) now rides markJoined's return value instead.
 */
export async function readOnboardingTemplate(
  kind: "ONBOARDING" | "SEPARATION",
): Promise<Omit<OnboardingTemplateTaskRow, "id" | "isActive" | "sortOrder">[]> {
  const rows = await db.onboardingTemplateTask.findMany({
    where: { kind },
    orderBy: { sortOrder: "asc" },
  });
  return templateForKind(kind, rows);
}

/**
 * F2.10 (F-R8) — instantiate a checklist from template rows INSIDE a
 * transaction: self tasks to the hire/leaver, the rest to their manager
 * when one exists (else unassigned — HR picks up). This is the exact
 * createChecklist discipline markJoined previously drifted from; both
 * writers now call this one function.
 *
 * P35 (EM-12/EM-B06) — template depth rides the same rows: a pinned
 * assigneeUserId lands the task on that user; a role key keeps it
 * role-scoped (assigneeId NULL — every holder sees it, and the manager
 * pass below deliberately leaves role rows alone); isRequired copies onto
 * the task; and every task gets a holiday-aware dueDate — startDate
 * advanced dueOffsetDays WORKING days (addWorkingDays). A null startDate
 * means "undated": the checklist row stores null and the tasks' dueDate
 * stays null too (pre-P35 rows read the same way — never a fabricated
 * today).
 */
export async function instantiateChecklist(
  tx: Prisma.TransactionClient,
  input: {
    newHireId: string;
    title: string;
    kind: "ONBOARDING" | "SEPARATION";
    template: Omit<OnboardingTemplateTaskRow, "id" | "isActive" | "sortOrder">[];
    /** P35 — the working-day-walk anchor; null = undated. */
    startDate?: Date | null;
    /** P35 — the holiday calendar for the walk (built by the caller). */
    holidays?: HolidayLookup;
  },
) {
  const start = input.startDate ?? null;
  const created = await tx.onboardingChecklist.create({
    data: {
      newHireId: input.newHireId,
      title: input.title,
      kind: input.kind,
      startDate: start,
      tasks: {
        create: input.template.map((t, i) => {
          const { assigneeId, assigneeRole } = resolveTemplateAssignee(t, input.newHireId);
          return {
            title: t.title,
            dueOffsetDays: t.dueOffsetDays,
            assigneeId,
            assigneeRole,
            isRequired: Boolean(t.isRequired),
            dueDate: start
              ? addWorkingDays(start, t.dueOffsetDays, input.holidays)
              : null,
            order: i,
          };
        }),
      },
    },
    include: { tasks: true },
  });
  const approvers = await tx.user.findUnique({
    where: { id: input.newHireId },
    select: { managerId: true },
  });
  const managerId = approvers?.managerId ?? null;
  if (managerId) {
    // P35 — role-scoped rows keep their role (assigneeId stays NULL, every
    // holder sees the task); only the plain manager-default rows resolve.
    await tx.onboardingTask.updateMany({
      where: { checklistId: created.id, assigneeId: null, assigneeRole: "" },
      data: { assigneeId: managerId },
    });
  }
  return created;
}
