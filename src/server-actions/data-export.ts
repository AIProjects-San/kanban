"use server";

// ---------------------------------------------------------------------------
// L-P2-35 — GDPR data export.
//
// The audit (§9.6 L-P2-35) found no GDPR-style export or erasure path for a
// user's data. `exportMyData` returns every row the signed-in user owns or
// is referenced by, as a JSON-serialisable object — the operator wires this
// to a download button in Settings → Privacy. NZ Privacy Act 2020 principle
// 6 (access to personal information) applies.
//
// Redact-on-delete is handled by the existing soft-delete (L-P0-14) plus
// `pruneAuditLogs` (L-P1-20); a hard-erase workflow is follow-up.
// ---------------------------------------------------------------------------

import { db } from "@/lib/db";
import { getSession, AuthorizationError } from "./auth-guard";
import { toResult } from "./result";
import type { ActionResult } from "@/lib/action-result";

export interface UserDataExport {
  exportedAt: string;
  account: {
    id: string;
    email: string;
    name: string;
    role: string;
    timezone: string;
    bio: string;
    avatarColor: string;
    createdAt: string;
  };
  settings: unknown | null;
  ownedProjects: unknown[];
  projectAssignments: unknown[];
  assignedTasks: unknown[];
  sentMessages: unknown[];
  receivedMessages: unknown[];
  notifications: unknown[];
  reminders: unknown[];
  timeEntries: unknown[];
  auditTrail: unknown[];
}

/**
 * Export all personal data for the signed-in user. Self-service — every
 * query is scoped to the caller's own userId, so no permission gate beyond
 * a signed-in session is needed (you can only export your own data).
 */
export async function exportMyData(): Promise<ActionResult<UserDataExport>> {
  return toResult(async () => {
    const auth = await getSession();
    if (!auth) throw new AuthorizationError("You must be signed in.");

    const user = await db.user.findUnique({
      where: { id: auth.userId },
      include: { settings: true },
    });
    if (!user) throw new AuthorizationError("Account not found.");

    const [
      ownedProjects,
      projectAssignments,
      assignedTasks,
      sentMessages,
      receivedMessages,
      notifications,
      reminders,
      timeEntries,
      auditTrail,
    ] = await Promise.all([
      db.project.findMany({
        where: { ownerUserId: auth.userId },
        orderBy: { createdAt: "desc" },
      }),
      db.projectAssignment.findMany({
        where: { userId: auth.userId },
        include: { project: { select: { name: true } } },
        orderBy: { createdAt: "desc" },
      }),
      db.task.findMany({
        where: { assignee: { userId: auth.userId } },
        include: { project: { select: { name: true } } },
        orderBy: { createdAt: "desc" },
      }),
      db.message.findMany({
        where: { senderUserId: auth.userId },
        orderBy: { createdAt: "desc" },
      }),
      db.message.findMany({
        where: { recipientUserId: auth.userId },
        orderBy: { createdAt: "desc" },
      }),
      db.notification.findMany({
        where: { recipientUserId: auth.userId },
        orderBy: { createdAt: "desc" },
      }),
      db.reminder.findMany({
        where: { ownerId: auth.userId },
        orderBy: { createdAt: "desc" },
      }),
      db.timeEntry.findMany({
        where: { member: { userId: auth.userId } },
        include: { project: { select: { name: true } } },
        orderBy: { date: "desc" },
      }),
      db.auditLog.findMany({
        where: { actorId: auth.userId },
        orderBy: { createdAt: "desc" },
      }),
    ]);

    return {
      exportedAt: new Date().toISOString(),
      account: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        timezone: user.timezone,
        bio: user.bio,
        avatarColor: user.avatarColor,
        createdAt: user.createdAt.toISOString(),
      },
      settings: user.settings ?? null,
      ownedProjects,
      projectAssignments,
      assignedTasks,
      sentMessages,
      receivedMessages,
      notifications,
      reminders,
      timeEntries,
      auditTrail,
    };
  });
}
