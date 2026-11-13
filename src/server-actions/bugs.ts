"use server";

// ---------------------------------------------------------------------------
// Bug Tracking — QA engineers raise bugs; developers work them through a
// full lifecycle (New → Triaged → In Progress → In Review → Resolved →
// Closed, with Reopened). Every mutating action is audited; comments
// support discussion; the lifecycle is enforced via BUG_STATUS_TRANSITIONS.
//
// RBAC:
//   bug:create      — all signed-in users (QA + devs + anyone)
//   bug:edit:own    — reporter + assignee can edit their own bugs
//   bug:edit:any    — MANAGER+ can edit any bug
//   bug:assign      — MANAGER+ can reassign bugs
//   bug:delete      — ADMIN only
// ---------------------------------------------------------------------------

import { revalidatePath } from "next/cache";
import { db } from "@/lib/infra/db";
import { requirePermission, checkPermission, AuthorizationError, getSessionOrThrow } from "./auth-guard";
import { type Role } from "@/lib/auth/rbac";
import {
  BUG_STATUS_LABELS,
  BUG_STATUS_TRANSITIONS,
  BUG_SEVERITY_LABELS,
  BUG_PRIORITY_LABELS,
  BUG_RESOLUTION_LABELS,
} from "@/lib/shared/config";
import type { BugPriority, BugResolution, BugSeverity, BugStatus } from "@/lib/types";
import {
  createBugSchema,
  updateBugSchema,
  changeBugStatusSchema,
  createBugCommentSchema,
  moveBugSchema,
  linkBugTaskSchema,
  parseOrThrow,
} from "@/lib/validation";
import { logAudit, getScopedProjectIds, assertUserAssociatedWithProject, getProjectAssociatedUserIds } from "./shared";
import { toResult } from "./result";
import type { ActionResult } from "@/lib/shared/action-result";
import { safeCursor, pageOf } from "@/lib/shared/pagination";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Assert the caller may edit this bug. Reporters can edit their own bugs;
 * assignees can edit bugs assigned to them; anyone with bug:edit:any can
 * edit any bug. Mirrors the assertTaskEditPermission pattern.
 */
async function assertBugEditPermission(
  auth: { userId: string; role: Role },
  bug: { reporterUserId: string; assigneeUserId: string | null },
) {
  if (await checkPermission(auth.role, "bug:edit:any")) return;
  if (bug.reporterUserId === auth.userId) return;
  if (bug.assigneeUserId === auth.userId) return;
  throw new AuthorizationError("You can only edit bugs you reported or are assigned to.");
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export async function createBug(input: {
  title: string;
  description?: string;
  stepsToReproduce?: string;
  expectedBehavior?: string;
  actualBehavior?: string;
  severity?: string;
  priority?: string;
  projectId?: string | null;
  taskId?: string | null;
  environment?: string;
}): Promise<ActionResult<{ id: string }>> {
  return toResult(async () => {
    const auth = await requirePermission("bug:create");
    const data = parseOrThrow(createBugSchema, input);

    // Project association rule — every bug belongs to a project, and its
    // assignee (set later via assignBug) must be a user associated with
    // that project. The project must exist and not be soft-deleted.
    if (!data.projectId) {
      throw new AuthorizationError("Bug must be assigned to a project.");
    }
    if ((await getProjectAssociatedUserIds(data.projectId)) === null) {
      throw new AuthorizationError("Project not found.");
    }
    // A linked task must belong to the SAME project — otherwise the
    // traceability link crosses project boundaries and the assignee rule
    // becomes ambiguous.
    if (data.taskId) {
      const task = await db.task.findUnique({
        where: { id: data.taskId },
        select: { projectId: true },
      });
      if (!task) throw new AuthorizationError("Task not found.");
      if (task.projectId !== data.projectId) {
        throw new AuthorizationError("The linked task belongs to a different project.");
      }
    }

    const bug = await db.bug.create({
      data: {
        title: data.title,
        description: data.description ?? "",
        stepsToReproduce: data.stepsToReproduce ?? "",
        expectedBehavior: data.expectedBehavior ?? "",
        actualBehavior: data.actualBehavior ?? "",
        severity: data.severity ?? "MAJOR",
        priority: data.priority ?? "P2",
        status: "NEW",
        reporterUserId: auth.userId,
        projectId: data.projectId,
        taskId: data.taskId ?? null,
        environment: data.environment ?? "",
      },
    });

    await logAudit({
      actor: auth,
      action: "bug.created",
      entityType: "BUG",
      entityId: bug.id,
      entityLabel: bug.title,
      detail: `Bug “${bug.title}” raised (${BUG_SEVERITY_LABELS[bug.severity as BugSeverity] ?? bug.severity}, ${BUG_PRIORITY_LABELS[bug.priority as BugPriority] ?? bug.priority})`,
    });
    revalidatePath("/");
    return { id: bug.id };
  });
}

// ---------------------------------------------------------------------------
// Read — single bug (with comments + linked task)
// ---------------------------------------------------------------------------

export async function getBug(id: string): Promise<ActionResult<{
  id: string;
  title: string;
  description: string;
  stepsToReproduce: string;
  expectedBehavior: string;
  actualBehavior: string;
  severity: string;
  priority: string;
  status: string;
  resolution: string | null;
  reporterUserId: string;
  reporterName: string | null;
  assigneeUserId: string | null;
  assigneeName: string | null;
  projectId: string | null;
  projectName: string | null;
  taskId: string | null;
  taskTitle: string | null;
  environment: string;
  createdAt: string;
  updatedAt: string;
  triagedAt: string | null;
  resolvedAt: string | null;
  closedAt: string | null;
  comments: Array<{
    id: string;
    authorId: string;
    authorName: string;
    body: string;
    createdAt: string;
  }>;
}>> {
  return toResult(async () => {
    await getSessionOrThrow();

    const bug = await db.bug.findUnique({
      where: { id },
      include: {
        comments: { orderBy: { createdAt: "asc" } },
        task: { select: { id: true, title: true } },
      },
    });
    if (!bug) throw new AuthorizationError("Bug not found.");

    // Resolve reporter + assignee names (separate lookups to avoid N+1).
    const userIds = [bug.reporterUserId, bug.assigneeUserId].filter(Boolean) as string[];
    const users = userIds.length > 0
      ? await db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } })
      : [];
    const userMap = new Map(users.map((u) => [u.id, u.name]));
    const project = bug.projectId
      ? await db.project.findUnique({ where: { id: bug.projectId }, select: { name: true } })
      : null;

    return {
      id: bug.id,
      title: bug.title,
      description: bug.description,
      stepsToReproduce: bug.stepsToReproduce,
      expectedBehavior: bug.expectedBehavior,
      actualBehavior: bug.actualBehavior,
      severity: bug.severity,
      priority: bug.priority,
      status: bug.status,
      resolution: bug.resolution,
      reporterUserId: bug.reporterUserId,
      reporterName: bug.reporterUserId ? userMap.get(bug.reporterUserId) ?? null : null,
      assigneeUserId: bug.assigneeUserId,
      assigneeName: bug.assigneeUserId ? userMap.get(bug.assigneeUserId) ?? null : null,
      projectId: bug.projectId,
      projectName: project?.name ?? null,
      taskId: bug.taskId,
      taskTitle: bug.task?.title ?? null,
      environment: bug.environment,
      createdAt: bug.createdAt.toISOString(),
      updatedAt: bug.updatedAt.toISOString(),
      triagedAt: bug.triagedAt?.toISOString() ?? null,
      resolvedAt: bug.resolvedAt?.toISOString() ?? null,
      closedAt: bug.closedAt?.toISOString() ?? null,
      comments: bug.comments.map((c) => ({
        id: c.id,
        authorId: c.authorId,
        authorName: c.authorName,
        body: c.body,
        createdAt: c.createdAt.toISOString(),
      })),
    };
  });
}

// ---------------------------------------------------------------------------
// Read — paginated list with filters
// ---------------------------------------------------------------------------

export async function getBugsPage(input?: {
  cursor?: string;
  limit?: number;
  search?: string;
  status?: string;
  severity?: string;
  priority?: string;
  assigneeUserId?: string;
  reporterUserId?: string;
  projectId?: string;
}): Promise<ActionResult<{
  items: Array<{
    id: string;
    title: string;
    severity: string;
    priority: string;
    status: string;
    reporterName: string | null;
    assigneeName: string | null;
    projectName: string | null;
    createdAt: string;
    updatedAt: string;
  }>;
  nextCursor: string | null;
  hasMore: boolean;
}>> {
  return toResult(async () => {
    await getSessionOrThrow();

    const limit = Math.min(Math.max(input?.limit ?? 50, 1), 200);
    const search = input?.search?.trim() ?? "";

    // Build the where clause from filters.
    const where: Record<string, unknown> = {};
    if (search) {
      where.OR = [
        { title: { contains: search, mode: "insensitive" } },
        { description: { contains: search, mode: "insensitive" } },
      ];
    }
    if (input?.status) where.status = input.status;
    if (input?.severity) where.severity = input.severity;
    if (input?.priority) where.priority = input.priority;
    if (input?.assigneeUserId) where.assigneeUserId = input.assigneeUserId;
    if (input?.reporterUserId) where.reporterUserId = input.reporterUserId;
    if (input?.projectId) where.projectId = input.projectId;

    // Cursor (validate format to avoid P2015).
    const cursor = safeCursor(input?.cursor);

    const rows = await db.bug.findMany({
      where,
      orderBy: { createdAt: "desc" },
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      take: limit + 1,
      select: {
        id: true, title: true, severity: true, priority: true, status: true,
        reporterUserId: true, assigneeUserId: true, projectId: true,
        createdAt: true, updatedAt: true,
      },
    });

    const { items, hasMore } = pageOf(rows, limit);

    // Resolve names in bulk (reporter + assignee + project).
    const userIds = new Set<string>();
    const projectIds = new Set<string>();
    for (const r of items) {
      if (r.reporterUserId) userIds.add(r.reporterUserId);
      if (r.assigneeUserId) userIds.add(r.assigneeUserId);
      if (r.projectId) projectIds.add(r.projectId);
    }
    const [users, projects] = await Promise.all([
      userIds.size > 0
        ? db.user.findMany({ where: { id: { in: Array.from(userIds) } }, select: { id: true, name: true } })
        : Promise.resolve([]),
      projectIds.size > 0
        ? db.project.findMany({ where: { id: { in: Array.from(projectIds) } }, select: { id: true, name: true } })
        : Promise.resolve([]),
    ]);
    const userMap = new Map(users.map((u) => [u.id, u.name]));
    const projectMap = new Map(projects.map((p) => [p.id, p.name]));

    const nextCursor = hasMore && items.length > 0 ? items[items.length - 1].id : null;

    return {
      items: items.map((r) => ({
        id: r.id,
        title: r.title,
        severity: r.severity,
        priority: r.priority,
        status: r.status,
        reporterName: r.reporterUserId ? userMap.get(r.reporterUserId) ?? null : null,
        assigneeName: r.assigneeUserId ? userMap.get(r.assigneeUserId) ?? null : null,
        projectName: r.projectId ? projectMap.get(r.projectId) ?? null : null,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      })),
      nextCursor,
      hasMore,
    };
  });
}

// ---------------------------------------------------------------------------
// Update — patch bug fields (title, description, severity, etc.)
// ---------------------------------------------------------------------------

export async function updateBug(id: string, raw: Partial<{
  title: string;
  description: string;
  stepsToReproduce: string;
  expectedBehavior: string;
  actualBehavior: string;
  severity: string;
  priority: string;
  environment: string;
  projectId: string | null;
}>): Promise<ActionResult<void>> {
  return toResult(async () => {
    const auth = await requirePermission("bug:edit:own");
    const existing = await db.bug.findUnique({ where: { id } });
    if (!existing) throw new AuthorizationError("Bug not found.");
    await assertBugEditPermission(auth, existing);

    const input = parseOrThrow(updateBugSchema, raw);
    // Project association rule — a bug can never be moved OFF its project,
    // a new project must exist, and the current assignee (if any) must be
    // associated with the project the bug ends up in.
    if (input.projectId === null) {
      throw new AuthorizationError("Bugs must belong to a project — pick another project instead of removing it.");
    }
    const projectChanged =
      input.projectId !== undefined && input.projectId !== existing.projectId;
    if (projectChanged && input.projectId) {
      if ((await getProjectAssociatedUserIds(input.projectId)) === null) {
        throw new AuthorizationError("Project not found.");
      }
      if (existing.assigneeUserId) {
        await assertUserAssociatedWithProject(existing.assigneeUserId, input.projectId);
      }
      if (existing.taskId) {
        const task = await db.task.findUnique({
          where: { id: existing.taskId },
          select: { projectId: true },
        });
        if (task && task.projectId !== input.projectId) {
          throw new AuthorizationError(
            "The bug's linked task belongs to a different project. Unlink it first.",
          );
        }
      }
    }
    const data: Record<string, unknown> = {};
    if (input.title !== undefined) data.title = input.title;
    if (input.description !== undefined) data.description = input.description;
    if (input.stepsToReproduce !== undefined) data.stepsToReproduce = input.stepsToReproduce;
    if (input.expectedBehavior !== undefined) data.expectedBehavior = input.expectedBehavior;
    if (input.actualBehavior !== undefined) data.actualBehavior = input.actualBehavior;
    if (input.severity !== undefined) data.severity = input.severity;
    if (input.priority !== undefined) data.priority = input.priority;
    if (input.environment !== undefined) data.environment = input.environment;
    if (projectChanged) data.projectId = input.projectId;

    await db.bug.update({ where: { id }, data });

    const changes: string[] = [];
    if (input.title !== undefined && input.title !== existing.title) changes.push("title");
    if (input.severity !== undefined && input.severity !== existing.severity) changes.push("severity");
    if (input.priority !== undefined && input.priority !== existing.priority) changes.push("priority");
    if (input.description !== undefined && input.description !== existing.description) changes.push("description");
    if (projectChanged) changes.push("project");

    await logAudit({
      actor: auth,
      action: "bug.updated",
      entityType: "BUG",
      entityId: id,
      entityLabel: existing.title,
      detail: changes.length > 0 ? `Updated bug (${changes.join(", ")})` : "Updated bug",
    });
    revalidatePath("/");
  });
}

// ---------------------------------------------------------------------------
// Assign — set the developer who will work the bug
// ---------------------------------------------------------------------------

export async function assignBug(id: string, assigneeUserId: string | null): Promise<ActionResult<void>> {
  return toResult(async () => {
    const auth = await requirePermission("bug:assign");
    const existing = await db.bug.findUnique({ where: { id } });
    if (!existing) throw new AuthorizationError("Bug not found.");

    // Verify the assignee exists + is not soft-deleted.
    let assigneeName: string | null = null;
    if (assigneeUserId) {
      const user = await db.user.findUnique({
        where: { id: assigneeUserId, deletedAt: null },
        select: { name: true },
      });
      if (!user) throw new AuthorizationError("Assignee not found.");
      assigneeName = user.name;
      // Project association rule — the assignee must be associated with the
      // bug's project (explicit ProjectAssignment or ownership). Legacy
      // bugs without a project must be given one before assignment.
      if (!existing.projectId) {
        throw new AuthorizationError(
          "Assign this bug to a project first — assignees must be associated with the bug's project.",
        );
      }
      await assertUserAssociatedWithProject(assigneeUserId, existing.projectId);
    }

    await db.bug.update({
      where: { id },
      data: { assigneeUserId },
    });

    await logAudit({
      actor: auth,
      action: "bug.assigned",
      entityType: "BUG",
      entityId: id,
      entityLabel: existing.title,
      detail: assigneeUserId
        ? `Assigned bug to ${assigneeName}`
        : "Unassigned bug",
    });
    revalidatePath("/");
  });
}

// ---------------------------------------------------------------------------
// Change status — lifecycle transition with guard
// ---------------------------------------------------------------------------

export async function changeBugStatus(
  id: string,
  input: { status: string; resolution?: string; comment?: string },
): Promise<ActionResult<void>> {
  return toResult(async () => {
    const auth = await requirePermission("bug:edit:own");
    const existing = await db.bug.findUnique({ where: { id } });
    if (!existing) throw new AuthorizationError("Bug not found.");
    await assertBugEditPermission(auth, existing);

    const data = parseOrThrow(changeBugStatusSchema, input);
    const newStatus = data.status as BugStatus;
    const currentStatus = existing.status as BugStatus;

    // Enforce the lifecycle transition map.
    const allowed = BUG_STATUS_TRANSITIONS[currentStatus] ?? [];
    if (!allowed.includes(newStatus)) {
      throw new AuthorizationError(
        `Cannot transition from ${BUG_STATUS_LABELS[currentStatus] ?? currentStatus} to ${BUG_STATUS_LABELS[newStatus] ?? newStatus}. Allowed: ${allowed.map((s) => BUG_STATUS_LABELS[s] ?? s).join(", ")}.`,
      );
    }

    // Resolution is required when moving to RESOLVED; clear it otherwise.
    const resolution = newStatus === "RESOLVED" ? (data.resolution ?? "FIXED") : null;

    // Timestamps: triagedAt set on first TRIAGED, resolvedAt on RESOLVED, closedAt on CLOSED.
    const now = new Date();
    const patch: Record<string, unknown> = {
      status: newStatus,
      resolution,
    };
    if (newStatus === "TRIAGED" && !existing.triagedAt) patch.triagedAt = now;
    if (newStatus === "RESOLVED") patch.resolvedAt = now;
    if (newStatus === "CLOSED" && !existing.closedAt) patch.closedAt = now;
    // REOPENED clears resolvedAt/closedAt (the bug is active again).
    if (newStatus === "REOPENED") {
      patch.resolvedAt = null;
      patch.closedAt = null;
    }

    // PR-15 (production-readiness audit) — the status change and its comment
    // are one logical write. Previously a crash between the bug.update and the
    // bugComment.create left the transition without its narrative (the comment
    // is the audit trail reviewers see inline). Both writes now commit (or
    // roll back) together.
    await db.$transaction(async (tx) => {
      await tx.bug.update({ where: { id }, data: patch });
      // Optional comment alongside the status change.
      if (data.comment && data.comment.trim().length > 0) {
        await tx.bugComment.create({
          data: {
            bugId: id,
            authorId: auth.userId,
            authorName: auth.name,
            body: data.comment.trim(),
          },
        });
      }
    });

    // Audit with the right action for the transition.
    const action =
      newStatus === "RESOLVED" ? "bug.resolved" :
      newStatus === "CLOSED" ? "bug.closed" :
      newStatus === "REOPENED" ? "bug.reopened" :
      "bug.status_changed";
    const detail =
      newStatus === "RESOLVED"
        ? `Resolved as ${resolution ? BUG_RESOLUTION_LABELS[resolution as BugResolution] ?? resolution : "FIXED"}`
        : newStatus === "CLOSED"
          ? `Closed${resolution ? ` (${BUG_RESOLUTION_LABELS[resolution as BugResolution] ?? resolution})` : ""}`
          : newStatus === "REOPENED"
            ? "Reopened"
            : `Status: ${BUG_STATUS_LABELS[currentStatus] ?? currentStatus} → ${BUG_STATUS_LABELS[newStatus] ?? newStatus}`;

    await logAudit({
      actor: auth,
      action,
      entityType: "BUG",
      entityId: id,
      entityLabel: existing.title,
      detail,
    });
    revalidatePath("/");
  });
}

// ---------------------------------------------------------------------------
// Comment — add a discussion comment
// ---------------------------------------------------------------------------

export async function addBugComment(input: {
  bugId: string;
  body: string;
}): Promise<ActionResult<{ id: string }>> {
  return toResult(async () => {
    const auth = await getSessionOrThrow();
    const data = parseOrThrow(createBugCommentSchema, input);

    const bug = await db.bug.findUnique({ where: { id: data.bugId }, select: { title: true } });
    if (!bug) throw new AuthorizationError("Bug not found.");

    const comment = await db.bugComment.create({
      data: {
        bugId: data.bugId,
        authorId: auth.userId,
        authorName: auth.name,
        body: data.body,
      },
    });

    await logAudit({
      actor: auth,
      action: "bug.commented",
      entityType: "BUG",
      entityId: data.bugId,
      entityLabel: bug.title,
      detail: `Commented on bug “${bug.title}”`,
    });
    revalidatePath("/");
    return { id: comment.id };
  });
}

// ---------------------------------------------------------------------------
// Delete — ADMIN only
// ---------------------------------------------------------------------------

export async function deleteBug(id: string): Promise<ActionResult<void>> {
  return toResult(async () => {
    const auth = await requirePermission("bug:delete");
    const existing = await db.bug.findUnique({ where: { id }, select: { title: true } });
    if (!existing) throw new AuthorizationError("Bug not found.");

    await db.bug.delete({ where: { id } });

    await logAudit({
      actor: auth,
      action: "bug.deleted",
      entityType: "BUG",
      entityId: id,
      entityLabel: existing.title,
      detail: `Deleted bug “${existing.title}”`,
    });
    revalidatePath("/");
  });
}

// ---------------------------------------------------------------------------
// Board enhancement — drag-and-drop move on the bug board.
//
// Same lifecycle guard as changeBugStatus (BUG_STATUS_TRANSITIONS), plus the
// boardOrder write so the card keeps its dropped position inside the column.
// A drag that keeps the status but changes the order is a pure reorder and is
// always allowed.
// ---------------------------------------------------------------------------

export async function moveBug(
  id: string,
  raw: { status: string; order: number; resolution?: string },
): Promise<ActionResult<void>> {
  return toResult(async () => {
    const auth = await requirePermission("bug:edit:own");
    const existing = await db.bug.findUnique({ where: { id } });
    if (!existing) throw new AuthorizationError("Bug not found.");
    await assertBugEditPermission(auth, existing);

    const data = parseOrThrow(moveBugSchema, raw);
    const newStatus = data.status as BugStatus;
    const currentStatus = existing.status as BugStatus;

    // Enforce the lifecycle transition map — same rule as changeBugStatus, so
    // dragging can't bypass the state machine. Reorders within the same
    // column (status unchanged) skip the check.
    if (newStatus !== currentStatus) {
      const allowed = BUG_STATUS_TRANSITIONS[currentStatus] ?? [];
      if (!allowed.includes(newStatus)) {
        throw new AuthorizationError(
          `Cannot drag from ${BUG_STATUS_LABELS[currentStatus] ?? currentStatus} to ${BUG_STATUS_LABELS[newStatus] ?? newStatus}. Allowed: ${allowed.map((s) => BUG_STATUS_LABELS[s] ?? s).join(", ")}.`,
        );
      }
    }

    // Resolution is required when moving to RESOLVED; cleared otherwise.
    const resolution = newStatus === "RESOLVED" ? (data.resolution ?? existing.resolution ?? "FIXED") : null;

    // Timestamps: triagedAt on first TRIAGED, resolvedAt on RESOLVED,
    // closedAt on CLOSED; REOPENED clears them (the bug is active again).
    const now = new Date();
    const patch: Record<string, unknown> = {
      status: newStatus,
      boardOrder: data.order,
      resolution,
    };
    if (newStatus === "TRIAGED" && !existing.triagedAt) patch.triagedAt = now;
    if (newStatus === "RESOLVED") patch.resolvedAt = now;
    if (newStatus === "CLOSED" && !existing.closedAt) patch.closedAt = now;
    if (newStatus === "REOPENED") {
      patch.resolvedAt = null;
      patch.closedAt = null;
    }

    await db.bug.update({ where: { id }, data: patch });

    // Audit: pure reorder → bug.moved; status change → the same specific
    // actions changeBugStatus emits, so the bug's timeline stays uniform.
    if (newStatus === currentStatus) {
      await logAudit({
        actor: auth,
        action: "bug.moved",
        entityType: "BUG",
        entityId: id,
        entityLabel: existing.title,
        detail: `Reordered “${existing.title}” within ${BUG_STATUS_LABELS[currentStatus] ?? currentStatus}`,
      });
    } else {
      const action =
        newStatus === "RESOLVED" ? "bug.resolved" :
        newStatus === "CLOSED" ? "bug.closed" :
        newStatus === "REOPENED" ? "bug.reopened" :
        "bug.status_changed";
      const detail =
        newStatus === "RESOLVED"
          ? `Resolved as ${BUG_RESOLUTION_LABELS[resolution as BugResolution] ?? resolution} (board move)`
          : `Dragged from ${BUG_STATUS_LABELS[currentStatus] ?? currentStatus} to ${BUG_STATUS_LABELS[newStatus] ?? newStatus}`;
      await logAudit({
        actor: auth,
        action,
        entityType: "BUG",
        entityId: id,
        entityLabel: existing.title,
        detail,
      });
    }
    revalidatePath("/");
  });
}

// ---------------------------------------------------------------------------
// Board enhancement — Task ↔ Bug linking.
//
// The link lives on Bug.taskId. Only users who can edit the bug may change
// the link (reporter / assignee / bug:edit:any). The target task must exist
// and be visible to the linker (scoped roles can only link tasks they can
// see — same visibility rule as the dashboard task loader).
// ---------------------------------------------------------------------------

export async function linkBugToTask(
  bugId: string,
  raw: { taskId: string | null },
): Promise<ActionResult<void>> {
  return toResult(async () => {
    const auth = await requirePermission("bug:edit:own");
    const bug = await db.bug.findUnique({ where: { id: bugId } });
    if (!bug) throw new AuthorizationError("Bug not found.");
    await assertBugEditPermission(auth, bug);

    const data = parseOrThrow(linkBugTaskSchema, raw);

    // Resolve + scope-check the target task (null = unlink).
    let taskTitle: string | null = null;
    if (data.taskId) {
      const task = await db.task.findUnique({
        where: { id: data.taskId },
        include: { assignee: { select: { userId: true } } },
      });
      if (!task) throw new AuthorizationError("Task not found.");
      // Project association rule — the linked task must belong to the SAME
      // project as the bug, so the traceability link stays inside one
      // project's boundary.
      if (!bug.projectId) {
        throw new AuthorizationError(
          "Assign the bug to a project before linking a task.",
        );
      }
      if (task.projectId !== bug.projectId) {
        throw new AuthorizationError("The task belongs to a different project.");
      }
      const scopedIds = await getScopedProjectIds(auth);
      if (
        scopedIds &&
        !(task.projectId && scopedIds.has(task.projectId)) &&
        task.assignee?.userId !== auth.userId
      ) {
        throw new AuthorizationError("You can only link bugs to tasks you have access to.");
      }
      taskTitle = task.title;
    }

    await db.bug.update({ where: { id: bugId }, data: { taskId: data.taskId } });

    await logAudit({
      actor: auth,
      action: data.taskId ? "bug.linked" : "bug.unlinked",
      entityType: "BUG",
      entityId: bugId,
      entityLabel: bug.title,
      detail: data.taskId
        ? `Linked bug “${bug.title}” to task “${taskTitle}”`
        : `Unlinked bug “${bug.title}” from its task`,
    });
    revalidatePath("/");
  });
}

// ---------------------------------------------------------------------------
// Board enhancement — bug board data (one round trip, names resolved in
// bulk). Same visibility rule as getBugsPage: every signed-in user sees the
// board (bug lists are workspace-wide by design).
// ---------------------------------------------------------------------------

export async function getBugBoard(): Promise<ActionResult<{
  items: Array<{
    id: string;
    title: string;
    severity: string;
    priority: string;
    status: string;
    order: number;
    resolution: string | null;
    reporterUserId: string;
    reporterName: string | null;
    assigneeUserId: string | null;
    assigneeName: string | null;
    projectId: string | null;
    projectName: string | null;
    taskId: string | null;
    taskTitle: string | null;
    createdAt: string;
    updatedAt: string;
  }>;
}>> {
  return toResult(async () => {
    await getSessionOrThrow();

    const rows = await db.bug.findMany({
      orderBy: [{ boardOrder: "asc" }, { createdAt: "desc" }],
      take: 500,
      select: {
        id: true, title: true, severity: true, priority: true, status: true,
        boardOrder: true, resolution: true,
        reporterUserId: true, assigneeUserId: true,
        projectId: true, taskId: true,
        createdAt: true, updatedAt: true,
      },
    });

    // Bulk-resolve reporter + assignee names, project names, task titles.
    const userIds = new Set<string>();
    const projectIds = new Set<string>();
    const taskIds = new Set<string>();
    for (const r of rows) {
      if (r.reporterUserId) userIds.add(r.reporterUserId);
      if (r.assigneeUserId) userIds.add(r.assigneeUserId);
      if (r.projectId) projectIds.add(r.projectId);
      if (r.taskId) taskIds.add(r.taskId);
    }
    const [users, projects, tasks] = await Promise.all([
      userIds.size > 0
        ? db.user.findMany({ where: { id: { in: Array.from(userIds) } }, select: { id: true, name: true } })
        : Promise.resolve([]),
      projectIds.size > 0
        ? db.project.findMany({ where: { id: { in: Array.from(projectIds) } }, select: { id: true, name: true } })
        : Promise.resolve([]),
      taskIds.size > 0
        ? db.task.findMany({ where: { id: { in: Array.from(taskIds) } }, select: { id: true, title: true } })
        : Promise.resolve([]),
    ]);
    const userMap = new Map(users.map((u) => [u.id, u.name]));
    const projectMap = new Map(projects.map((p) => [p.id, p.name]));
    const taskMap = new Map(tasks.map((t) => [t.id, t.title]));

    return {
      items: rows.map((r) => ({
        id: r.id,
        title: r.title,
        severity: r.severity,
        priority: r.priority,
        status: r.status,
        order: r.boardOrder,
        resolution: r.resolution,
        reporterUserId: r.reporterUserId,
        reporterName: r.reporterUserId ? userMap.get(r.reporterUserId) ?? null : null,
        assigneeUserId: r.assigneeUserId,
        assigneeName: r.assigneeUserId ? userMap.get(r.assigneeUserId) ?? null : null,
        projectId: r.projectId,
        projectName: r.projectId ? projectMap.get(r.projectId) ?? null : null,
        taskId: r.taskId,
        taskTitle: r.taskId ? taskMap.get(r.taskId) ?? null : null,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      })),
    };
  });
}

// ---------------------------------------------------------------------------
// Board enhancement — bugs linked to a task (for the task modal) and bugs
// available for linking (for the link picker).
// ---------------------------------------------------------------------------

export async function getTaskLinkedBugs(taskId: string): Promise<ActionResult<
  Array<{
    id: string;
    title: string;
    severity: string;
    priority: string;
    status: string;
    resolution: string | null;
  }>
>> {
  return toResult(async () => {
    await getSessionOrThrow();

    const bugs = await db.bug.findMany({
      where: { taskId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true, title: true, severity: true, priority: true, status: true, resolution: true,
      },
      // PR-21 — hard cap; the per-task bug list renders inline in the modal.
      take: 500,
    });
    return bugs;
  });
}

export async function getLinkableBugs(taskId: string, search?: string): Promise<ActionResult<
  Array<{ id: string; title: string; severity: string; status: string }>
>> {
  return toResult(async () => {
    await getSessionOrThrow();

    // Project association rule — a bug can only be linked to a task in the
    // SAME project (linkBugToTask enforces this server-side too). Resolve
    // the task's project and scope the candidates so the picker never
    // offers a link the server would reject. Tasks without a project
    // (legacy rows) cannot link bugs at all.
    const task = await db.task.findUnique({
      where: { id: taskId },
      select: { projectId: true },
    });
    if (!task || !task.projectId) return [];

    // NOT-linked: either taskId is null, or it points at a different task.
    // (Prisma's `not` excludes NULLs — SQL three-valued logic — so the OR
    // below is what actually includes the unlinked rows.)
    const q = (search ?? "").trim();
    const where: Record<string, unknown> = {
      projectId: task.projectId,
      OR: [{ taskId: null }, { taskId: { not: taskId } }],
    };
    if (q) {
      where.title = { contains: q, mode: "insensitive" };
    }

    const bugs = await db.bug.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      take: 100,
      select: { id: true, title: true, severity: true, status: true },
    });
    return bugs;
  });
}
