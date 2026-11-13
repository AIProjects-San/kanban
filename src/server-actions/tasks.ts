"use server";

// Task CRUD. Every action returns an ActionResult — clients branch on
// `res.ok` instead of try/catching thrown errors across the boundary.

import { revalidatePath } from "next/cache";
import { db } from "@/lib/infra/db";
import { requirePermission, getSessionOrThrow } from "./auth-guard";
import { AuthorizationError } from "./auth-guard";
import { TASK_STATUS_LABELS } from "@/lib/config";
import { createTaskSchema, updateTaskSchema, moveTaskSchema, parseOrThrow } from "@/lib/validation";
import { logAudit, assertTaskEditPermission, assertTaskDeletePermission, recalcMemberStats, getScopedProjectIds, getProjectAssociatedUserIds, assertTeamMemberAssociatedWithProject } from "./shared";
import { notifyMentionedUsers } from "./mentions";
import { toResult } from "./result";
import type { ActionResult } from "@/lib/action-result";

export async function createTask(input: {
  title: string;
  description?: string;
  status?: string;
  priority?: string;
  tag?: string;
  dueDate?: string | null;
  projectId?: string | null;
  assigneeId?: string | null;
  estimateMinutes?: number;
}): Promise<ActionResult<void>> {
  return toResult(async () => {
    const auth = await requirePermission("task:create");
    const data = parseOrThrow(createTaskSchema, input);
    // Project association rule — tasks must belong to a project, and the
    // assignee must be a user associated with that project (explicit
    // ProjectAssignment or ownership). Legacy rows are untouched; this
    // guards every NEW task.
    if (!data.projectId) {
      throw new AuthorizationError("Task must be assigned to a project.");
    }
    // P1 (edge-case audit) — scope the projectId against the caller's visible
    // projects. Previously a MEMBER could create tasks in ANY project (the
    // task:create permission is static), opening a data-injection + mention-
    // phishing vector (clutter another project's board + @mention arbitrary
    // users via the description). ADMIN is unscoped; MANAGER/MEMBER must own
    // / be assigned to / be explicitly allocated to the project.
    const scopedIds = await getScopedProjectIds(auth);
    if (scopedIds && !scopedIds.has(data.projectId)) {
      throw new AuthorizationError("You can only create tasks in projects you have access to.");
    }
    // The project must exist (and not be soft-deleted) — otherwise ADMIN
    // (unscoped) could create tasks pointing at a ghost project.
    const associatedUserIds = await getProjectAssociatedUserIds(data.projectId);
    if (associatedUserIds === null) {
      throw new AuthorizationError("Project not found.");
    }
    // Assignee (optional at creation) must be associated with the project.
    if (data.assigneeId) {
      await assertTeamMemberAssociatedWithProject(data.assigneeId, data.projectId);
    }
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
        projectId: data.projectId,
        assigneeId: data.assigneeId || null,
        estimateMinutes: data.estimateMinutes ?? 0,
        order: (maxOrder._max.order ?? -1) + 1,
      },
      include: { project: true },
    });
    await recalcMemberStats(data.assigneeId ?? null);
    // L-P2-29 — emit MENTION notifications for any @Name in the description.
    if (data.description) {
      await notifyMentionedUsers({
        text: data.description,
        actorUserId: auth.userId,
        actorName: auth.name,
        entityType: "TASK",
        entityLabel: task.title,
        detail: `in ${task.project?.name ?? "a task"}`,
      });
    }
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
  });
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
  estimateMinutes: number;
}>): Promise<ActionResult<void>> {
  return toResult(async () => {
    // task:edit:any allows editing any task; otherwise the task must be
    // assigned to the requesting user (ownership enforced below).
    const auth = await requirePermission("task:edit:own");
    const existing = await db.task.findUnique({ where: { id } });
    if (!existing) return;
    await assertTaskEditPermission(auth, existing);
    const input = parseOrThrow(updateTaskSchema, raw);
    // ---------------------------------------------------------------------
    // Project association rule (updates):
    //   • a task can never be moved OFF its project (projectId null rejected)
    //   • a new project must exist + be in the caller's scope
    //   • the FINAL assignee must be associated with the FINAL project
    //     (only re-validated when the assignee or the project actually
    //     changes, so legacy rows keep saving until they are touched)
    // ---------------------------------------------------------------------
    if (input.projectId === null) {
      throw new AuthorizationError("Tasks must belong to a project — pick another project instead of removing it.");
    }
    const projectChanged =
      input.projectId !== undefined && input.projectId !== existing.projectId;
    if (projectChanged && input.projectId) {
      // P1 (edge-case audit) — if the caller is moving the task to a new
      // project, scope the new projectId against the caller's visible projects
      // (same rule as createTask). Prevents a MEMBER from moving their task
      // into a project they can't see (data injection + mention phishing).
      const scopedIds = await getScopedProjectIds(auth);
      if (scopedIds && !scopedIds.has(input.projectId)) {
        throw new AuthorizationError("You can only move tasks to projects you have access to.");
      }
      if ((await getProjectAssociatedUserIds(input.projectId)) === null) {
        throw new AuthorizationError("Project not found.");
      }
    }
    const finalProjectId = projectChanged ? input.projectId! : existing.projectId;
    const finalAssigneeId = input.assigneeId !== undefined ? input.assigneeId : existing.assigneeId;
    const assigneeChanged =
      input.assigneeId !== undefined && input.assigneeId !== existing.assigneeId;
    if (finalAssigneeId && (assigneeChanged || projectChanged)) {
      if (!finalProjectId) {
        throw new AuthorizationError(
          "Assign this task to a project before assigning a user to it.",
        );
      }
      await assertTeamMemberAssociatedWithProject(finalAssigneeId, finalProjectId);
    }
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
        estimateMinutes: input.estimateMinutes,
      },
    });
    await recalcMemberStats(existing.assigneeId);
    if (input.assigneeId && input.assigneeId !== existing.assigneeId) {
      await recalcMemberStats(input.assigneeId);
    }
    // L-P2-29 — emit MENTION notifications for any @Name in the description.
    // Only fires when the description actually changed.
    if (input.description !== undefined && input.description !== existing.description) {
      await notifyMentionedUsers({
        text: input.description,
        actorUserId: auth.userId,
        actorName: auth.name,
        entityType: "TASK",
        entityLabel: input.title ?? existing.title,
        detail: "updated a task description",
      });
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
    if (input.estimateMinutes !== undefined && input.estimateMinutes !== existing.estimateMinutes) changes.push("estimate");
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
  });
}

export async function moveTask(id: string, newStatus: string, newOrder: number): Promise<ActionResult<void>> {
  return toResult(async () => {
    const auth = await requirePermission("task:edit:own");
    // Deep-dive review F-10 — status/order were previously written without
    // any validation (arbitrary strings / NaN orders polluted the board).
    const move = parseOrThrow(moveTaskSchema, { status: newStatus, order: newOrder });
    const task = await db.task.findUnique({ where: { id } });
    if (!task) return;
    await assertTaskEditPermission(auth, task);
    const oldAssignee = task.assigneeId;
    await db.task.update({
      where: { id },
      data: { status: move.status, order: move.order },
    });
    await recalcMemberStats(oldAssignee);
    if (task.status !== move.status) {
      await logAudit({
        actor: auth,
        action: "task.moved",
        entityType: "TASK",
        entityId: id,
        entityLabel: task.title,
        detail: `Moved “${task.title}” to ${TASK_STATUS_LABELS[move.status as keyof typeof TASK_STATUS_LABELS] ?? move.status}`,
      });
    }
    revalidatePath("/");
  });
}

export async function deleteTask(id: string): Promise<ActionResult<void>> {
  return toResult(async () => {
    // PR-61 — row-level delete rights (see assertTaskDeletePermission):
    // ADMIN (any), the assigned user (own task), the project owner, or a
    // MANAGER whose reporting chain covers the assignee / project owner.
    // The blanket `task:delete` RBAC grant stays ADMIN-only; everyone else
    // passes through the row-level checks below.
    const auth = await getSessionOrThrow();
    const task = await db.task.findUnique({ where: { id } });
    // Deep-dive review F-15 — not-found is a clean no-op, not a P2025
    // INTERNAL error from Prisma.
    if (!task) return;
    await assertTaskDeletePermission(auth, task);
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
  });
}
