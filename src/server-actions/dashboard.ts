"use server";

// Dashboard data loaders.
//
// `getDashboardData` is the SSR entry point used by app/page.tsx — it keeps
// its throwing contract (a DB outage should hit the error boundary, not
// silently render an empty workspace). `getMyProjects` / `getProjectMembers`
// are invoked from client components and therefore return ActionResults.

import { db } from "@/lib/db";
import { getSession, AuthorizationError } from "./auth-guard";
import { getScopedProjectIds, getWorkspaceLimit } from "./shared";
import { getSubtreeUserIds } from "@/lib/hierarchy";
import { getEffectivePermissions } from "@/lib/config-loader";
import { EMPTY_DASHBOARD_DATA, type DashboardData } from "@/lib/types";
import type { Prisma } from "@prisma/client";
import { toResult } from "./result";
import type { ActionResult } from "@/lib/action-result";

/**
 * Date helpers for the dashboard loader's `take` + date-window scoping
 * (P1 — production-readiness re-audit). Centralised so the same definitions
 * are used by every query and easy to tune.
 */
function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}
function ninetyDaysAgo(): Date {
  const d = startOfToday();
  d.setDate(d.getDate() - 90);
  return d;
}

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

  // Bug-fix (caught by the e2e suite): tasks with projectId = null (created
  // before the project picker finished loading, or whose project row was
  // hard-deleted — onDelete: SetNull nulls the reference) were silently
  // excluded by the previous `{ project: { deletedAt: null } }` filter. They
  // existed in the DB but never appeared on ANY board — an invisible-data
  // bug. Soft-deleted projects keep their task references (a soft delete
  // never fires SetNull), so those tasks stay hidden as intended.
  const projectVisibilityFilter = {
    OR: [{ project: { deletedAt: null } }, { projectId: null }],
  };

  const taskWhere = isScoped && scopedProjectIds
    ? {
        AND: [
          {
            OR: [
              { projectId: { in: Array.from(scopedProjectIds) } },
              { assignee: { userId: currentUserId } },
            ],
          },
          projectVisibilityFilter,
        ],
      }
    : projectVisibilityFilter;

  // For scoped users, only show team members who have tasks in the user's
  // projects or who are explicitly assigned to those projects. Admins see all.
  // PR-53 — the same member-visibility rule is mirrored in getVisibleMemberIds
  // (shared.ts) for the paginated time-entries read path. If you change the
  // rule here, update that helper too — both are commented to point at each
  // other so the scopes can't drift apart.
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

  // PR-18 — the notification feed cap is admin-editable (Workspace Settings →
  // "Dashboard notification limit"); fall back to the old hardcoded 20.
  const notifLimit = currentUserId
    ? await getWorkspaceLimit("dashboardNotifLimit", 20, 100)
    : 20;

  const [projects, tasks, members, reminders, notifs, timeEntries, events, approvedLeave, messages, bugTaskLinks] = await Promise.all([
    // P1 (production-readiness re-audit) — every query has a `take` cap so a
    // workspace with 10k tasks / time entries / messages can't OOM the
    // dashboard loader. 200 is well above what any one screen can render
    // meaningfully; pagination handles the rest.
    db.project.findMany({ where: projectWhere, orderBy: { createdAt: "desc" }, take: 200 }),
    db.task.findMany({
      where: taskWhere,
      include: {
        project: true,
        assignee: true,
        // Board enhancement — per-task spent-time aggregate (required vs
        // spent). Only the hours are selected; the relation is stripped from
        // the client payload below.
        timeEntries: { select: { hours: true } },
      },
      orderBy: { order: "asc" },
      take: 200,
    }),
    db.teamMember.findMany({ where: memberWhere, orderBy: { name: "asc" }, take: 200 }),
    // PR-52 — reminders are personal-only. The dashboard previously
    // also surfaced legacy workspace-wide rows (ownerId = null), which
    // meant every signed-in user saw the same shared reminders regardless
    // of who created them. A reminder is a personal todo item (you set it
    // for yourself), never a broadcast — so the query now matches ONLY the
    // signed-in user's rows. Broadcasts still exist for NOTIFICATIONS
    // (see notifications.ts) where the recipientUserId = null pattern is
    // an intentional admin-announcement feature; reminders were never meant
    // to be shared. The ownerId column retains its null-allowing type for
    // back-compat with legacy rows, but those rows are no longer rendered.
    // Guard the userId so Prisma never receives an undefined filter (which
    // would unscope the query and return every reminder in the workspace).
    db.reminder.findMany({
      where: { ownerId: currentUserId ?? "__no_user__" },
      orderBy: { dueDate: "asc" },
      take: 100,
    }),
    // Notifications: addressed to me + workspace-wide broadcasts.
    // PR-18 — honour the admin-editable Workspace.dashboardNotifLimit
    // (previously hardcoded at 20) with the old default as fallback.
    db.notification.findMany({
      where: currentUserId
        ? { OR: [{ recipientUserId: currentUserId }, { recipientUserId: null }] }
        : undefined,
      orderBy: { createdAt: "desc" },
      take: notifLimit,
    }),
    // Time entries: scoped to the last 90 days so the loader stays fast even
    // for workspaces with years of history. Older entries are accessible via
    // the time-entry view's pagination.
    db.timeEntry.findMany({
      where: { date: { gte: ninetyDaysAgo() } },
      orderBy: { date: "desc" },
      take: 200,
    }),
    // Calendar events: upcoming 90 days (past events are paginated).
    db.calendarEvent.findMany({
      where: { date: { gte: startOfToday() } },
      orderBy: { date: "asc" },
      take: 200,
    }),
    // HR module — approved leave overlapping the calendar window; merged
    // into the event feed below as virtual LEAVE events (no CalendarEvent
    // row exists, so cancel/reject propagates automatically).
    db.leaveRequest.findMany({
      where: { status: "APPROVED", endDate: { gte: startOfToday() } },
      orderBy: { startDate: "asc" },
      take: 200,
    }),
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
      take: 200,
      // L-P0-2: include the per-recipient read-state rows so the loader can
      // derive `read` per viewer without an N+1.
      include: { readBy: { where: { userId: currentUserId ?? "" } } },
    }),
    // Board enhancement — Task ↔ Bug link counts (bugs per task), computed
    // in one query and counted in JS so the shape stays mock-friendly.
    db.bug.findMany({
      where: { taskId: { not: null } },
      select: { taskId: true },
      take: 500,
    }),
  ]);

  // Per-task bug counts from the flat link list above. Defensive `?? []` —
  // mocked test environments may not stub the bug query.
  const bugCountByTask = new Map<string, number>();
  for (const link of bugTaskLinks ?? []) {
    if (link.taskId) bugCountByTask.set(link.taskId, (bugCountByTask.get(link.taskId) ?? 0) + 1);
  }

  // Scoped users only receive time entries for members they can already see
  // (the member list is scoped above) — same data-minimization rule. Admins
  // get the full log.
  let visibleTimeEntries = timeEntries;
  if (memberWhere) {
    const visibleMemberIds = new Set(members.map((m) => m.id));
    visibleTimeEntries = timeEntries.filter((te) => te.memberId != null && visibleMemberIds.has(te.memberId));
  }

  // ---------------------------------------------------------------------
  // HR module — approved leave becomes virtual calendar events. Scoped
  // users see leave only for members they can already see (plus their own,
  // which memberWhere always includes) — same minimization rule as time
  // entries. Leave of users with no TeamMember row is admin-only.
  // ---------------------------------------------------------------------
  const visibleUserIds = new Set(
    members.map((m) => m.userId).filter(Boolean) as string[],
  );
  if (currentUserId) visibleUserIds.add(currentUserId);
  const calendarLeave = (approvedLeave ?? []).filter(
    (lr) => !memberWhere || visibleUserIds.has(lr.userId),
  );
  let leaveEvents: {
    id: string; title: string; description: string; date: Date;
    time: string; durationMin: number; type: string; location: string;
    createdAt: Date;
  }[] = [];
  if (calendarLeave.length) {
    const [leaveUsers, leaveTypes] = await Promise.all([
      db.user.findMany({
        where: { id: { in: [...new Set(calendarLeave.map((lr) => lr.userId))] } },
        select: { id: true, name: true },
      }),
      db.leaveType.findMany({ select: { id: true, name: true, color: true } }),
    ]);
    const nameById = new Map(leaveUsers.map((u) => [u.id, u.name]));
    const typeById = new Map(leaveTypes.map((t) => [t.id, t]));
    leaveEvents = calendarLeave.map((lr) => ({
      id: `leave-${lr.id}`,
      title: `${nameById.get(lr.userId) ?? "Member"} — ${typeById.get(lr.leaveTypeId)?.name ?? "Leave"}`,
      description: lr.days === 1 ? "1 working day" : `${lr.days} working days`,
      date: lr.startDate,
      time: "09:00",
      durationMin: Math.round(lr.days * 480),
      type: "LEAVE",
      location: "",
      createdAt: lr.createdAt,
    }));
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

  // PR-61 — the signed-in MANAGER's reporting subtree (user ids), for the
  // client-side task-delete predicate and (later) scoped analytics. Only
  // managers need it: ADMIN decides via the blanket task:delete permission,
  // MEMBER/HR via assignee/project-owner checks that need no hierarchy.
  // Cheap for the common case (few reports) and capped internally at 1000.
  const managedUserIds =
    role === "MANAGER" && currentUserId
      ? Array.from(await getSubtreeUserIds(currentUserId))
      : [];

  // PR-64 — effective permissions (static floor ∪ DB ceiling) for the
  // signed-in role. Seeds the client permission store; the getMyPermissions
  // poll keeps it fresh so an admin's role-permission save reflects for
  // already-logged-in users without a re-login.
  const effectivePermissions = await getEffectivePermissions(role);

  // Prisma returns plain strings for status/priority/tag columns; every
  // write path in this app only ever stores the enum values defined in
  // lib/types, so the narrowing cast below is safe at runtime.
  return {
    projects: projects.map(p => ({
      ...p,
      dueDate: p.dueDate?.toISOString() ?? null,
      createdAt: p.createdAt.toISOString(),
    })),
    tasks: tasks.map(t => {
      // Strip the raw timeEntries relation (implementation detail) and
      // surface the aggregate the UI actually needs. Defensive `?? []` keeps
      // mocked test environments (no relation on the fixture) happy.
      const { timeEntries: taskTimeEntries, ...taskRest } = t as typeof t & { timeEntries?: Array<{ hours: number }> };
      const spentHours = Math.round(
        (taskTimeEntries ?? []).reduce((sum, e) => sum + e.hours, 0) * 10,
      ) / 10;
      return {
        ...taskRest,
        dueDate: t.dueDate?.toISOString() ?? null,
        createdAt: t.createdAt.toISOString(),
        spentHours,
        bugCount: bugCountByTask.get(t.id) ?? 0,
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
      };
    }),
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
    events: [...events, ...leaveEvents].map(e => ({
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
    managedUserIds,
    effectivePermissions,
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
      // PR-21 — hard cap; this feeds the task-modal's project dropdown.
      take: 500,
    });
    return projects;
  });
}

// ---------------------------------------------------------------------------
// Members allocated to a specific project.
//
// Project association rule (docs/DECISIONS.md): "associated with a project"
// means EXPLICITLY staffed on it (a ProjectAssignment row — the admin
// "assign user to project" relation) or owning it. Task-assignee history is
// deliberately NOT part of the rule ("you can be assigned because you were
// assigned" is circular).
//
// Used by the task modal to restrict the assignee dropdown to exactly the
// people the server will accept as task assignees for that project
// (assertTeamMemberAssociatedWithProject applies the same rule at write
// time). Scoped roles may only enumerate rosters they can already see.
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

    // Explicitly staffed users (ProjectAssignment) + the project owner.
    const assignments = await db.projectAssignment.findMany({
      where: { projectId },
      select: { userId: true },
      // PR-21 — hard cap; a project beyond ~500 staff is a paging concern.
      take: 500,
    });
    const associatedUserIds = new Set(assignments.map((a) => a.userId));
    if (project.ownerUserId) associatedUserIds.add(project.ownerUserId);
    if (associatedUserIds.size === 0) return [];

    // Task assignees are TeamMember rows — resolve the roster entries whose
    // linked user is associated with the project (and not soft-deleted).
    const members = await db.teamMember.findMany({
      where: { userId: { in: Array.from(associatedUserIds) }, deletedAt: null },
      orderBy: { name: "asc" },
      // PR-21 — hard cap, mirroring the assignment cap above.
      take: 500,
    });

    return members.map((m) => ({
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
      isOwner: !!project.ownerUserId && m.userId === project.ownerUserId,
    }));
  });
}
