"use server";

// Audit log readers.
//
// `getAuditLogs` powers the workspace-wide Audit Log page (audit:view).
// `getAuditLogsForEntity` is callable by anyone signed in — the audit trail
// of a task you can edit is part of that task's context (see the full
// rationale in the original review §P1-15).

import { db } from "@/lib/db";
import { requirePermission, getSession, AuthorizationError } from "./auth-guard";
import { hasPermission } from "@/lib/rbac";
import { toResult } from "./result";
import type { ActionResult } from "@/lib/action-result";

export async function getAuditLogs(): Promise<ActionResult<
  Array<{
    id: string;
    actorId: string;
    actorName: string;
    actorRole: string;
    action: string;
    entityType: string;
    entityId: string;
    entityLabel: string;
    detail: string;
    createdAt: string;
  }>
>> {
  return toResult(async () => {
    await requirePermission("audit:view");
    const logs = await db.auditLog.findMany({
      orderBy: { createdAt: "desc" },
      take: 300,
    });
    return logs.map((l) => ({
      ...l,
      createdAt: l.createdAt.toISOString(),
    }));
  });
}

export async function getAuditLogsForEntity(
  entityType: string,
  entityId: string,
): Promise<ActionResult<
  Array<{
    id: string;
    actorId: string;
    actorName: string;
    actorRole: string;
    action: string;
    entityType: string;
    entityId: string;
    entityLabel: string;
    detail: string;
    createdAt: string;
  }>
>> {
  return toResult(async () => {
    const auth = await getSession();
    if (!auth) throw new AuthorizationError("You must be signed in.");
    if (!entityId) return [];
    // Deep-dive review F-03 — entityType was previously unrestricted, so any
    // signed-in MEMBER could read the audit trail of arbitrary entities —
    // including USER rows, whose detail lines contain emails. Entity types
    // that can carry personal data (USER, MESSAGE, AUTH, ROLE, WORKSPACE,
    // CONFIG, AUDIT) now require audit:view (MANAGER+). Operational entity
    // types (TASK, PROJECT, MEMBER, EVENT, TIME, REMINDER, NOTIFICATION)
    // stay open to signed-in users — they are the board context the entity
    // history panel renders.
    const openEntityTypes = new Set([
      "TASK", "PROJECT", "MEMBER", "EVENT", "TIME", "REMINDER", "NOTIFICATION",
    ]);
    if (!openEntityTypes.has(entityType) && !hasPermission(auth.role, "audit:view")) {
      throw new AuthorizationError("You can only view history for tasks, projects and team entities.");
    }
    const logs = await db.auditLog.findMany({
      where: { entityType, entityId },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    return logs.map((l) => ({
      ...l,
      createdAt: l.createdAt.toISOString(),
    }));
  });
}
