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
import { db } from "@/lib/db";
import { getSession, requirePermission, AuthorizationError } from "./auth-guard";
import { hasPermission } from "@/lib/rbac";
import {
  BUG_STATUS_LABELS,
  BUG_STATUS_TRANSITIONS,
  BUG_SEVERITY_LABELS,
  BUG_PRIORITY_LABELS,
  BUG_RESOLUTION_LABELS,
} from "@/lib/config";
import type { BugStatus } from "@/lib/types";
import {
  createBugSchema,
  updateBugSchema,
  changeBugStatusSchema,
  createBugCommentSchema,
  parseOrThrow,
} from "@/lib/validation";
import { logAudit } from "./shared";
import { toResult } from "./result";
import type { ActionResult } from "@/lib/action-result";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Assert the caller may edit this bug. Reporters can edit their own bugs;
 * assignees can edit bugs assigned to them; anyone with bug:edit:any can
 * edit any bug. Mirrors the assertTaskEditPermission pattern.
 */
async function assertBugEditPermission(
  auth: { userId: string; role: string },
  bug: { reporterUserId: string; assigneeUserId: string | null },
) {
  if (hasPermission(auth.role as never, "bug:edit:any")) return;
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
        projectId: data.projectId ?? null,
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
      detail: `Bug “${bug.title}” raised (${BUG_SEVERITY_LABELS[bug.severity as never] ?? bug.severity}, ${BUG_PRIORITY_LABELS[bug.priority as never] ?? bug.priority})`,
    });
    revalidatePath("/");
    return { id: bug.id };
  });
}

// ---------------------------------------------------------------------------
// Read — single bug (with comments)
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
    const auth = await getSession();
    if (!auth) throw new AuthorizationError("You must be signed in.");

    const bug = await db.bug.findUnique({
      where: { id },
      include: {
        comments: { orderBy: { createdAt: "asc" } },
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
    const auth = await getSession();
    if (!auth) throw new AuthorizationError("You must be signed in.");

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
    const rawCursor = input?.cursor?.trim() ?? "";
    const cursor = rawCursor.length >= 20 && rawCursor.length <= 32 && /^[a-z0-9]+$/i.test(rawCursor)
      ? rawCursor
      : null;

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

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;

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
}>): Promise<ActionResult<void>> {
  return toResult(async () => {
    const auth = await requirePermission("bug:edit:own");
    const existing = await db.bug.findUnique({ where: { id } });
    if (!existing) throw new AuthorizationError("Bug not found.");
    await assertBugEditPermission(auth, existing);

    const input = parseOrThrow(updateBugSchema, raw);
    const data: Record<string, unknown> = {};
    if (input.title !== undefined) data.title = input.title;
    if (input.description !== undefined) data.description = input.description;
    if (input.stepsToReproduce !== undefined) data.stepsToReproduce = input.stepsToReproduce;
    if (input.expectedBehavior !== undefined) data.expectedBehavior = input.expectedBehavior;
    if (input.actualBehavior !== undefined) data.actualBehavior = input.actualBehavior;
    if (input.severity !== undefined) data.severity = input.severity;
    if (input.priority !== undefined) data.priority = input.priority;
    if (input.environment !== undefined) data.environment = input.environment;

    await db.bug.update({ where: { id }, data });

    const changes: string[] = [];
    if (input.title !== undefined && input.title !== existing.title) changes.push("title");
    if (input.severity !== undefined && input.severity !== existing.severity) changes.push("severity");
    if (input.priority !== undefined && input.priority !== existing.priority) changes.push("priority");
    if (input.description !== undefined && input.description !== existing.description) changes.push("description");

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

    await db.bug.update({ where: { id }, data: patch });

    // Optional comment alongside the status change.
    if (data.comment && data.comment.trim().length > 0) {
      await db.bugComment.create({
        data: {
          bugId: id,
          authorId: auth.userId,
          authorName: auth.name,
          body: data.comment.trim(),
        },
      });
    }

    // Audit with the right action for the transition.
    const action =
      newStatus === "RESOLVED" ? "bug.resolved" :
      newStatus === "CLOSED" ? "bug.closed" :
      newStatus === "REOPENED" ? "bug.reopened" :
      "bug.status_changed";
    const detail =
      newStatus === "RESOLVED"
        ? `Resolved as ${resolution ? BUG_RESOLUTION_LABELS[resolution as never] ?? resolution : "FIXED"}`
        : newStatus === "CLOSED"
          ? `Closed${resolution ? ` (${BUG_RESOLUTION_LABELS[resolution as never] ?? resolution})` : ""}`
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
    const auth = await getSession();
    if (!auth) throw new AuthorizationError("You must be signed in.");
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
