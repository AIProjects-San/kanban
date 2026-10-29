"use server";

// Notifications — per-user routing with workspace-wide broadcasts.
//
// Visibility and mutation rules (schema: prisma Notification.recipientUserId):
//   • recipientUserId set   → private to that user; only they see it and only
//                             they can flip its read flag.
//   • recipientUserId null  → workspace-wide broadcast; visible to everyone,
//                             but only role:manage holders may flip the read
//                             flag (it affects every viewer, so it is an
//                             act of curation, not a personal action).

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { getSessionOrThrow } from "./auth-guard";
import { hasPermission } from "@/lib/rbac";
import { AuthorizationError } from "./auth-guard";
import { toResult } from "./result";
import type { ActionResult } from "@/lib/action-result";

export async function markNotificationRead(id: string, read: boolean): Promise<ActionResult<void>> {
  return toResult(async () => {
    const auth = await getSessionOrThrow();
    const existing = await db.notification.findUnique({ where: { id } });
    if (!existing) return;
    // Private notifications: owner only. Broadcasts: role:manage only.
    if (existing.recipientUserId) {
      if (existing.recipientUserId !== auth.userId) {
        throw new AuthorizationError("You can only change your own notifications.");
      }
    } else if (!hasPermission(auth.role, "role:manage")) {
      throw new AuthorizationError("Workspace-wide notifications can only be managed by an admin.");
    }
    await db.notification.update({ where: { id }, data: { read } });
    revalidatePath("/");
  });
}

export async function markAllNotificationsRead(): Promise<ActionResult<void>> {
  return toResult(async () => {
    const auth = await getSessionOrThrow();
    // Marks only the notifications addressed to the caller. Broadcasts are
    // deliberately left alone — flipping them would clear the feed for every
    // other user in the workspace.
    await db.notification.updateMany({
      where: { recipientUserId: auth.userId, read: false },
      data: { read: true },
    });
    revalidatePath("/");
  });
}
