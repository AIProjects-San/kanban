"use server";

// ---------------------------------------------------------------------------
// PR-63 — role-scoped analytics data.
//
// The Analytics tab used to render workspace-wide numbers for every role
// from the dashboard payload. User request: the data must respect the
// signed-in user —
//
//   • MEMBER / HR — only their own hours/activity (whatever scope they ask
//     for, the server forces "self").
//   • MANAGER — their team (self + reporting subtree) by default, and may
//     narrow to themselves or any individual in their subtree. "Everyone"
//     and other managers' teams are rejected.
//   • ADMIN — starts with their own data and may pick "Everyone", any
//     manager's full team, or any individual.
//
// The scope is enforced HERE, not in the view: a MEMBER cannot ask for
// someone else's numbers, and a MANAGER cannot ask for people outside their
// chain, whatever the client sends. The response also carries the filter
// options the signed-in user is allowed to pick, so the dropdown never
// offers a scope the server would reject.
// ---------------------------------------------------------------------------

import { db } from "@/lib/infra/db";
import { getSessionOrThrow, AuthorizationError } from "./auth-guard";
import { getSubtreeUserIds } from "@/lib/auth/hierarchy";
import { toResult } from "./result";
import type { ActionResult } from "@/lib/action-result";
import type { TeamMemberT, TimeEntryT } from "@/lib/types";

/** What the client asks for. The server may narrow it (MEMBER/HR → self). */
export type AnalyticsScope =
  | { kind: "self" }
  | { kind: "everyone" }
  | { kind: "user"; userId: string }
  | { kind: "team"; managerId: string };

/** Selectable scopes for the signed-in user (drives the filter dropdown). */
export interface AnalyticsFilterOptions {
  /** ADMIN only — the workspace-wide option. */
  showEveryone: boolean;
  /** Individuals the user may pick: ADMIN — everyone; MANAGER — their
   *  subtree minus themselves (there is a dedicated "Just me" option). */
  people: Array<{ userId: string; name: string; role: string }>;
  /** Managers whose FULL TEAM can be picked (ADMIN only — a manager's own
   *  team is already their default view). */
  teams: Array<{ managerId: string; name: string }>;
}

export interface AnalyticsData {
  /** The scope the server actually resolved (post-authorization). */
  scope: AnalyticsScope;
  /** Team members inside the scope (roster + Top contributors). */
  members: TeamMemberT[];
  /** Time entries logged by those members (the whole analytics surface —
   *  throughput, time-by-project, heatmap — derives from these). */
  timeEntries: TimeEntryT[];
  /** Minimal project info for entries in scope (chart labels only). */
  projects: Array<{ id: string; name: string; color: string }>;
  /** What the signed-in user is allowed to switch to. */
  filter: AnalyticsFilterOptions;
}

// Cap the entry fetch: the view only charts the last 90 days; 4000 rows is
// far above any realistic 90-day single-team volume but bounds the payload.
const MAX_ENTRIES = 4000;

export async function getAnalyticsData(
  scope: AnalyticsScope = { kind: "self" },
): Promise<ActionResult<AnalyticsData>> {
  return toResult(async () => {
    const auth = await getSessionOrThrow();
    const isAdmin = auth.role === "ADMIN";
    const isManager = auth.role === "MANAGER";

    // ------------------------------------------------------ authorization
    // Resolve + authorize the requested scope. Computed once — the manager
    // checks and the filter options both need the caller's subtree.
    const mySubtree = isManager ? await getSubtreeUserIds(auth.userId) : null;

    let resolved: AnalyticsScope = scope ?? { kind: "self" };
    if (!isAdmin) {
      if (isManager) {
        if (resolved.kind === "everyone") {
          throw new AuthorizationError("Only admins can view workspace-wide analytics.");
        }
        if (resolved.kind === "team" && resolved.managerId !== auth.userId) {
          throw new AuthorizationError("You can only view your own team's analytics.");
        }
        if (resolved.kind === "user" && !mySubtree!.has(resolved.userId)) {
          throw new AuthorizationError("You can only view analytics for yourself and your team.");
        }
      } else {
        // MEMBER / HR (and any future non-manager role): self only.
        resolved = { kind: "self" };
      }
    }

    // ----------------------------------------------------------- the data
    // Scope → user ids → team-member rows → their time entries.
    let userIds: string[] | null = null; // null = everyone (ADMIN)
    if (resolved.kind === "self") userIds = [auth.userId];
    else if (resolved.kind === "user") userIds = [resolved.userId];
    else if (resolved.kind === "team") {
      userIds = Array.from(await getSubtreeUserIds(resolved.managerId));
    }

    const memberWhere = userIds
      ? { userId: { in: userIds }, deletedAt: null }
      : { deletedAt: null };

    const memberRows = await db.teamMember.findMany({
      where: memberWhere,
      select: {
        id: true, name: true, role: true, department: true, email: true,
        avatarColor: true, online: true, openTasks: true, completedTasks: true,
        workload: true, userId: true, createdAt: true, updatedAt: true,
      },
      orderBy: { name: "asc" },
    });
    const members: TeamMemberT[] = memberRows.map((m) => ({
      id: m.id, name: m.name,
      // Prisma stores these as plain strings; every write path only stores
      // the union values (same narrowing the dashboard payload relies on).
      role: m.role as TeamMemberT["role"],
      department: m.department as TeamMemberT["department"],
      email: m.email,
      avatarColor: m.avatarColor as TeamMemberT["avatarColor"],
      online: m.online, openTasks: m.openTasks, completedTasks: m.completedTasks,
      workload: m.workload, userId: m.userId,
    }));
    const memberIds = members.map((m) => m.id);

    const entryRows = memberIds.length
      ? await db.timeEntry.findMany({
          where: { memberId: { in: memberIds } },
          orderBy: { date: "desc" },
          take: MAX_ENTRIES,
        })
      : [];
    const timeEntries: TimeEntryT[] = entryRows.map((e) => ({
      id: e.id, projectId: e.projectId, memberId: e.memberId, taskId: e.taskId,
      date: e.date.toISOString(), hours: e.hours, description: e.description,
    }));

    // Project labels for the entries in scope (chart colors + names only).
    const projectIds = [
      ...new Set(timeEntries.map((e) => e.projectId).filter((p): p is string => !!p)),
    ];
    const projects = projectIds.length
      ? await db.project.findMany({
          where: { id: { in: projectIds } },
          select: { id: true, name: true, color: true },
        })
      : [];

    // ----------------------------------------------------- filter options
    let filter: AnalyticsFilterOptions;
    if (isAdmin) {
      const users = await db.user.findMany({
        where: { deletedAt: null },
        select: { id: true, name: true, role: true },
        orderBy: { name: "asc" },
      });
      filter = {
        showEveryone: true,
        people: users.map((u) => ({ userId: u.id, name: u.name, role: u.role })),
        teams: users
          .filter((u) => u.role === "MANAGER")
          .map((u) => ({ managerId: u.id, name: u.name })),
      };
    } else if (isManager) {
      const reportIds = [...mySubtree!].filter((id) => id !== auth.userId);
      const users = reportIds.length
        ? await db.user.findMany({
            where: { id: { in: reportIds }, deletedAt: null },
            select: { id: true, name: true, role: true },
            orderBy: { name: "asc" },
          })
        : [];
      filter = {
        showEveryone: false,
        people: users.map((u) => ({ userId: u.id, name: u.name, role: u.role })),
        teams: [],
      };
    } else {
      filter = { showEveryone: false, people: [], teams: [] };
    }

    return { scope: resolved, members, timeEntries, projects, filter };
  });
}
