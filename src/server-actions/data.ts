"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requirePermission, getSession, getSessionOrThrow, AuthorizationError } from "./auth-guard";
import { ROLE_LABELS, hasPermission, type Role } from "@/lib/rbac";
import { TASK_STATUS_LABELS } from "@/lib/config";
import { getWorkspaceConfig, bumpConfigCache, type WorkspaceConfig } from "@/lib/config-loader";
import { EMPTY_DASHBOARD_DATA, type DashboardData } from "@/lib/types";
import { getMinPasswordLength, hashPassword, verifyPassword } from "@/lib/password";
import {
  createTaskSchema,
  updateTaskSchema,
  createProjectSchema,
  createMemberSchema,
  createEventSchema,
  sendMessageSchema,
  createReminderSchema,
  parseOrThrow,
} from "@/lib/validation";
import type { AuditAction } from "@/lib/audit-meta";
import type { Prisma } from "@prisma/client";

// Re-export for convenience
export { AuthorizationError };
export { getWorkspaceConfig, type WorkspaceConfig };

// ---------------------------------------------------------------------------
// Audit logging — every mutating action leaves an immutable trail
// ---------------------------------------------------------------------------

function fmtDay(d: Date) {
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

async function logAudit(entry: {
  actor: { userId: string; name: string; role: string };
  action: AuditAction;
  entityType: string;
  entityId?: string;
  entityLabel?: string;
  detail: string;
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
      },
    });
  } catch (err) {
    // Audit logging must never break the underlying operation
    console.error("[audit] failed to write log entry:", err);
  }
}

// ---------------------------------------------------------------------------
// Dashboard data loader — single round trip
// ---------------------------------------------------------------------------
//
// Access scope (ALWAYS derived from the server-side session — never from
// caller-provided arguments, since any "use server" export can be invoked
// directly by an authenticated client):
//   • ADMIN / MANAGER — sees every project, task and member in the workspace.
//   • MEMBER          — sees ONLY projects they own or have tasks assigned to,
//                       and only tasks belonging to those projects (plus any
//                       task directly assigned to them). Other members are
//                       still listed so they can be messaged, but their
//                       workload stats are not exposed.

export async function getDashboardData(): Promise<DashboardData> {
  const session = await getSession();
  if (!session) {
    // Not signed in — the login screen doesn't need workspace data.
    return { ...EMPTY_DASHBOARD_DATA };
  }
  const role = session.role;
  const userName = session.name;
  const currentUserId = session.userId;
  const isMember = role === "MEMBER";
  const isScoped = isMember || role === "MANAGER";

  // For scoped users, compute the set of project IDs they are associated with.
  let scopedProjectIds: Set<string> | null = null;
  if (isScoped && userName) {
    const [owned, assignedProjects, explicitAssignments] = await Promise.all([
      db.project.findMany({
        where: { ownerName: userName },
        select: { id: true },
      }),
      db.task.findMany({
        where: { assignee: { name: userName } },
        select: { projectId: true },
        distinct: ["projectId"],
      }),
      currentUserId
        ? db.projectAssignment.findMany({
            where: { userId: currentUserId },
            select: { projectId: true },
          })
        : Promise.resolve([]),
    ]);
    scopedProjectIds = new Set([
      ...owned.map((p) => p.id),
      ...assignedProjects.map((t) => t.projectId).filter(Boolean) as string[],
      ...explicitAssignments.map((a) => a.projectId),
    ]);
  }

  const projectWhere = isScoped && scopedProjectIds
    ? { id: { in: Array.from(scopedProjectIds) } }
    : undefined;

  const taskWhere = isScoped && scopedProjectIds
    ? {
        OR: [
          { projectId: { in: Array.from(scopedProjectIds) } },
          { assignee: { name: userName } },
        ],
      }
    : undefined;

  // For scoped users, only show team members who have tasks in the user's
  // projects or who are explicitly assigned to those projects. Admins see all.
  let memberWhere: Prisma.TeamMemberWhereInput | undefined;
  if (isScoped && scopedProjectIds && scopedProjectIds.size > 0) {
    const projectIdArray = Array.from(scopedProjectIds);
    memberWhere = {
      OR: [
        { tasks: { some: { projectId: { in: projectIdArray } } } },
        { email: { in: await db.projectAssignment.findMany({
          where: { projectId: { in: projectIdArray } },
          select: { user: { select: { email: true } } },
        }).then((assignments) => assignments.map((a) => a.user.email)) } },
        { name: userName }, // always include yourself
      ],
    };
  } else if (isScoped) {
    // Scoped user with no projects — show only themselves
    memberWhere = { name: userName };
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
    db.notification.findMany({ orderBy: { createdAt: "desc" }, take: 20 }),
    db.timeEntry.findMany({ orderBy: { date: "desc" } }),
    db.calendarEvent.findMany({ orderBy: { date: "asc" } }),
    db.message.findMany({
      where: currentUserId
        ? {
            OR: [
              { senderUserId: currentUserId },
              { recipientUserId: currentUserId },
            ],
          }
        : undefined,
      orderBy: { createdAt: "desc" },
    }),
  ]);

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
      timeEntries: timeEntries.map(te => ({
        ...te,
        date: te.date.toISOString(),
        createdAt: te.createdAt.toISOString(),
      })),
      events: events.map(e => ({
        ...e,
        date: e.date.toISOString(),
        createdAt: e.createdAt.toISOString(),
      })),
      messages: messages.map(m => ({
        ...m,
        createdAt: m.createdAt.toISOString(),
      })),
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

export async function getUserProfile(userId: string) {
  // Only the user themselves (or an admin/manager with role:manage) may read
  // a profile — otherwise any caller could harvest other users' emails.
  const auth = await getSessionOrThrow();
  if (auth.userId !== userId && !hasPermission(auth.role, "role:manage")) {
    throw new AuthorizationError("You can only view your own profile.");
  }
  const user = await db.user.findUnique({
    where: { id: userId },
    include: { settings: true },
  });
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    timezone: user.timezone,
    bio: user.bio,
    avatarColor: user.avatarColor,
    settings: user.settings
      ? {
          accent: user.settings.accent as string,
          dark: user.settings.dark,
          notifEmail: user.settings.notifEmail,
          notifPush: user.settings.notifPush,
          notifMentions: user.settings.notifMentions,
          notifDueToday: user.settings.notifDueToday,
          notifWeekly: user.settings.notifWeekly,
          notifProduct: user.settings.notifProduct,
        }
      : null,
  };
}

// ---------------------------------------------------------------------------
// User settings — persist theme/dark/notifications per-user in the DB
// ---------------------------------------------------------------------------

export async function getUserSettings(userId: string) {
  const auth = await getSession();
  if (!auth) throw new AuthorizationError("You must be signed in.");
  const settings = await db.userSettings.findUnique({ where: { userId } });
  if (!settings) {
    // Return defaults
    return {
      accent: "forest",
      dark: false,
      notifEmail: true,
      notifPush: true,
      notifMentions: true,
      notifDueToday: true,
      notifWeekly: false,
      notifProduct: true,
    };
  }
  return {
    accent: settings.accent,
    dark: settings.dark,
    notifEmail: settings.notifEmail,
    notifPush: settings.notifPush,
    notifMentions: settings.notifMentions,
    notifDueToday: settings.notifDueToday,
    notifWeekly: settings.notifWeekly,
    notifProduct: settings.notifProduct,
  };
}

export async function updateUserSettings(userId: string, input: Partial<{
  accent: string;
  dark: boolean;
  notifEmail: boolean;
  notifPush: boolean;
  notifMentions: boolean;
  notifDueToday: boolean;
  notifWeekly: boolean;
  notifProduct: boolean;
}>) {
  const auth = await getSession();
  if (!auth) throw new AuthorizationError("You must be signed in.");
  if (auth.userId !== userId) {
    throw new AuthorizationError("You can only update your own settings.");
  }
  await db.userSettings.upsert({
    where: { userId },
    create: { userId, ...input },
    update: input,
  });
  revalidatePath("/");
}

// ---------------------------------------------------------------------------
// Task CRUD
// ---------------------------------------------------------------------------

/**
 * Resolve the TeamMember id that belongs to the signed-in user (matched by
 * email). Returns null if the user has no team-member record.
 */
async function getMyTeamMemberId(auth: { email: string }): Promise<string | null> {
  const member = await db.teamMember.findUnique({
    where: { email: auth.email.toLowerCase() },
    select: { id: true },
  });
  return member?.id ?? null;
}

/**
 * Enforce task edit rights for the signed-in user.
 * `task:edit:any` — may edit anything. `task:edit:own` (without :any) — may
 * only edit tasks assigned to them; anything else is an authorization error.
 */
async function assertTaskEditPermission(
  auth: { userId: string; email: string; role: Role },
  task: { assigneeId: string | null },
) {
  if (hasPermission(auth.role, "task:edit:any")) return;
  const myMemberId = await getMyTeamMemberId(auth);
  if (!task.assigneeId || task.assigneeId !== myMemberId) {
    throw new AuthorizationError("You can only edit tasks that are assigned to you.");
  }
}

export async function createTask(input: {
  title: string;
  description?: string;
  status?: string;
  priority?: string;
  tag?: string;
  dueDate?: string | null;
  projectId?: string | null;
  assigneeId?: string | null;
}) {
  const auth = await requirePermission("task:create");
  const data = parseOrThrow(createTaskSchema, input);
  const maxOrder = await db.task.aggregate({
    where: { status: data.status ?? "TODO" },
    _max: { order: true },
  });
  const task = await db.task.create({
    data: {
      title: data.title,
      description: data.description ?? "",
      status: data.status ?? "TODO",
      priority: data.priority ?? "MEDIUM",
      tag: data.tag ?? "FRONTEND",
      dueDate: data.dueDate ? new Date(data.dueDate) : null,
      projectId: data.projectId || null,
      assigneeId: data.assigneeId || null,
      order: (maxOrder._max.order ?? -1) + 1,
    },
    include: { project: true },
  });
  await recalcMemberStats(data.assigneeId ?? null);
  await logAudit({
    actor: auth,
    action: "task.created",
    entityType: "TASK",
    entityId: task.id,
    entityLabel: task.title,
    detail: task.project
      ? `Created task “${task.title}” in ${task.project.name}`
      : `Created task “${task.title}” without a project`,
  });
  revalidatePath("/");
}

export async function updateTask(id: string, raw: Partial<{
  title: string;
  description: string;
  status: string;
  priority: string;
  tag: string;
  dueDate: string | null;
  projectId: string | null;
  assigneeId: string | null;
}>) {
  // task:edit:any allows editing any task; otherwise the task must be
  // assigned to the requesting user (ownership enforced below).
  const auth = await requirePermission("task:edit:own");
  const existing = await db.task.findUnique({ where: { id } });
  if (!existing) return;
  await assertTaskEditPermission(auth, existing);
  const input = parseOrThrow(updateTaskSchema, raw);
  await db.task.update({
    where: { id },
    data: {
      title: input.title,
      description: input.description,
      status: input.status,
      priority: input.priority,
      tag: input.tag,
      dueDate: input.dueDate !== undefined ? (input.dueDate ? new Date(input.dueDate) : null) : undefined,
      projectId: input.projectId,
      assigneeId: input.assigneeId,
    },
  });
  await recalcMemberStats(existing.assigneeId);
  if (input.assigneeId && input.assigneeId !== existing.assigneeId) {
    await recalcMemberStats(input.assigneeId);
  }
  const changes: string[] = [];
  if (input.title !== undefined && input.title !== existing.title) changes.push("title");
  if (input.status !== undefined && input.status !== existing.status) changes.push("status");
  if (input.priority !== undefined && input.priority !== existing.priority) changes.push("priority");
  if (input.tag !== undefined && input.tag !== existing.tag) changes.push("tag");
  if (input.description !== undefined && input.description !== existing.description) changes.push("description");
  if (input.dueDate !== undefined) {
    const nd = input.dueDate ? new Date(input.dueDate).toISOString() : null;
    const od = existing.dueDate ? existing.dueDate.toISOString() : null;
    if (nd !== od) changes.push("due date");
  }
  if (input.projectId !== undefined && input.projectId !== existing.projectId) changes.push("project");
  if (input.assigneeId !== undefined && input.assigneeId !== existing.assigneeId) changes.push("assignee");
  await logAudit({
    actor: auth,
    action: "task.updated",
    entityType: "TASK",
    entityId: id,
    entityLabel: input.title ?? existing.title,
    detail: changes.length
      ? `Updated ${changes.join(", ")} on “${input.title ?? existing.title}”`
      : `Saved task “${input.title ?? existing.title}”`,
  });
  revalidatePath("/");
}

export async function moveTask(id: string, newStatus: string, newOrder: number) {
  const auth = await requirePermission("task:edit:own");
  const task = await db.task.findUnique({ where: { id } });
  if (!task) return;
  await assertTaskEditPermission(auth, task);
  const oldAssignee = task.assigneeId;
  await db.task.update({
    where: { id },
    data: { status: newStatus, order: newOrder },
  });
  await recalcMemberStats(oldAssignee);
  if (task.status !== newStatus) {
    await logAudit({
      actor: auth,
      action: "task.moved",
      entityType: "TASK",
      entityId: id,
      entityLabel: task.title,
      detail: `Moved “${task.title}” to ${TASK_STATUS_LABELS[newStatus as keyof typeof TASK_STATUS_LABELS] ?? newStatus}`,
    });
  }
  revalidatePath("/");
}

export async function deleteTask(id: string) {
  const auth = await requirePermission("task:delete");
  const task = await db.task.findUnique({ where: { id } });
  if (!task) return;
  await db.task.delete({ where: { id } });
  await recalcMemberStats(task.assigneeId);
  await logAudit({
    actor: auth,
    action: "task.deleted",
    entityType: "TASK",
    entityId: id,
    entityLabel: task.title,
    detail: `Deleted task “${task.title}”`,
  });
  revalidatePath("/");
}

async function recalcMemberStats(memberId: string | null) {
  if (!memberId) return;
  const tasks = await db.task.findMany({ where: { assigneeId: memberId } });
  const open = tasks.filter((t) => t.status !== "DONE").length;
  const completed = tasks.filter((t) => t.status === "DONE").length;
  const workload = Math.min(100, Math.round((open / 6) * 100));
  await db.teamMember.update({
    where: { id: memberId },
    data: { openTasks: open, completedTasks: completed, workload },
  });
}

// ---------------------------------------------------------------------------
// Project CRUD
// ---------------------------------------------------------------------------

export async function createProject(input: {
  name: string;
  description?: string;
  status?: string;
  priority?: string;
  dueDate?: string | null;
  color?: string;
  ownerName?: string;
}) {
  const auth = await requirePermission("project:create");
  const data = parseOrThrow(createProjectSchema, input);
  const project = await db.project.create({
    data: {
      name: data.name,
      description: data.description ?? "",
      status: data.status ?? "RUNNING",
      priority: data.priority ?? "MEDIUM",
      dueDate: data.dueDate ? new Date(data.dueDate) : null,
      color: data.color ?? "forest",
      ownerName: data.ownerName ?? "",
    },
  });
  await logAudit({
    actor: auth,
    action: "project.created",
    entityType: "PROJECT",
    entityId: project.id,
    entityLabel: project.name,
    detail: `Created project “${project.name}”`,
  });
  revalidatePath("/");
}

export async function updateProject(id: string, input: Partial<{
  name: string;
  description: string;
  status: string;
  priority: string;
  dueDate: string | null;
  color: string;
  ownerName: string;
  progress: number;
}>) {
  const auth = await requirePermission("project:edit");
  const existing = await db.project.findUnique({ where: { id } });
  await db.project.update({
    where: { id },
    data: {
      name: input.name,
      description: input.description,
      status: input.status,
      priority: input.priority,
      dueDate: input.dueDate !== undefined ? (input.dueDate ? new Date(input.dueDate) : null) : undefined,
      color: input.color,
      ownerName: input.ownerName,
      progress: input.progress,
    },
  });
  if (existing) {
    const changes: string[] = [];
    if (input.name !== undefined && input.name !== existing.name) changes.push("name");
    if (input.description !== undefined && input.description !== existing.description) changes.push("description");
    if (input.status !== undefined && input.status !== existing.status) changes.push("status");
    if (input.priority !== undefined && input.priority !== existing.priority) changes.push("priority");
    if (input.color !== undefined && input.color !== existing.color) changes.push("color");
    if (input.ownerName !== undefined && input.ownerName !== existing.ownerName) changes.push("owner");
    if (input.progress !== undefined && input.progress !== existing.progress) changes.push("progress");
    if (input.dueDate !== undefined) {
      const nd = input.dueDate ? new Date(input.dueDate).toISOString() : null;
      const od = existing.dueDate ? existing.dueDate.toISOString() : null;
      if (nd !== od) changes.push("due date");
    }
    await logAudit({
      actor: auth,
      action: "project.updated",
      entityType: "PROJECT",
      entityId: id,
      entityLabel: input.name ?? existing.name,
      detail: changes.length
        ? `Updated ${changes.join(", ")} on project “${input.name ?? existing.name}”`
        : `Saved project “${input.name ?? existing.name}”`,
    });
  }
  revalidatePath("/");
}

export async function deleteProject(id: string) {
  const auth = await requirePermission("project:delete");
  const existing = await db.project.findUnique({ where: { id } });
  await db.project.delete({ where: { id } });
  if (existing) {
    await logAudit({
      actor: auth,
      action: "project.deleted",
      entityType: "PROJECT",
      entityId: id,
      entityLabel: existing.name,
      detail: `Deleted project “${existing.name}”`,
    });
  }
  revalidatePath("/");
}

// ---------------------------------------------------------------------------
// Team Member CRUD
// ---------------------------------------------------------------------------

export async function createMember(input: {
  name: string;
  role: string;
  department: string;
  email: string;
  avatarColor?: string;
  online?: boolean;
}) {
  const auth = await requirePermission("member:invite");
  const data = parseOrThrow(createMemberSchema, input);
  const member = await db.teamMember.create({
    data: {
      name: data.name,
      role: data.role,
      department: data.department,
      email: data.email,
      avatarColor: data.avatarColor ?? "forest",
      online: data.online ?? false,
    },
  });
  await logAudit({
    actor: auth,
    action: "member.invited",
    entityType: "MEMBER",
    entityId: member.id,
    entityLabel: member.name,
    detail: `Invited ${member.name} (${member.role}) to the team`,
  });
  revalidatePath("/");
}

export async function updateMember(id: string, input: Partial<{
  name: string;
  role: string;
  department: string;
  email: string;
  avatarColor: string;
  online: boolean;
}>) {
  const auth = await requirePermission("member:edit");
  const existing = await db.teamMember.findUnique({ where: { id } });
  await db.teamMember.update({ where: { id }, data: input });
  if (existing) {
    const changes: string[] = [];
    if (input.name !== undefined && input.name !== existing.name) changes.push("name");
    if (input.role !== undefined && input.role !== existing.role) changes.push("job title");
    if (input.department !== undefined && input.department !== existing.department) changes.push("department");
    if (input.email !== undefined && input.email !== existing.email) changes.push("email");
    if (input.online !== undefined && input.online !== existing.online) changes.push("availability");
    await logAudit({
      actor: auth,
      action: "member.updated",
      entityType: "MEMBER",
      entityId: id,
      entityLabel: input.name ?? existing.name,
      detail: changes.length
        ? `Updated ${changes.join(", ")} for ${input.name ?? existing.name}`
        : `Saved profile of ${input.name ?? existing.name}`,
    });
  }
  revalidatePath("/");
}

export async function deleteMember(id: string) {
  const auth = await requirePermission("member:delete");
  const existing = await db.teamMember.findUnique({ where: { id } });
  await db.teamMember.delete({ where: { id } });
  if (existing) {
    await logAudit({
      actor: auth,
      action: "member.removed",
      entityType: "MEMBER",
      entityId: id,
      entityLabel: existing.name,
      detail: `Removed ${existing.name} (${existing.role}) from the team`,
    });
  }
  revalidatePath("/");
}

// ---------------------------------------------------------------------------
// Calendar Event CRUD
// ---------------------------------------------------------------------------

export async function createEvent(input: {
  title: string;
  description?: string;
  date: string;
  time?: string;
  durationMin?: number;
  type?: string;
  location?: string;
}) {
  const auth = await requirePermission("event:create");
  const data = parseOrThrow(createEventSchema, input);
  const event = await db.calendarEvent.create({
    data: {
      title: data.title,
      description: data.description ?? "",
      date: new Date(data.date),
      time: data.time ?? "09:00",
      durationMin: data.durationMin ?? 60,
      type: data.type ?? "MEETING",
      location: data.location ?? "",
    },
  });
  await logAudit({
    actor: auth,
    action: "event.created",
    entityType: "EVENT",
    entityId: event.id,
    entityLabel: event.title,
    detail: `Scheduled “${event.title}” on ${fmtDay(event.date)} at ${event.time}`,
  });
  revalidatePath("/");
}

export async function deleteEvent(id: string) {
  const auth = await requirePermission("event:delete");
  const existing = await db.calendarEvent.findUnique({ where: { id } });
  await db.calendarEvent.delete({ where: { id } });
  if (existing) {
    await logAudit({
      actor: auth,
      action: "event.deleted",
      entityType: "EVENT",
      entityId: id,
      entityLabel: existing.title,
      detail: `Deleted event “${existing.title}”`,
    });
  }
  revalidatePath("/");
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export async function markNotificationRead(id: string, read: boolean) {
  // Notifications are a workspace-wide feed, but only signed-in users may
  // mutate them.
  await getSessionOrThrow();
  await db.notification.update({ where: { id }, data: { read } });
  revalidatePath("/");
}

export async function markAllNotificationsRead() {
  await getSessionOrThrow();
  await db.notification.updateMany({ where: { read: false }, data: { read: true } });
  revalidatePath("/");
}

// ---------------------------------------------------------------------------
// Reminders
// ---------------------------------------------------------------------------

export async function toggleReminder(id: string, completed: boolean) {
  const auth = await getSessionOrThrow();
  const existing = await db.reminder.findUnique({ where: { id } });
  // Personal reminders can only be toggled by their owner (or an admin).
  if (existing?.ownerId && existing.ownerId !== auth.userId && !hasPermission(auth.role, "role:manage")) {
    throw new AuthorizationError("You can only change your own reminders.");
  }
  await db.reminder.update({ where: { id }, data: { completed } });
  if (existing && existing.completed !== completed) {
    await logAudit({
      actor: auth,
      action: completed ? "reminder.completed" : "reminder.reopened",
      entityType: "REMINDER",
      entityId: id,
      entityLabel: existing.title,
      detail: completed
        ? `Completed reminder “${existing.title}”`
        : `Reopened reminder “${existing.title}”`,
    });
  }
  revalidatePath("/");
}

export async function createReminder(raw: { title: string; dueDate: string }) {
  const auth = await getSessionOrThrow();
  const input = parseOrThrow(createReminderSchema, raw);
  // New reminders are personal — only the creator sees them.
  const reminder = await db.reminder.create({
    data: { title: input.title, dueDate: new Date(input.dueDate), ownerId: auth.userId },
  });
  await logAudit({
    actor: auth,
    action: "reminder.created",
    entityType: "REMINDER",
    entityId: reminder.id,
    entityLabel: input.title,
    detail: `Added reminder “${input.title}”`,
  });
  revalidatePath("/");
}

// ---------------------------------------------------------------------------
// User profile
// ---------------------------------------------------------------------------

export async function updateProfile(userId: string, input: {
  name: string;
  role: string;
  timezone: string;
  bio: string;
  avatarColor: string;
}) {
  const auth = await getSession();
  if (!auth) throw new AuthorizationError("You must be signed in.");
  if (auth.userId !== userId) {
    throw new AuthorizationError("You can only update your own profile.");
  }
  const existing = await db.user.findUnique({ where: { id: userId } });
  await db.user.update({ where: { id: userId }, data: input });
  if (existing) {
    const changes: string[] = [];
    if (input.name !== existing.name) changes.push("name");
    if (input.role !== existing.role) changes.push("job title");
    if (input.timezone !== existing.timezone) changes.push("timezone");
    if (input.bio !== existing.bio) changes.push("bio");
    if (input.avatarColor !== existing.avatarColor) changes.push("avatar color");
    await logAudit({
      actor: auth,
      action: "profile.updated",
      entityType: "USER",
      entityId: userId,
      entityLabel: input.name,
      detail: changes.length
        ? `Updated ${changes.join(", ")} on their profile`
        : "Saved their profile",
    });
  }
  revalidatePath("/");
}

// ---------------------------------------------------------------------------
// Time tracking
// ---------------------------------------------------------------------------

export async function logTime(input: {
  projectId: string;
  memberId?: string; // ignored — always derived from the session for integrity
  date: string;
  hours: number;
  description?: string;
}) {
  const auth = await getSessionOrThrow();
  // Time entries must be attributable to the person who logged them — a
  // client-supplied memberId would let anyone forge another member's hours.
  const myMemberId = await getMyTeamMemberId(auth);
  if (!myMemberId) {
    throw new AuthorizationError("You don't have a team member profile to log time against.");
  }
  if (!Number.isFinite(input.hours) || input.hours <= 0 || input.hours > 24) {
    throw new AuthorizationError("Hours must be between 0 and 24.");
  }
  const entry = await db.timeEntry.create({
    data: {
      projectId: input.projectId,
      memberId: myMemberId,
      date: new Date(input.date),
      hours: input.hours,
      description: input.description ?? "",
    },
  });
  const project = input.projectId
    ? await db.project.findUnique({ where: { id: input.projectId } })
    : null;
  await logAudit({
    actor: auth,
    action: "time.logged",
    entityType: "TIME",
    entityId: entry.id,
    entityLabel: project?.name ?? "Unassigned",
    detail: `Logged ${input.hours}h${project ? ` on “${project.name}”` : ""}`,
  });
  revalidatePath("/");
}

// ---------------------------------------------------------------------------
// Messages (Team messaging)
// ---------------------------------------------------------------------------

export async function sendMessage(raw: {
  direction: "OUT" | "IN";
  threadId?: string;
  memberId?: string | null;
  senderName: string;
  senderAvatarColor?: string;
  senderRole?: string;
  recipientName: string;
  recipientUserId?: string;
  subject: string;
  body: string;
}) {
  const auth = await requirePermission("message:send");
  const input = parseOrThrow(sendMessageSchema, raw);
  // Generate a threadId if not provided (new conversation)
  const threadId = input.threadId || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await db.message.create({
    data: {
      direction: input.direction,
      threadId,
      memberId: input.memberId || null,
      senderUserId: auth.userId,
      recipientUserId: input.recipientUserId || "",
      senderName: input.senderName,
      senderAvatarColor: input.senderAvatarColor || "forest",
      senderRole: input.senderRole || "",
      recipientName: input.recipientName,
      subject: input.subject,
      body: input.body,
      read: input.direction === "OUT" ? true : false, // outgoing is always "read"
    },
  });
  await logAudit({
    actor: auth,
    action: "message.sent",
    entityType: "MESSAGE",
    entityLabel: input.subject,
    detail: `Sent “${input.subject}” to ${input.recipientName}`,
  });
  revalidatePath("/");
  return threadId;
}

export async function markMessageRead(id: string) {
  // Only the recipient of a message may mark it as read.
  const auth = await getSessionOrThrow();
  await db.message.updateMany({
    where: { id, recipientUserId: auth.userId },
    data: { read: true },
  });
  revalidatePath("/");
}

// Look up a user by email — used by the messaging UI to find the recipient's userId
export async function getUserByEmail(email: string) {
  const auth = await getSession();
  if (!auth) throw new AuthorizationError("You must be signed in.");
  const user = await db.user.findUnique({
    where: { email: email.toLowerCase() },
    select: { id: true, name: true, email: true, avatarColor: true },
  });
  return user;
}

export async function markThreadRead(threadId: string) {
  // Only messages addressed to the signed-in user are marked read.
  const auth = await getSessionOrThrow();
  await db.message.updateMany({
    where: { threadId, direction: "IN", read: false, recipientUserId: auth.userId },
    data: { read: true },
  });
  revalidatePath("/");
}

export async function deleteMessage(id: string) {
  const auth = await requirePermission("message:send"); // anyone who can send can delete their own
  const existing = await db.message.findUnique({ where: { id } });
  // Ownership: only the sender or the recipient of a message may delete it.
  if (existing && existing.senderUserId !== auth.userId && existing.recipientUserId !== auth.userId) {
    throw new AuthorizationError("You can only delete messages you sent or received.");
  }
  await db.message.delete({ where: { id } });
  if (existing) {
    await logAudit({
      actor: auth,
      action: "message.deleted",
      entityType: "MESSAGE",
      entityId: id,
      entityLabel: existing.subject,
      detail: `Deleted message “${existing.subject}”`,
    });
  }
  revalidatePath("/");
}

// ---------------------------------------------------------------------------
// User role management (Admin only)
// ---------------------------------------------------------------------------

export async function getAllUsers() {
  await requirePermission("role:manage");
  const users = await db.user.findMany({
    select: {
      id: true, email: true, name: true, role: true, avatarColor: true, createdAt: true,
      _count: { select: { projectAssignments: true } },
    },
    orderBy: { name: "asc" },
  });
  return users.map(u => ({
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    avatarColor: u.avatarColor,
    createdAt: u.createdAt.toISOString(),
    projectCount: u._count.projectAssignments,
  }));
}

// ---------------------------------------------------------------------------
// Full User CRUD — complete user management module
// ---------------------------------------------------------------------------
//
// These actions go beyond `createUserForMember` (which only creates a login
// for an existing team member). They let an admin create, edit, and delete
// user accounts from scratch — with a custom email, password, and role — and
// manage which projects each user is assigned to.
//
// When a new user is created we also create a matching TeamMember record so
// the user appears in the team directory and can be assigned tasks.

export async function createUser(input: {
  name: string;
  email: string;
  password: string;
  role: string;          // ADMIN | MANAGER | MEMBER
  timezone?: string;
  bio?: string;
  avatarColor?: string;
  department?: string;   // for the TeamMember record
  jobTitle?: string;     // for the TeamMember record
}) {
  const auth = await requirePermission("role:manage");

  // Validate
  const name = input.name.trim();
  const email = input.email.trim().toLowerCase();
  if (!name) throw new AuthorizationError("Name is required.");
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new AuthorizationError("A valid email is required.");
  }
  const minPasswordLength = await getMinPasswordLength();
  if (!input.password || input.password.length < minPasswordLength) {
    throw new AuthorizationError(`Password must be at least ${minPasswordLength} characters.`);
  }
  if (!["ADMIN", "MANAGER", "MEMBER"].includes(input.role)) {
    throw new AuthorizationError("Invalid role. Must be ADMIN, MANAGER, or MEMBER.");
  }

  // Check email uniqueness
  const existingUser = await db.user.findUnique({ where: { email } });
  if (existingUser) {
    throw new AuthorizationError(`A user with email ${email} already exists.`);
  }

  const passwordHash = await hashPassword(input.password);
  const avatarColor = input.avatarColor ?? "forest";
  const timezone = input.timezone ?? "Pacific/Auckland";
  const bio = input.bio ?? "";
  const department = input.department ?? "ENGINEERING";
  const jobTitle = input.jobTitle ?? "Team Member";

  // Create the User (login account) — single click, login created in the same
  // transaction.
  const user = await db.$transaction(async (tx) => {
    const created = await tx.user.create({
      data: {
        email,
        name,
        passwordHash,
        role: input.role,
        timezone,
        bio,
        avatarColor,
      },
    });
    const existingMember = await tx.teamMember.findUnique({ where: { email } });
    if (!existingMember) {
      await tx.teamMember.create({
        data: {
          name,
          email,
          role: jobTitle,
          department,
          avatarColor,
          online: false,
        },
      });
    }
    return created;
  });

  // Also create a matching TeamMember record (if one doesn't already exist
  // with the same email) so the user shows up in the team directory and can
  // be assigned tasks.
  await logAudit({
    actor: auth,
    action: "user.created",
    entityType: "USER",
    entityId: user.id,
    entityLabel: name,
    detail: `Created user ${name} (${email}) with role ${ROLE_LABELS[input.role as Role] ?? input.role}`,
  });
  revalidatePath("/");
  return { id: user.id };
}

export async function updateUser(userId: string, input: {
  name?: string;
  email?: string;
  role?: string;
  timezone?: string;
  bio?: string;
  avatarColor?: string;
  department?: string;
  jobTitle?: string;
  resetPassword?: string;  // if provided, set a new password
}) {
  const auth = await requirePermission("role:manage");
  const target = await db.user.findUnique({ where: { id: userId } });
  if (!target) throw new AuthorizationError("User not found.");

  // Self-protection: cannot demote yourself
  if (userId === auth.userId && input.role && input.role !== "ADMIN") {
    throw new AuthorizationError("You cannot change your own role. Ask another admin to do it.");
  }

  const data: Record<string, unknown> = {};
  if (input.name !== undefined) data.name = input.name.trim();
  if (input.email !== undefined) {
    const email = input.email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new AuthorizationError("A valid email is required.");
    }
    data.email = email;
  }
  if (input.role !== undefined) {
    if (!["ADMIN", "MANAGER", "MEMBER"].includes(input.role)) {
      throw new AuthorizationError("Invalid role.");
    }
    data.role = input.role;
  }
  if (input.timezone !== undefined) data.timezone = input.timezone;
  if (input.bio !== undefined) data.bio = input.bio;
  if (input.avatarColor !== undefined) data.avatarColor = input.avatarColor;

  if (input.resetPassword !== undefined && input.resetPassword.length > 0) {
    const minPasswordLength = await getMinPasswordLength();
    if (input.resetPassword.length < minPasswordLength) {
      throw new AuthorizationError(`Password must be at least ${minPasswordLength} characters.`);
    }
    data.passwordHash = await hashPassword(input.resetPassword);
  }

  await db.user.update({ where: { id: userId }, data });

  // Sync name/email/avatarColor to the matching TeamMember record (if any)
  const memberUpdate: Record<string, unknown> = {};
  if (input.name !== undefined) memberUpdate.name = input.name.trim();
  if (input.email !== undefined) memberUpdate.email = input.email.trim().toLowerCase();
  if (input.avatarColor !== undefined) memberUpdate.avatarColor = input.avatarColor;
  if (input.jobTitle !== undefined) memberUpdate.role = input.jobTitle;
  if (input.department !== undefined) memberUpdate.department = input.department;
  if (Object.keys(memberUpdate).length > 0) {
    await db.teamMember.updateMany({
      where: { email: target.email },
      data: memberUpdate,
    });
  }

  const changes: string[] = [];
  if (input.name !== undefined && input.name !== target.name) changes.push("name");
  if (input.email !== undefined && input.email !== target.email) changes.push("email");
  if (input.role !== undefined && input.role !== target.role) changes.push("role");
  if (input.timezone !== undefined && input.timezone !== target.timezone) changes.push("timezone");
  if (input.bio !== undefined && input.bio !== target.bio) changes.push("bio");
  if (input.avatarColor !== undefined && input.avatarColor !== target.avatarColor) changes.push("avatar");
  if (input.resetPassword) changes.push("password");

  await logAudit({
    actor: auth,
    action: "user.updated",
    entityType: "USER",
    entityId: userId,
    entityLabel: input.name ?? target.name,
    detail: changes.length
      ? `Updated ${changes.join(", ")} for ${input.name ?? target.name}`
      : `Saved user ${input.name ?? target.name}`,
  });
  revalidatePath("/");
}

export async function deleteUser(userId: string) {
  const auth = await requirePermission("role:manage");
  if (userId === auth.userId) {
    throw new AuthorizationError("You cannot delete your own account. Ask another admin to do it.");
  }
  const target = await db.user.findUnique({ where: { id: userId } });
  if (!target) throw new AuthorizationError("User not found.");
  // ProjectAssignments are auto-deleted via onDelete: Cascade
  await db.user.delete({ where: { id: userId } });
  await logAudit({
    actor: auth,
    action: "user.deleted",
    entityType: "USER",
    entityId: userId,
    entityLabel: target.name,
    detail: `Deleted user ${target.name} (${target.email})`,
  });
  revalidatePath("/");
}

// ---------------------------------------------------------------------------
// Project assignments
// ---------------------------------------------------------------------------

export async function assignUserToProject(userId: string, projectId: string, role: string = "MEMBER") {
  const auth = await requirePermission("role:manage");
  const user = await db.user.findUnique({ where: { id: userId } });
  if (!user) throw new AuthorizationError("User not found.");
  const project = await db.project.findUnique({ where: { id: projectId } });
  if (!project) throw new AuthorizationError("Project not found.");
  // upsert so calling twice is idempotent
  await db.projectAssignment.upsert({
    where: { projectId_userId: { projectId, userId } },
    create: { projectId, userId, role },
    update: { role },
  });
  await logAudit({
    actor: auth,
    action: "project.assigned",
    entityType: "PROJECT",
    entityId: projectId,
    entityLabel: project.name,
    detail: `Assigned ${user.name} to project “${project.name}” as ${role.toLowerCase()}`,
  });
  revalidatePath("/");
}

export async function unassignUserFromProject(userId: string, projectId: string) {
  const auth = await requirePermission("role:manage");
  const user = await db.user.findUnique({ where: { id: userId } });
  const project = await db.project.findUnique({ where: { id: projectId } });
  await db.projectAssignment.deleteMany({
    where: { projectId, userId },
  });
  if (user && project) {
    await logAudit({
      actor: auth,
      action: "project.unassigned",
      entityType: "PROJECT",
      entityId: projectId,
      entityLabel: project.name,
      detail: `Unassigned ${user.name} from project “${project.name}”`,
    });
  }
  revalidatePath("/");
}

export async function getUserProjectAssignments(userId: string) {
  await requirePermission("role:manage");
  const assignments = await db.projectAssignment.findMany({
    where: { userId },
    include: { project: true },
    orderBy: { createdAt: "asc" },
  });
  return assignments.map((a) => ({
    id: a.id,
    projectId: a.projectId,
    userId: a.userId,
    role: a.role,
    project: {
      id: a.project.id,
      name: a.project.name,
      color: a.project.color,
      status: a.project.status,
    },
  }));
}

export async function getProjectAssignments(projectId: string) {
  const auth = await getSession();
  if (!auth) throw new AuthorizationError("You must be signed in.");
  const assignments = await db.projectAssignment.findMany({
    where: { projectId },
    include: { user: true },
    orderBy: { createdAt: "asc" },
  });
  return assignments.map((a) => ({
    id: a.id,
    projectId: a.projectId,
    userId: a.userId,
    role: a.role,
    user: {
      id: a.user.id,
      name: a.user.name,
      email: a.user.email,
      role: a.user.role,
      avatarColor: a.user.avatarColor,
    },
  }));
}

// ---------------------------------------------------------------------------
// Audit log (Admin + Manager)
// ---------------------------------------------------------------------------

export async function getAuditLogs() {
  await requirePermission("audit:view");
  const logs = await db.auditLog.findMany({
    orderBy: { createdAt: "desc" },
    take: 300,
  });
  return logs.map((l) => ({
    ...l,
    createdAt: l.createdAt.toISOString(),
  }));
}

/**
 * Audit history for a single entity (e.g. one task, one project, one member).
 *
 * Unlike `getAuditLogs()` (which requires the `audit:view` permission and is
 * meant for the workspace-wide Audit Log page), this is callable by anyone
 * who can see the entity — i.e. anyone signed in. The reasoning: the audit
 * trail of a task you're editing is part of that task's context, and hiding
 * it would let a bad actor edit a task without other assignees ever seeing
 * who touched it. The action still respects the underlying RBAC layer
 * (you can't edit a task you can't edit), so surfacing its history is safe.
 *
 * Results are capped at the most recent 50 entries to keep the modal light.
 */
export async function getAuditLogsForEntity(entityType: string, entityId: string) {
  const auth = await getSession();
  if (!auth) throw new AuthorizationError("You must be signed in.");
  if (!entityId) return [];
  const logs = await db.auditLog.findMany({
    where: { entityType, entityId },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  return logs.map((l) => ({
    ...l,
    createdAt: l.createdAt.toISOString(),
  }));
}

// ---------------------------------------------------------------------------
// Projects the current user is associated with (owner or task assignee)
// ---------------------------------------------------------------------------

export async function getMyProjects() {
  const auth = await getSession();
  if (!auth) return [];
  const projects = await db.project.findMany({
    where: {
      OR: [
        { ownerName: auth.name },
        { tasks: { some: { assignee: { name: auth.name } } } },
        { assignments: { some: { userId: auth.userId } } },
      ],
    },
    select: { id: true, name: true, color: true, status: true },
    orderBy: { name: "asc" },
  });
  return projects;
}

// ---------------------------------------------------------------------------
// Members allocated to a specific project.
//
// "Allocated" means the member is either:
//   • the project's owner (Project.ownerName === member.name), OR
//   • the assignee of at least one task in that project.
//
// Used by the task modal to restrict the assignee dropdown to only people who
// are actually working on the selected project. Admins still get the full team
// list when no project is selected, but once a project is picked the same
// restriction applies — you can't assign a task to someone outside the project.
// ---------------------------------------------------------------------------

export async function getProjectMembers(projectId: string) {
  const auth = await getSession();
  if (!auth) throw new AuthorizationError("You must be signed in.");

  const project = await db.project.findUnique({
    where: { id: projectId },
    select: { id: true, name: true, ownerName: true },
  });
  if (!project) return [];

  // Members who already have at least one task in this project.
  const assignedMembers = await db.teamMember.findMany({
    where: { tasks: { some: { projectId } } },
    orderBy: { name: "asc" },
  });

  // Always include the project owner (if they're a team member).
  const ownerMember = project.ownerName
    ? await db.teamMember.findFirst({ where: { name: project.ownerName } })
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
  for (const m of assignedMembers) push(m, m.name === project.ownerName);

  return merged;
}

// ---------------------------------------------------------------------------
// Change password (self-service)
// ---------------------------------------------------------------------------

export async function changePassword(input: {
  userId: string;
  currentPassword: string;
  newPassword: string;
}) {
  const auth = await getSession();
  if (!auth) throw new AuthorizationError("You must be signed in.");
  if (auth.userId !== input.userId) {
    throw new AuthorizationError("You can only change your own password.");
  }
  const minPasswordLength = await getMinPasswordLength();
  if (!input.newPassword || input.newPassword.length < minPasswordLength) {
    throw new AuthorizationError(`New password must be at least ${minPasswordLength} characters.`);
  }
  if (input.currentPassword === input.newPassword) {
    throw new AuthorizationError("New password must be different from your current password.");
  }

  const user = await db.user.findUnique({ where: { id: input.userId } });
  if (!user) throw new AuthorizationError("Account not found.");

  const matches = await verifyPassword(input.currentPassword, user.passwordHash);
  if (!matches) {
    throw new AuthorizationError("Current password is incorrect.");
  }

  const newHash = await hashPassword(input.newPassword);
  await db.user.update({
    where: { id: input.userId },
    data: { passwordHash: newHash },
  });

  await logAudit({
    actor: auth,
    action: "auth.password_changed",
    entityType: "AUTH",
    entityId: input.userId,
    entityLabel: user.email,
    detail: `${user.name} changed their password`,
  });
  revalidatePath("/");
}

// ---------------------------------------------------------------------------
// Workspace config CRUD — admin-only mutations for all DB-backed config.
// Each mutation bumps the config cache so the next read sees the change.
// ---------------------------------------------------------------------------

export async function updateWorkspaceSettings(input: Partial<{
  name: string;
  defaultTimezone: string;
  defaultUserRole: string;
  defaultDepartment: string;
  defaultAvatarColor: string;
  defaultJobTitle: string;
  minPasswordLength: number;
  workloadFullCapacity: number;
  auditLogLimit: number;
  entityHistoryLimit: number;
  dashboardNotifLimit: number;
}>) {
  const auth = await requirePermission("role:manage");
  await db.workspace.upsert({
    where: { id: "default" },
    create: { id: "default", ...input },
    update: input,
  });
  bumpConfigCache();
  await logAudit({
    actor: auth,
    action: "workspace.updated",
    entityType: "WORKSPACE",
    entityLabel: "Workspace Settings",
    detail: "Updated workspace settings",
  });
  revalidatePath("/");
}

export async function updateConfigItem(
  table: "taskStatusConfig" | "projectStatusConfig" | "eventTypeConfig" | "taskTagConfig" | "priorityConfig" | "departmentConfig",
  id: string,
  data: Record<string, unknown>,
) {
  const auth = await requirePermission("role:manage");
  // @ts-expect-error — dynamic table name
  await db[table].update({ where: { id }, data });
  bumpConfigCache();
  await logAudit({
    actor: auth,
    action: "config.updated",
    entityType: "CONFIG",
    entityLabel: table,
    detail: `Updated ${table} config item`,
  });
  revalidatePath("/");
}

export async function createConfigItem(
  table: "taskStatusConfig" | "projectStatusConfig" | "eventTypeConfig" | "taskTagConfig" | "priorityConfig" | "departmentConfig",
  data: Record<string, unknown>,
) {
  const auth = await requirePermission("role:manage");
  // @ts-expect-error — dynamic table name
  await db[table].create({ data });
  bumpConfigCache();
  await logAudit({
    actor: auth,
    action: "config.created",
    entityType: "CONFIG",
    entityLabel: table,
    detail: `Created ${table} config item`,
  });
  revalidatePath("/");
}

export async function deleteConfigItem(
  table: "taskStatusConfig" | "projectStatusConfig" | "eventTypeConfig" | "taskTagConfig" | "priorityConfig" | "departmentConfig",
  id: string,
) {
  const auth = await requirePermission("role:manage");
  // @ts-expect-error — dynamic table name
  await db[table].delete({ where: { id } });
  bumpConfigCache();
  await logAudit({
    actor: auth,
    action: "config.deleted",
    entityType: "CONFIG",
    entityLabel: table,
    detail: `Deleted ${table} config item`,
  });
  revalidatePath("/");
}

// --- Role + Permission management ---

export async function updateRole(roleId: string, data: {
  label?: string;
  description?: string;
  iconName?: string;
  badgeClass?: string;
  permissions?: string[]; // permission keys
}) {
  const auth = await requirePermission("role:manage");
  const role = await db.role.findUnique({ where: { id: roleId } });
  if (!role) throw new AuthorizationError("Role not found.");

  await db.role.update({
    where: { id: roleId },
    data: {
      ...(data.label !== undefined && { label: data.label }),
      ...(data.description !== undefined && { description: data.description }),
      ...(data.iconName !== undefined && { iconName: data.iconName }),
      ...(data.badgeClass !== undefined && { badgeClass: data.badgeClass }),
    },
  });

  // Update permissions if provided
  if (data.permissions !== undefined) {
    // Replace atomically — a failure mid-way can never leave the role with
    // zero or duplicated permissions.
    await db.$transaction(async (tx) => {
      await tx.rolePermission.deleteMany({ where: { roleId } });
      const perms = await tx.permission.findMany({
        where: { key: { in: data.permissions } },
      });
      await tx.rolePermission.createMany({
        data: perms.map((p) => ({ roleId, permissionId: p.id })),
      });
    });
  }

  bumpConfigCache();
  await logAudit({
    actor: auth,
    action: "role.changed",
    entityType: "ROLE",
    entityId: roleId,
    entityLabel: role.label,
    detail: `Updated role "${role.label}"${data.permissions !== undefined ? ` (${data.permissions.length} permissions)` : ""}`,
  });
  revalidatePath("/");
}

export async function createRole(data: {
  key: string;
  label: string;
  description?: string;
  iconName?: string;
  badgeClass?: string;
  permissions?: string[];
}) {
  const auth = await requirePermission("role:manage");
  const existing = await db.role.findUnique({ where: { key: data.key } });
  if (existing) throw new AuthorizationError(`Role "${data.key}" already exists.`);

  const role = await db.role.create({
    data: {
      key: data.key,
      label: data.label,
      description: data.description ?? "",
      iconName: data.iconName ?? "Shield",
      badgeClass: data.badgeClass ?? "bg-muted text-muted-foreground",
      isSystem: false,
      sortOrder: await db.role.count(),
    },
  });

  if (data.permissions && data.permissions.length > 0) {
    const perms = await db.permission.findMany({
      where: { key: { in: data.permissions } },
    });
    for (const p of perms) {
      await db.rolePermission.create({
        data: { roleId: role.id, permissionId: p.id },
      });
    }
  }

  bumpConfigCache();
  await logAudit({
    actor: auth,
    action: "role.changed",
    entityType: "ROLE",
    entityId: role.id,
    entityLabel: role.label,
    detail: `Created role "${role.label}"`,
  });
  revalidatePath("/");
}

export async function deleteRole(roleId: string) {
  const auth = await requirePermission("role:manage");
  const role = await db.role.findUnique({ where: { id: roleId } });
  if (!role) throw new AuthorizationError("Role not found.");
  if (role.isSystem) throw new AuthorizationError("System roles cannot be deleted.");
  // Check no users are using this role
  const usersWithRole = await db.user.count({ where: { role: role.key } });
  if (usersWithRole > 0) {
    throw new AuthorizationError(`Cannot delete role "${role.label}" — ${usersWithRole} user(s) still have it. Reassign them first.`);
  }
  await db.role.delete({ where: { id: roleId } });
  bumpConfigCache();
  await logAudit({
    actor: auth,
    action: "role.changed",
    entityType: "ROLE",
    entityId: roleId,
    entityLabel: role.label,
    detail: `Deleted role "${role.label}"`,
  });
  revalidatePath("/");
}
