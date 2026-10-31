"use server";

// ---------------------------------------------------------------------------
// L-P2-31 — Bulk task operations.
//
// The audit (§9.6 L-P2-31) found multi-select was not needed day one but is
// a fast-follow. `bulkUpdateTasks` applies a status / assignee / archive
// patch to many tasks in ONE action call, with the same permission and
// audit semantics as the single-task paths.
//
// The board selection-mode UI is follow-up; this action is the server
// contract it calls.
// ---------------------------------------------------------------------------

import { db } from "@/lib/db";
import { requirePermission, AuthorizationError } from "./auth-guard";
import { logAudit, recalcMemberStats } from "./shared";
import { toResult } from "./result";
import type { ActionResult } from "@/lib/action-result";
import { revalidatePath } from "next/cache";

export interface BulkTaskPatch {
  status?: string;
  assigneeId?: string | null;
}

export interface BulkUpdateResult {
  requested: number;
  updated: number;
  skipped: number;
}

const MAX_BULK = 100;

/**
 * Apply a patch to many tasks at once. Every task is permission-checked
 * individually (task:edit:any bypasses; otherwise the task must be assigned
 * to the caller), so a bulk request containing a mix of own/other tasks
 * updates the permitted subset and skips the rest — the result reports both
 * counts. Tasks belonging to soft-deleted projects are skipped (L-P0-14).
 */
export async function bulkUpdateTasks(
  taskIds: string[],
  patch: BulkTaskPatch,
): Promise<ActionResult<BulkUpdateResult>> {
  return toResult(async () => {
    // task:edit:own is the floor permission; assertTaskEditPermission inside
    // the loop escalates the per-task check (any vs own).
    const auth = await requirePermission("task:edit:own");

    if (!Array.isArray(taskIds) || taskIds.length === 0) {
      throw new AuthorizationError("No tasks selected.");
    }
    if (taskIds.length > MAX_BULK) {
      throw new AuthorizationError(`Bulk updates are capped at ${MAX_BULK} tasks per call.`);
    }
    if (patch.status === undefined && patch.assigneeId === undefined) {
      throw new AuthorizationError("Nothing to update — provide a status or assignee.");
    }

    const tasks = await db.task.findMany({
      where: { id: { in: taskIds }, project: { deletedAt: null } },
      include: { assignee: { select: { userId: true } } },
    });

    // Permission filter: keep only tasks the caller may edit.
    const { hasPermission } = await import("@/lib/rbac");
    const canEditAny = hasPermission(auth.role, "task:edit:any");
    const permitted = tasks.filter((t) => {
      if (canEditAny) return true;
      return t.assignee?.userId === auth.userId;
    });

    let updated = 0;
    const affectedAssignees = new Set<string>();

    for (const task of permitted) {
      const data: Record<string, unknown> = {};
      if (patch.status !== undefined) data.status = patch.status;
      if (patch.assigneeId !== undefined) data.assigneeId = patch.assigneeId || null;
      await db.task.update({ where: { id: task.id }, data });
      updated++;
      if (task.assigneeId) affectedAssignees.add(task.assigneeId);
      if (patch.assigneeId) affectedAssignees.add(patch.assigneeId);
    }

    // Recalculate workload counters for every affected assignee.
    for (const memberId of affectedAssignees) {
      await recalcMemberStats(memberId);
    }

    await logAudit({
      actor: auth,
      action: "task.updated",
      entityType: "TASK",
      detail: `Bulk update: ${updated} task(s) ${patch.status ? `→ ${patch.status}` : ""}${
        patch.assigneeId !== undefined ? (patch.status ? ", " : "") + "assignee changed" : ""
      } (${permitted.length - updated} permitted-but-failed, ${taskIds.length - permitted.length} skipped for permissions)`,
    });

    revalidatePath("/");
    return {
      requested: taskIds.length,
      updated,
      skipped: taskIds.length - updated,
    };
  });
}
