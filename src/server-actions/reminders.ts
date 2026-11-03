"use server";

// Reminders — personal only (ownerId = the signed-in creator).
//
// PR-52: the dashboard query previously also surfaced legacy
// workspace-wide rows (ownerId = null) to every signed-in user. A
// reminder is a personal todo item, never a broadcast, so those rows
// are no longer rendered on the dashboard (see dashboard.ts). The
// ownerId column keeps its null-allowing type for back-compat with
// legacy data; the toggle path below still permits null-owner rows
// to be flipped as a harmless safety net, but the UI never surfaces
// them. Broadcasts still exist for NOTIFICATIONS (notifications.ts)
// where recipientUserId = null is an intentional admin-announcement
// feature.

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { getSessionOrThrow } from "./auth-guard";
import { hasPermission } from "@/lib/rbac";
import { AuthorizationError } from "./auth-guard";
import { createReminderSchema, parseOrThrow } from "@/lib/validation";
import { logAudit } from "./shared";
import { toResult } from "./result";
import type { ActionResult } from "@/lib/action-result";

export async function toggleReminder(id: string, completed: boolean): Promise<ActionResult<void>> {
  return toResult(async () => {
    const auth = await getSessionOrThrow();
    const existing = await db.reminder.findUnique({ where: { id } });
    // Deep-dive review F-15 — not-found is a clean no-op, not a P2025.
    if (!existing) return;
    // Personal reminders can only be toggled by their owner (or an admin).
    if (existing.ownerId && existing.ownerId !== auth.userId && !hasPermission(auth.role, "role:manage")) {
      throw new AuthorizationError("You can only change your own reminders.");
    }
    await db.reminder.update({ where: { id }, data: { completed } });
    if (existing.completed !== completed) {
      await logAudit({
        actor: auth,
        action: completed ? "reminder.completed" : "reminder.reopened",
        entityType: "REMINDER",
        entityId: id,
        entityLabel: existing.title,
        detail: completed
          ? `Completed reminder “${existing.title}”`
          : `Reopened reminder “${existing.title}”`,
      });
    }
    revalidatePath("/");
  });
}

export async function createReminder(raw: { title: string; dueDate: string }): Promise<ActionResult<void>> {
  return toResult(async () => {
    const auth = await getSessionOrThrow();
    const input = parseOrThrow(createReminderSchema, raw);
    // New reminders are personal — only the creator sees them.
    const reminder = await db.reminder.create({
      data: { title: input.title, dueDate: new Date(input.dueDate), ownerId: auth.userId },
    });
    await logAudit({
      actor: auth,
      action: "reminder.created",
      entityType: "REMINDER",
      entityId: reminder.id,
      entityLabel: input.title,
      detail: `Added reminder “${input.title}”`,
    });
    revalidatePath("/");
  });
}
