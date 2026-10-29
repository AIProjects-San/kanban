"use server";

// Task CRUD. Every action returns an ActionResult — clients branch on
// `res.ok` instead of try/catching thrown errors across the boundary.

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requirePermission } from "./auth-guard";
import { TASK_STATUS_LABELS } from "@/lib/config";
import { createTaskSchema, updateTaskSchema, parseOrThrow } from "@/lib/validation";
import { logAudit, assertTaskEditPermission, recalcMemberStats } from "./shared";
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
}): Promise<ActionResult<void>> {
  return toResult(async () => {
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
}>): Promise<ActionResult<void>> {
  return toResult(async () => {
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
  });
}

export async function moveTask(id: string, newStatus: string, newOrder: number): Promise<ActionResult<void>> {
  return toResult(async () => {
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
  });
}

export async function deleteTask(id: string): Promise<ActionResult<void>> {
  return toResult(async () => {
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
  });
}
