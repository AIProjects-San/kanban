// SERVER-ONLY shared helpers for the server-action modules.
//
// NOTE: This file intentionally does NOT have "use server" — it exports
// non-async values and is imported by the domain action modules below,
// never by client components.

import { logError } from "@/lib/observability";
import { db } from "@/lib/db";
import { hasPermission, type Role } from "@/lib/rbac";
import { AuthorizationError } from "./auth-guard";
import type { AuditAction } from "@/lib/audit-meta";
import { headers as nextHeaders } from "next/headers";

export { AuthorizationError };

/**
 * P1 (production-readiness re-audit) — extract the client IP + user agent
 * from the request context for audit logging. Best-effort: behind a reverse
 * proxy we read `x-forwarded-for` (first hop); without a proxy we fall back
 * to "unknown". Returns an object so callers can destructure both fields
 * from one call site.
 */
export async function getClientInfo(): Promise<{ ip: string; userAgent: string }> {
  try {
    const h = await nextHeaders();
    const xff = h.get("x-forwarded-for") ?? "";
    const ip = xff.split(",")[0].trim() || "unknown";
    const userAgent = (h.get("user-agent") ?? "").slice(0, 500) || "unknown";
    return { ip, userAgent };
  } catch {
    return { ip: "unknown", userAgent: "unknown" };
  }
}

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
  /** P1 (production-readiness re-audit) — source IP + user agent for
   *  post-incident forensics. Optional; callers that have a request context
   *  (server actions, the auth flow) pass them through. */
  ipAddress?: string;
  userAgent?: string;
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
        // P1 re-audit — capture the source IP + UA when available. Both
        // columns are NOT NULL DEFAULT '' so omitting them is safe.
        ...(entry.ipAddress !== undefined ? { ipAddress: entry.ipAddress } : {}),
        ...(entry.userAgent !== undefined ? { userAgent: entry.userAgent } : {}),
      },
    });
  } catch (err) {
    // Audit logging must never break the underlying operation
    logError("[audit] failed to write log entry:", err);
  }
}

/**
 * Resolve the TeamMember id that belongs to the signed-in user. Prefers
 * the stable TeamMember.userId link; falls back to a unique-email match for
 * rows not yet linked. Returns null if the user has no team-member record.
 */
export async function getMyTeamMemberId(auth: { userId: string; email: string }): Promise<string | null> {
  // P2 (edge-case audit) — filter deletedAt: null on both lookups. A soft-
  // deleted TeamMember row (set by deleteUser) should not authorise task
  // edits via assertTaskEditPermission. The JWT refresh window (5 min) means
  // a soft-deleted user's token is still valid briefly; this filter closes
  // the gap so they can't edit "their" tasks during that window.
  const byUser = await db.teamMember.findUnique({
    where: { userId: auth.userId, deletedAt: null },
    select: { id: true },
  });
  if (byUser) return byUser.id;
  const member = await db.teamMember.findUnique({
    where: { email: auth.email.toLowerCase(), deletedAt: null },
    select: { id: true },
  });
  return member?.id ?? null;
}

// ---------------------------------------------------------------------------
// Deep-dive review F-03 — one canonical data-scoping helper.
//
// getDashboardData always scoped MEMBER/MANAGER reads to "projects you own,
// have tasks in, or are explicitly assigned to". Several later read paths
// (pagination, search, project members) forgot that rule and returned
// workspace-wide data to any signed-in user. Everything now funnels through
// this helper so the scopes can never drift apart again.
//
// Returns:
//   • null  → unscoped (ADMIN) — the caller sees the whole workspace.
//   • Set   → the caller's project ids (possibly empty).
// ---------------------------------------------------------------------------

export async function getScopedProjectIds(
  auth: { userId: string; role: string },
): Promise<Set<string> | null> {
  if (auth.role === "ADMIN") return null;
  const [owned, assignedProjects, explicitAssignments] = await Promise.all([
    db.project.findMany({
      where: { ownerUserId: auth.userId },
      select: { id: true },
    }),
    db.task.findMany({
      where: { assignee: { userId: auth.userId } },
      select: { projectId: true },
      distinct: ["projectId"],
    }),
    db.projectAssignment.findMany({
      where: { userId: auth.userId },
      select: { projectId: true },
    }),
  ]);
  return new Set([
    ...owned.map((p) => p.id),
    ...assignedProjects.map((t) => t.projectId).filter(Boolean) as string[],
    ...explicitAssignments.map((a) => a.projectId),
  ]);
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
