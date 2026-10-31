// SERVER-ONLY shared helpers for the server-action modules.
//
// NOTE: This file intentionally does NOT have "use server" — it exports
// non-async values and is imported by the domain action modules below,
// never by client components.

import { db } from "@/lib/db";
import { hasPermission, type Role } from "@/lib/rbac";
import { AuthorizationError } from "./auth-guard";
import type { AuditAction } from "@/lib/audit-meta";

export { AuthorizationError };

export function fmtDay(d: Date) {
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

export async function logAudit(entry: {
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

/**
 * Resolve the TeamMember id that belongs to the signed-in user. Prefers
 * the stable TeamMember.userId link; falls back to a unique-email match for
 * rows not yet linked. Returns null if the user has no team-member record.
 */
export async function getMyTeamMemberId(auth: { userId: string; email: string }): Promise<string | null> {
  const byUser = await db.teamMember.findUnique({
    where: { userId: auth.userId },
    select: { id: true },
  });
  if (byUser) return byUser.id;
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
export async function assertTaskEditPermission(
  auth: { userId: string; email: string; role: Role },
  task: { assigneeId: string | null },
) {
  if (hasPermission(auth.role, "task:edit:any")) return;
  const myMemberId = await getMyTeamMemberId(auth);
  if (!task.assigneeId || task.assigneeId !== myMemberId) {
    throw new AuthorizationError("You can only edit tasks that are assigned to you.");
  }
}

/**
 * Recompute the denormalized workload counters on a team member after any
 * task mutation that could change them.
 *
 * Capacity is read from `Workspace.workloadFullCapacity` (admin-editable in
 * Workspace Settings) — closing L-P0-16. Falls back to 6 if the workspace
 * row is missing or the configured value is invalid (<= 0).
 */
export async function recalcMemberStats(memberId: string | null) {
  if (!memberId) return;
  const tasks = await db.task.findMany({ where: { assigneeId: memberId } });
  const open = tasks.filter((t) => t.status !== "DONE").length;
  const completed = tasks.filter((t) => t.status === "DONE").length;
  const workspace = await db.workspace.findUnique({
    where: { id: "default" },
    select: { workloadFullCapacity: true },
  });
  const capacity = workspace?.workloadFullCapacity && workspace.workloadFullCapacity > 0
    ? workspace.workloadFullCapacity
    : 6;
  const workload = Math.min(100, Math.round((open / capacity) * 100));
  await db.teamMember.update({
    where: { id: memberId },
    data: { openTasks: open, completedTasks: completed, workload },
  });
}
