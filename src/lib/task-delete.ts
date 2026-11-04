// PR-61 — client-side mirror of the server's task-delete rule
// (server-actions/shared.ts → assertTaskDeletePermission).
//
// The server is the source of truth; this pure helper only decides whether
// the task modal should RENDER the Delete button so users never see a button
// that would just bounce back with an authorization error. If the two ever
// drift, the server still rejects — worst case is a hidden button, never an
// unauthorized delete.
//
// Rule (user-approved):
//   1. ADMIN                — any task (blanket task:delete permission).
//   2. assigned user        — their own task, any role.
//   3. project owner        — any task in a project they own, any role.
//   4. MANAGER of the team  — the task's assignee or the project owner
//                             reports to them (managedUserIds, the reporting
//                             subtree shipped with the dashboard payload).

import type { ProjectT, TeamMemberT } from "@/lib/types";

export interface TaskDeleteContext {
  /** The workspace roster — maps TeamMember ids to user ids. */
  members: TeamMemberT[];
  /** Visible projects — the owner check. */
  projects: ProjectT[];
  /** The signed-in user's TeamMember row id (assignee check). */
  myTeamMemberId?: string | null;
  /** MANAGER-only: user ids in the signed-in manager's reporting subtree. */
  managedUserIds?: string[];
}

export function canDeleteTask(
  sessionUser: { id: string; role: string } | null | undefined,
  task: { assigneeId: string | null; projectId: string | null },
  ctx: TaskDeleteContext,
): boolean {
  if (!sessionUser) return false;

  // 1. ADMIN — blanket permission (mirror of task:delete in lib/rbac.ts).
  if (sessionUser.role === "ADMIN") return true;

  // 2. The assigned user may delete their own task.
  if (task.assigneeId && task.assigneeId === ctx.myTeamMemberId) return true;

  const project = task.projectId
    ? ctx.projects.find((p) => p.id === task.projectId)
    : undefined;

  // 3. The project owner may delete tasks in their project.
  if (project?.ownerUserId && project.ownerUserId === sessionUser.id) return true;

  // 4. MANAGER — assignee or project owner must be in their subtree.
  if (sessionUser.role === "MANAGER") {
    const managed = new Set(ctx.managedUserIds ?? []);
    const assigneeUserId = task.assigneeId
      ? ctx.members.find((m) => m.id === task.assigneeId)?.userId
      : undefined;
    if (assigneeUserId && managed.has(assigneeUserId)) return true;
    if (project?.ownerUserId && managed.has(project.ownerUserId)) return true;
  }

  return false;
}
