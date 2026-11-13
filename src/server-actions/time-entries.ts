"use server";

// Time tracking. The member a time entry belongs to is ALWAYS derived from
// the session — a client-supplied memberId would let anyone forge hours for
// a colleague.
//
// Board enhancement — task-level time log (required vs spent):
//   logTaskTime      — log hours against a task (member derived from session)
//   getTaskTimeLog   — estimate + spent aggregate + the entry list
//   deleteTimeEntry  — remove an entry (own entries, or task:edit:any)

import { revalidatePath } from "next/cache";
import { db } from "@/lib/infra/db";
import { getSessionOrThrow, requirePermission, AuthorizationError } from "./auth-guard";
import { hasPermission } from "@/lib/auth/rbac";
import { logAudit, getMyTeamMemberId, getScopedProjectIds, assertTaskEditPermission } from "./shared";
import { findApprovedLeaveOn } from "./hr-shared";
import { logTimeSchema, logTaskTimeSchema, parseOrThrow } from "@/lib/validation";
import { toResult } from "./result";
import type { ActionResult } from "@/lib/shared/action-result";

export async function logTime(raw: {
  projectId: string;
  memberId?: string; // ignored — always derived from the session for integrity
  date: string;
  hours: number;
  description?: string;
}): Promise<ActionResult<void>> {
  return toResult(async () => {
    const auth = await getSessionOrThrow();
    // Deep-dive review F-11 — shape/length/range validation before the write
    // (hours range, bounded description, sanity-checked date string).
    const input = parseOrThrow(logTimeSchema, raw);
    const myMemberId = await getMyTeamMemberId(auth);
    if (!myMemberId) {
      throw new AuthorizationError("You don't have a team member profile to log time against.");
    }
    // HR module time guard (docs/HR_MODULE_PLAN.md §4) — logging hours on a
    // day the user is on APPROVED leave is double-booking; rejected at the
    // write boundary, same philosophy as the project-association rule.
    const leaveOnDay = await findApprovedLeaveOn(auth.userId, new Date(input.date));
    if (leaveOnDay) {
      throw new AuthorizationError(
        `You are on approved ${leaveOnDay.typeName} on ${input.date} — hours cannot be logged for that day.`,
      );
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
  });
}

// ---------------------------------------------------------------------------
// Board enhancement — task-level time log
// ---------------------------------------------------------------------------

/**
 * Log hours against a task. Only users who can edit the task may log time on
 * it (assignee, or task:edit:any) — the same rule the task editor enforces —
 * and the entry's member is always derived from the session, so nobody can
 * forge a colleague's hours.
 */
export async function logTaskTime(raw: {
  taskId: string;
  date: string;
  hours: number;
  description?: string;
}): Promise<ActionResult<{ id: string }>> {
  return toResult(async () => {
    const auth = await requirePermission("task:edit:own");
    const input = parseOrThrow(logTaskTimeSchema, raw);

    const task = await db.task.findUnique({ where: { id: input.taskId } });
    if (!task) throw new AuthorizationError("Task not found.");
    await assertTaskEditPermission(auth, task);

    const myMemberId = await getMyTeamMemberId(auth);
    if (!myMemberId) {
      throw new AuthorizationError("You don't have a team member profile to log time against.");
    }

    // HR module time guard — see logTime above.
    const leaveOnDay = await findApprovedLeaveOn(auth.userId, new Date(input.date));
    if (leaveOnDay) {
      throw new AuthorizationError(
        `You are on approved ${leaveOnDay.typeName} on ${input.date} — hours cannot be logged for that day.`,
      );
    }

    const entry = await db.timeEntry.create({
      data: {
        taskId: task.id,
        // Keep the project roll-ups working: the entry inherits the task's
        // project so analytics/time views still aggregate correctly.
        projectId: task.projectId,
        memberId: myMemberId,
        date: new Date(input.date),
        hours: input.hours,
        description: input.description ?? "",
      },
    });

    await logAudit({
      actor: auth,
      action: "time.logged",
      entityType: "TIME",
      entityId: entry.id,
      entityLabel: task.title,
      detail: `Logged ${input.hours}h on task “${task.title}”`,
    });
    revalidatePath("/");
    return { id: entry.id };
  });
}

/**
 * Read the time log for a task: the estimate (required), the spent aggregate,
 * and the individual entries with the authoring member's name. Scoped users
 * may only read time logs for tasks they can see (their projects / their
 * assignments) — the same visibility rule the dashboard applies.
 */
export async function getTaskTimeLog(taskId: string): Promise<ActionResult<{
  taskId: string;
  estimateMinutes: number;
  spentHours: number;
  entries: Array<{
    id: string;
    date: string;
    hours: number;
    description: string;
    memberId: string | null;
    memberName: string | null;
    createdAt: string;
  }>;
}>> {
  return toResult(async () => {
    const auth = await getSessionOrThrow();

    const task = await db.task.findUnique({
      where: { id: taskId },
      include: { assignee: { select: { userId: true } } },
    });
    if (!task) throw new AuthorizationError("Task not found.");

    // Same visibility rule as the dashboard loader: scoped users see tasks in
    // their projects or assigned to them.
    const scopedIds = await getScopedProjectIds(auth);
    if (
      scopedIds &&
      !(task.projectId && scopedIds.has(task.projectId)) &&
      task.assignee?.userId !== auth.userId
    ) {
      throw new AuthorizationError("You don't have access to this task.");
    }

    const entries = await db.timeEntry.findMany({
      where: { taskId },
      orderBy: [{ date: "desc" }, { createdAt: "desc" }],
      // PR-21 — hard cap; the task time-log renders inline in the modal.
      take: 500,
    });

    // Resolve member names in bulk (no N+1).
    const memberIds = new Set(entries.map((e) => e.memberId).filter(Boolean) as string[]);
    const members = memberIds.size > 0
      ? await db.teamMember.findMany({
          where: { id: { in: Array.from(memberIds) } },
          select: { id: true, name: true },
        })
      : [];
    const memberMap = new Map(members.map((m) => [m.id, m.name]));

    const spentHours = Math.round(entries.reduce((sum, e) => sum + e.hours, 0) * 10) / 10;

    return {
      taskId: task.id,
      estimateMinutes: task.estimateMinutes,
      spentHours,
      entries: entries.map((e) => ({
        id: e.id,
        date: e.date.toISOString(),
        hours: e.hours,
        description: e.description,
        memberId: e.memberId,
        memberName: e.memberId ? memberMap.get(e.memberId) ?? null : null,
        createdAt: e.createdAt.toISOString(),
      })),
    };
  });
}

/**
 * Delete a time entry. Users may delete their OWN entries; task:edit:any
 * holders (ADMIN / MANAGER) may delete anyone's. Never silently — the audit
 * log records who removed which hours.
 */
export async function deleteTimeEntry(id: string): Promise<ActionResult<void>> {
  return toResult(async () => {
    const auth = await requirePermission("task:edit:own");
    const entry = await db.timeEntry.findUnique({ where: { id } });
    if (!entry) return; // not-found is a clean no-op, matching deleteTask

    if (!hasPermission(auth.role, "task:edit:any")) {
      const myMemberId = await getMyTeamMemberId(auth);
      if (!entry.memberId || entry.memberId !== myMemberId) {
        throw new AuthorizationError("You can only delete time entries you logged.");
      }
    }

    await db.timeEntry.delete({ where: { id } });

    const task = entry.taskId
      ? await db.task.findUnique({ where: { id: entry.taskId }, select: { title: true } })
      : null;
    await logAudit({
      actor: auth,
      action: "time.deleted",
      entityType: "TIME",
      entityId: entry.id,
      entityLabel: task?.title ?? "Time entry",
      detail: `Deleted ${entry.hours}h${task ? ` from task “${task.title}”` : ""}`,
    });
    revalidatePath("/");
  });
}
