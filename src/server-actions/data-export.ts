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

import { db } from "@/lib/infra/db";
import { AuthorizationError, getSessionOrThrow } from "./auth-guard";
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
  /** P2 (edge-case audit) — true if any query hit its 10k-row cap. The user
   *  should contact an admin for the full export (GDPR allows pagination). */
  truncated: boolean;
}

/**
 * Export all personal data for the signed-in user. Self-service — every
 * query is scoped to the caller's own userId, so no permission gate beyond
 * a signed-in session is needed (you can only export your own data).
 */
export async function exportMyData(): Promise<ActionResult<UserDataExport>> {
  return toResult(async () => {
    const auth = await getSessionOrThrow();

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
        take: 10_000,
      }),
      db.projectAssignment.findMany({
        where: { userId: auth.userId },
        include: { project: { select: { name: true } } },
        orderBy: { createdAt: "desc" },
        take: 10_000,
      }),
      db.task.findMany({
        where: { assignee: { userId: auth.userId } },
        include: { project: { select: { name: true } } },
        orderBy: { createdAt: "desc" },
        take: 10_000,
      }),
      db.message.findMany({
        where: { senderUserId: auth.userId },
        orderBy: { createdAt: "desc" },
        take: 10_000,
      }),
      db.message.findMany({
        where: { recipientUserId: auth.userId },
        orderBy: { createdAt: "desc" },
        take: 10_000,
      }),
      db.notification.findMany({
        where: { recipientUserId: auth.userId },
        orderBy: { createdAt: "desc" },
        take: 10_000,
      }),
      db.reminder.findMany({
        where: { ownerId: auth.userId },
        orderBy: { createdAt: "desc" },
        take: 10_000,
      }),
      db.timeEntry.findMany({
        where: { member: { userId: auth.userId } },
        include: { project: { select: { name: true } } },
        orderBy: { date: "desc" },
        take: 10_000,
      }),
      db.auditLog.findMany({
        where: { actorId: auth.userId },
        orderBy: { createdAt: "desc" },
        take: 10_000,
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
      // P2 (edge-case audit) — flag truncation so the user knows to contact
      // an admin if any collection hit the 10k cap.
      truncated:
        ownedProjects.length >= 10_000 ||
        projectAssignments.length >= 10_000 ||
        assignedTasks.length >= 10_000 ||
        sentMessages.length >= 10_000 ||
        receivedMessages.length >= 10_000 ||
        notifications.length >= 10_000 ||
        reminders.length >= 10_000 ||
        timeEntries.length >= 10_000 ||
        auditTrail.length >= 10_000,
    };
  });
}
