// SERVER-ONLY shared helpers for the server-action modules.
//
// NOTE: This file intentionally does NOT have "use server" — it exports
// non-async values and is imported by the domain action modules below,
// never by client components.

import { logError } from "@/lib/observability";
import { db } from "@/lib/db";
import { hasPermission, type Role } from "@/lib/rbac";
import { getSubtreeUserIds } from "@/lib/hierarchy";
import { AuthorizationError } from "./auth-guard";
import type { AuditAction } from "@/lib/audit-meta";
import { headers as nextHeaders } from "next/headers";
// F2.10 — the shared outbox sender + onboarding-template instantiation.
import { createMailer } from "@/lib/mailer";
import { Prisma } from "@prisma/client";
import {
  templateForKind,
  type OnboardingTemplateTaskRow,
} from "@/lib/onboarding-template";

export { AuthorizationError };

/**
 * P1 (production-readiness re-audit) — extract the client IP + user agent
 * from the request context for audit logging. Best-effort: behind a reverse
 * proxy we read `x-forwarded-for` (first hop); without a proxy we fall back
 * to "unknown". Returns an object so callers can destructure both fields
 * from one call site.
 */
export async function getClientInfo(): Promise<{ ip: string; userAgent: string }> {
  try {
    const h = await nextHeaders();
    const xff = h.get("x-forwarded-for") ?? "";
    const ip = xff.split(",")[0].trim() || "unknown";
    const userAgent = (h.get("user-agent") ?? "").slice(0, 500) || "unknown";
    return { ip, userAgent };
  } catch (err) {
    // PR-22 — log the miss. headers() throws outside a request context
    // (e.g. tests, background jobs); that's expected, but a persistent
    // failure in a real request should be visible.
    logError("[shared] getClientInfo failed (outside request context?):", err);
    return { ip: "unknown", userAgent: "unknown" };
  }
}

export function fmtDay(d: Date) {
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

export async function logAudit(entry: {
  actor: { userId: string; name: string; role: string };
  action: AuditAction;
  entityType: string;
  entityId?: string;
  entityLabel?: string;
  detail: string;
  /** P1 (production-readiness re-audit) — source IP + user agent for
   *  post-incident forensics. Optional; callers that have a request context
   *  (server actions, the auth flow) pass them through. */
  ipAddress?: string;
  userAgent?: string;
}) {
  try {
    await db.auditLog.create({
      data: {
        actorId: entry.actor.userId,
        actorName: entry.actor.name,
        actorRole: entry.actor.role,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId ?? "",
        entityLabel: entry.entityLabel ?? "",
        detail: entry.detail,
        // P1 re-audit — capture the source IP + UA when available. Both
        // columns are NOT NULL DEFAULT '' so omitting them is safe.
        ...(entry.ipAddress !== undefined ? { ipAddress: entry.ipAddress } : {}),
        ...(entry.userAgent !== undefined ? { userAgent: entry.userAgent } : {}),
      },
    });
  } catch (err) {
    // Audit logging must never break the underlying operation
    logError("[audit] failed to write log entry:", err);
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
// NOTE: getDashboardData inlines the same logic (it already has the member
// list in hand for display, so it post-filters in JS rather than re-querying).
// If you change the rule here, update dashboard.ts too — both are commented
// to point at each other.
// ---------------------------------------------------------------------------

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
  // Same three sources as the dashboard's memberWhere (dashboard.ts):
  //   1. members with tasks in the viewer's projects
  //   2. members explicitly staffed on those projects (ProjectAssignment)
  //   3. the viewer themselves (always visible)
  const assignedUserIds = await db.projectAssignment.findMany({
    where: { projectId: { in: projectIdArray } },
    select: { userId: true },
    take: 1000,
  }).then((rows) => rows.map((r) => r.userId));
  const members = await db.teamMember.findMany({
    where: {
      OR: [
        { tasks: { some: { projectId: { in: projectIdArray } } } },
        { userId: { in: assignedUserIds } },
        { userId: auth.userId },
      ],
      deletedAt: null,
    },
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
  // 1. ADMIN — the only role holding the blanket task:delete permission.
  if (hasPermission(auth.role, "task:delete")) return;

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

// ---------------------------------------------------------------------------
// F2.10 — joining-hardening shared helpers (used by hiring.ts AND
// hr-onboarding.ts; shared.ts is the server-only home for cross-module
// non-action helpers).
// ---------------------------------------------------------------------------

/**
 * F-R16 (folded into F2.10) — the ONE audited-outbox send helper. The
 * QUEUED → send → resolve dance was hand-rolled ×3 (sendOffer, markJoined,
 * queueCandidateEmail); every new candidate-facing email (the F2.10
 * interview invite) writes through here instead.
 *
 * Writes the MailOutbox row FIRST (status QUEUED — the audit copy exists
 * even when the provider is down), attempts delivery best-effort, then
 * resolves the row to SENT / SKIPPED / FAILED. Never throws: a provider
 * outage must not fail the business action that triggered the email.
 */
export async function sendOutboxMail(input: {
  kind: string;
  candidateId?: string | null;
  toAddress: string;
  subject: string;
  text: string;
  html: string;
  sentById: string;
}): Promise<{ status: "SENT" | "SKIPPED" | "FAILED"; providerMessageId: string; error: string }> {
  const row = await db.mailOutbox.create({
    data: {
      kind: input.kind,
      candidateId: input.candidateId ?? null,
      toAddress: input.toAddress,
      subject: input.subject,
      body: input.text,
      status: "QUEUED",
      sentById: input.sentById,
    },
  });
  let status: "SENT" | "SKIPPED" | "FAILED" = "SKIPPED";
  let providerMessageId = "";
  let error = "";
  try {
    const result = await createMailer().sendMail({
      to: input.toAddress,
      subject: input.subject,
      html: input.html,
      text: input.text,
    });
    if (result.delivered) {
      status = "SENT";
      providerMessageId = result.messageId ?? "";
    }
  } catch (err) {
    status = "FAILED";
    error = err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500);
  }
  await db.mailOutbox.update({
    where: { id: row.id },
    data: { status, providerMessageId, error, sentAt: new Date() },
  });
  return { status, providerMessageId, error };
}

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
 */
export async function instantiateChecklist(
  tx: Prisma.TransactionClient,
  input: {
    newHireId: string;
    title: string;
    kind: "ONBOARDING" | "SEPARATION";
    template: Omit<OnboardingTemplateTaskRow, "id" | "isActive" | "sortOrder">[];
  },
) {
  const created = await tx.onboardingChecklist.create({
    data: {
      newHireId: input.newHireId,
      title: input.title,
      kind: input.kind,
      tasks: {
        create: input.template.map((t, i) => ({
          title: t.title,
          dueOffsetDays: t.dueOffsetDays,
          assigneeId: t.assignSelf ? input.newHireId : null,
          order: i,
        })),
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
    await tx.onboardingTask.updateMany({
      where: { checklistId: created.id, assigneeId: null },
      data: { assigneeId: managerId },
    });
  }
  return created;
}
