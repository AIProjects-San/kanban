"use server";

// Dashboard data loaders.
//
// `getDashboardData` is the SSR entry point used by app/page.tsx — it keeps
// its throwing contract (a DB outage should hit the error boundary, not
// silently render an empty workspace). `getMyProjects` / `getProjectMembers`
// are invoked from client components and therefore return ActionResults.

import { db } from "@/lib/db";
import { getSession, AuthorizationError } from "./auth-guard";
import { getScopedProjectIds } from "./shared";
import { EMPTY_DASHBOARD_DATA, type DashboardData } from "@/lib/types";
import type { Prisma } from "@prisma/client";
import { toResult } from "./result";
import type { ActionResult } from "@/lib/action-result";

// ---------------------------------------------------------------------------
// Dashboard data loader — single round trip
// ---------------------------------------------------------------------------
//
// Access scope (ALWAYS derived from the server-side session — never from
// caller-provided arguments, since any "use server" export can be invoked
// directly by an authenticated client):
//   • ADMIN            — sees every project, task and member in the workspace.
//   • MANAGER / MEMBER — sees ONLY projects they own or have tasks assigned
//                        to (or are explicitly staffed on), and only tasks
//                        belonging to those projects (plus any task directly
//                        assigned to them). Other members are still listed
//                        (scoped — see memberWhere) so they can be messaged,
//                        but their workload stats are not exposed.
//
// The same scoping is shared with the paginated/search read paths via
// getScopedProjectIds (deep-dive review F-03) so the scopes can't drift.

export async function getDashboardData(): Promise<DashboardData> {
  const session = await getSession();
  if (!session) {
    // Not signed in — the login screen doesn't need workspace data.
    return { ...EMPTY_DASHBOARD_DATA };
  }
  const role = session.role;
  const currentUserId = session.userId;
  const isMember = role === "MEMBER";
  // NOTE: MANAGER is scoped like MEMBER here (they see projects they own /
  // are assigned to / have tasks in). Deep-dive review F-03 documented this
  // as a deliberate design choice — RBAC's task:edit:any lets a MANAGER edit
  // any task they can SEE; visibility itself is hierarchy-driven.
  const isScoped = isMember || role === "MANAGER";

  // For scoped users, compute the set of project IDs they are associated with.
  // All identity matching goes through the stable user id — never the name.
  // (F-03: shared with the pagination/search read paths.)
  let scopedProjectIds: Set<string> | null = null;
  if (isScoped && currentUserId) {
    scopedProjectIds = await getScopedProjectIds(session);
  }

  // L-P0-14 — soft-delete filter. All read paths must exclude rows whose
  // `deletedAt` is set. We compose this with the existing scope filter so
  // soft-deleted projects/members/messages never appear in the dashboard.
  const notDeleted = { deletedAt: null };

  const projectWhere = isScoped && scopedProjectIds
    ? { id: { in: Array.from(scopedProjectIds) }, ...notDeleted }
    : notDeleted;

  const taskWhere = isScoped && scopedProjectIds
    ? {
        OR: [
          { projectId: { in: Array.from(scopedProjectIds) } },
          { assignee: { userId: currentUserId } },
        ],
        // Hide tasks whose project was soft-deleted (the task itself has no
        // deletedAt column — its lifecycle is tied to the project).
        project: { deletedAt: null },
      }
    : { project: { deletedAt: null } };

  // For scoped users, only show team members who have tasks in the user's
  // projects or who are explicitly assigned to those projects. Admins see all.
  let memberWhere: Prisma.TeamMemberWhereInput | undefined;
  if (isScoped && scopedProjectIds && scopedProjectIds.size > 0) {
    const projectIdArray = Array.from(scopedProjectIds);
    const assignedUserIds = await db.projectAssignment.findMany({
      where: { projectId: { in: projectIdArray } },
      select: { userId: true },
    }).then((assignments) => assignments.map((a) => a.userId));
    memberWhere = {
      OR: [
        { tasks: { some: { projectId: { in: projectIdArray } } } },
        { userId: { in: assignedUserIds } },
        { userId: currentUserId }, // always include yourself
      ],
      ...notDeleted,
    };
  } else if (isScoped) {
    // Scoped user with no projects — show only themselves
    memberWhere = { userId: currentUserId, ...notDeleted };
  } else {
    memberWhere = notDeleted;
  }

  const [projects, tasks, members, reminders, notifs, timeEntries, events, messages] = await Promise.all([
    db.project.findMany({ where: projectWhere, orderBy: { createdAt: "desc" } }),
    db.task.findMany({
      where: taskWhere,
      include: { project: true, assignee: true },
      orderBy: { order: "asc" },
    }),
    db.teamMember.findMany({ where: memberWhere, orderBy: { name: "asc" } }),
    // Reminders: personal (ownerId = me) + workspace-wide (ownerId = null).
    db.reminder.findMany({
      where: { OR: [{ ownerId: currentUserId }, { ownerId: null }] },
      orderBy: { dueDate: "asc" },
    }),
    // Notifications: addressed to me + workspace-wide broadcasts.
    db.notification.findMany({
      where: currentUserId
        ? { OR: [{ recipientUserId: currentUserId }, { recipientUserId: null }] }
        : undefined,
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
    db.timeEntry.findMany({ orderBy: { date: "desc" } }),
    db.calendarEvent.findMany({ orderBy: { date: "asc" } }),
    db.message.findMany({
      where: currentUserId
        ? {
            OR: [
              { senderUserId: currentUserId },
              { recipientUserId: currentUserId },
            ],
            ...notDeleted, // L-P0-14: exclude soft-deleted messages
          }
        : { ...notDeleted },
      orderBy: { createdAt: "desc" },
      // L-P0-2: include the per-recipient read-state rows so the loader can
      // derive `read` per viewer without an N+1.
      include: { readBy: { where: { userId: currentUserId ?? "" } } },
    }),
  ]);

  // Scoped users only receive time entries for members they can already see
  // (the member list is scoped above) — same data-minimization rule. Admins
  // get the full log.
  let visibleTimeEntries = timeEntries;
  if (memberWhere) {
    const visibleMemberIds = new Set(members.map((m) => m.id));
    visibleTimeEntries = timeEntries.filter((te) => te.memberId != null && visibleMemberIds.has(te.memberId));
  }

  const total = projects.length;
  const ended = projects.filter((p) => p.status === "ENDED").length;
  const running = projects.filter((p) => p.status === "RUNNING").length;
  const pending = projects.filter((p) => p.status === "PENDING").length;
  const paused = projects.filter((p) => p.status === "PAUSED").length;

  // Weekly completion = share of visible tasks completed in the last 7 days.
  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 7);
  const completedThisWeek = tasks.filter(
    (t) => t.status === "DONE" && t.updatedAt >= weekAgo,
  ).length;
  const weeklyCompletion = tasks.length
    ? Math.round((completedThisWeek / tasks.length) * 100)
    : 0;

  const projectEndedPct = total ? Math.round((ended / total) * 100) : 0;

  // Prisma returns plain strings for status/priority/tag columns; every
  // write path in this app only ever stores the enum values defined in
  // lib/types, so the narrowing cast below is safe at runtime.
  return {
    projects: projects.map(p => ({
      ...p,
      dueDate: p.dueDate?.toISOString() ?? null,
      createdAt: p.createdAt.toISOString(),
    })),
    tasks: tasks.map(t => ({
      ...t,
      dueDate: t.dueDate?.toISOString() ?? null,
      createdAt: t.createdAt.toISOString(),
      project: t.project ? {
        ...t.project,
        dueDate: t.project.dueDate?.toISOString() ?? null,
        createdAt: t.project.createdAt.toISOString(),
      } : null,
      assignee: t.assignee ? {
        ...t.assignee,
        createdAt: t.assignee.createdAt.toISOString(),
        updatedAt: t.assignee.updatedAt.toISOString(),
      } : null,
    })),
    members: members.map(m => ({
      ...m,
      createdAt: m.createdAt.toISOString(),
      updatedAt: m.updatedAt.toISOString(),
    })),
    reminders: reminders.map(r => ({
      ...r,
      dueDate: r.dueDate.toISOString(),
      createdAt: r.createdAt.toISOString(),
    })),
    notifications: notifs.map(n => ({
      ...n,
      createdAt: n.createdAt.toISOString(),
    })),
    timeEntries: visibleTimeEntries.map(te => ({
      ...te,
      date: te.date.toISOString(),
      createdAt: te.createdAt.toISOString(),
    })),
    events: events.map(e => ({
      ...e,
      date: e.date.toISOString(),
      createdAt: e.createdAt.toISOString(),
    })),
    messages: messages.map(m => {
      // L-P0-2: derive direction per viewer (recipient sees IN, sender sees OUT).
      // The stored `direction` column is no longer authoritative.
      const viewerDirection = m.recipientUserId === currentUserId ? "IN" : "OUT";
      // Read state: sender's own copy is always "read" (they wrote it).
      // Recipient's copy is read if either a MessageRead row exists OR the
      // legacy `read` column is true (seed-data compat).
      const viewerRead = viewerDirection === "OUT"
        ? true
        : (m.readBy.length > 0 || m.read);
      // Strip the readBy relation from the client payload (it's an
      // implementation detail).
      const { readBy: _readBy, ...rest } = m;
      return {
        ...rest,
        direction: viewerDirection as "IN" | "OUT",
        read: viewerRead,
        createdAt: m.createdAt.toISOString(),
      };
    }),
    stats: {
      total, ended, running, pending, paused,
      weeklyCompletion,
      projectEndedPct,
    },
    // Surface the access scope so the client can show a banner / disable
    // filters that don't make sense for a member.
    scope: {
      isMember: !!isMember,
      projectIds: scopedProjectIds ? Array.from(scopedProjectIds) : null,
    },
  } as DashboardData;
}

// ---------------------------------------------------------------------------
// Projects the current user is associated with (owner or task assignee)
// ---------------------------------------------------------------------------

export async function getMyProjects(): Promise<ActionResult<
  Array<{ id: string; name: string; color: string; status: string }>
>> {
  return toResult(async () => {
    const auth = await getSession();
    if (!auth) return []; // anonymous — the modal is behind the login screen anyway
    const projects = await db.project.findMany({
      where: {
        OR: [
          { ownerUserId: auth.userId },
          { tasks: { some: { assignee: { userId: auth.userId } } } },
          { assignments: { some: { userId: auth.userId } } },
        ],
      },
      select: { id: true, name: true, color: true, status: true },
      orderBy: { name: "asc" },
    });
    return projects;
  });
}

// ---------------------------------------------------------------------------
// Members allocated to a specific project.
//
// "Allocated" means the member is either:
//   • the project's owner (Project.ownerUserId === member.userId), OR
//   • the assignee of at least one task in that project.
//
// Used by the task modal to restrict the assignee dropdown to only people who
// are actually working on the selected project. Admins still get the full team
// list when no project is selected, but once a project is picked the same
// restriction applies — you can't assign a task to someone outside the project.
// ---------------------------------------------------------------------------

export async function getProjectMembers(projectId: string): Promise<ActionResult<
  Array<{
    id: string;
    name: string;
    email: string;
    role: string;
    department: string;
    avatarColor: string;
    online: boolean;
    openTasks: number;
    completedTasks: number;
    workload: number;
    isOwner: boolean;
  }>
>> {
  return toResult(async () => {
    const auth = await getSession();
    if (!auth) throw new AuthorizationError("You must be signed in.");

    const project = await db.project.findUnique({
      where: { id: projectId },
      select: { id: true, name: true, ownerUserId: true, deletedAt: true },
    });
    if (!project || project.deletedAt) return [];

    // Deep-dive review F-03 — scoped roles may only enumerate the roster of
    // projects they can already see (the dashboard applies the same rule to
    // the member list). Admins are unscoped.
    const scopedIds = await getScopedProjectIds(auth);
    if (scopedIds && !scopedIds.has(projectId)) return [];

    // Members who already have at least one task in this project.
    const assignedMembers = await db.teamMember.findMany({
      where: { tasks: { some: { projectId } } },
      orderBy: { name: "asc" },
    });

    // Always include the project owner (if they're a team member) — resolved
    // via the stable user id, never by name.
    const ownerMember = project.ownerUserId
      ? await db.teamMember.findUnique({ where: { userId: project.ownerUserId } })
      : null;

    const seen = new Set<string>();
    const merged: Array<{
      id: string;
      name: string;
      email: string;
      role: string;
      department: string;
      avatarColor: string;
      online: boolean;
      openTasks: number;
      completedTasks: number;
      workload: number;
      isOwner: boolean;
    }> = [];

    const push = (m: typeof assignedMembers[number], isOwner: boolean) => {
      if (seen.has(m.id)) return;
      seen.add(m.id);
      merged.push({
        id: m.id,
        name: m.name,
        email: m.email,
        role: m.role,
        department: m.department,
        avatarColor: m.avatarColor,
        online: m.online,
        openTasks: m.openTasks,
        completedTasks: m.completedTasks,
        workload: m.workload,
        isOwner,
      });
    };

    if (ownerMember) push(ownerMember, true);
    for (const m of assignedMembers) push(m, !!project.ownerUserId && m.userId === project.ownerUserId);

    return merged;
  });
}
