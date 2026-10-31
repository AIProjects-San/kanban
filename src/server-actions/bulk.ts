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
import { bulkTaskPatchSchema, parseOrThrow } from "@/lib/validation";
import { hasPermission } from "@/lib/rbac";
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
  rawPatch: BulkTaskPatch,
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
    // Deep-dive review F-10 — the patch (status/assigneeId) previously
    // reached Prisma unvalidated, so arbitrary status strings could be
    // bulk-written into the board.
    const patch = parseOrThrow(bulkTaskPatchSchema, rawPatch);
    if (patch.status === undefined && patch.assigneeId === undefined) {
      throw new AuthorizationError("Nothing to update — provide a status or assignee.");
    }

    const tasks = await db.task.findMany({
      where: { id: { in: taskIds }, project: { deletedAt: null } },
      include: { assignee: { select: { userId: true } } },
    });

    // Permission filter: keep only tasks the caller may edit.
    const canEditAny = hasPermission(auth.role, "task:edit:any");
    const permitted = tasks.filter((t) => {
      if (canEditAny) return true;
      return t.assignee?.userId === auth.userId;
    });

    // P0 (production-readiness re-audit) — the prior implementation ran a
    // separate `db.task.update` per task in a loop with no $transaction, so
    // a DB blip mid-loop left the workspace partially updated (some tasks
    // moved, others not) with no rollback. Since every task receives the
    // SAME patch, we now do one atomic updateMany inside a $transaction.
    const data: Record<string, unknown> = {};
    if (patch.status !== undefined) data.status = patch.status;
    if (patch.assigneeId !== undefined) data.assigneeId = patch.assigneeId || null;

    // Track affected assignees BEFORE the bulk update so workload counters
    // get recalculated for both the old and new assignee of every task.
    const affectedAssignees = new Set<string>();
    for (const task of permitted) {
      if (task.assigneeId) affectedAssignees.add(task.assigneeId);
      if (patch.assigneeId) affectedAssignees.add(patch.assigneeId);
    }

    // One atomic UPDATE — either all permitted tasks move or none do.
    // Skip the transaction entirely when nothing is permitted (calling
    // $transaction([]) is a TypeScript error and a no-op anyway).
    let updated = 0;
    if (permitted.length > 0) {
      const result = await db.$transaction([
        db.task.updateMany({
          where: { id: { in: permitted.map((t) => t.id) } },
          data,
        }),
      ]);
      updated = result[0]?.count ?? 0;
    }

    // Recalculate workload counters for every affected assignee (outside the
    // tx — recalcMemberStats does its own reads + writes).
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
