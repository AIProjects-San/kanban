"use server";

// ---------------------------------------------------------------------------
// L-P2-33 — Trash / restore.
//
// Soft-delete (L-P0-14) hides rows via `deletedAt`; this module adds the
// other half of the audit's recommendation: a Trash view listing soft-deleted
// entities + restore actions. Restoring clears `deletedAt`, which brings the
// row (and its preserved references — tasks keep their projectId, roster
// rows keep their userId) back into every read path.
//
// The 10-second undo toast is UI polish tracked as follow-up; the restore
// action + trash listing are the substance.
// ---------------------------------------------------------------------------

import { db } from "@/lib/db";
import { requirePermission, getSession, AuthorizationError } from "./auth-guard";
import { logAudit } from "./shared";
import { toResult } from "./result";
import type { ActionResult } from "@/lib/action-result";
import { revalidatePath } from "next/cache";

export interface TrashItem {
  id: string;
  label: string;
  sublabel: string;
  kind: "project" | "user" | "message";
  deletedAt: string;
}

/**
 * List soft-deleted projects, users, and messages for the Trash view.
 * Admin-only (role:manage) — the trash is a workspace-wide recovery surface.
 */
export async function getTrash(): Promise<ActionResult<TrashItem[]>> {
  return toResult(async () => {
    await requirePermission("role:manage");

    const [projects, users, messages] = await Promise.all([
      db.project.findMany({
        where: { deletedAt: { not: null } },
        select: { id: true, name: true, status: true, deletedAt: true },
        orderBy: { deletedAt: "desc" },
        take: 100,
      }),
      db.user.findMany({
        where: { deletedAt: { not: null } },
        select: { id: true, name: true, email: true, deletedAt: true },
        orderBy: { deletedAt: "desc" },
        take: 100,
      }),
      db.message.findMany({
        where: { deletedAt: { not: null } },
        select: { id: true, subject: true, senderName: true, deletedAt: true },
        orderBy: { deletedAt: "desc" },
        take: 100,
      }),
    ]);

    const items: TrashItem[] = [
      ...projects.map((p) => ({
        id: p.id,
        label: p.name,
        sublabel: `Project · ${p.status}`,
        kind: "project" as const,
        deletedAt: p.deletedAt!.toISOString(),
      })),
      ...users.map((u) => ({
        id: u.id,
        label: u.name,
        sublabel: `User · ${u.email}`,
        kind: "user" as const,
        deletedAt: u.deletedAt!.toISOString(),
      })),
      ...messages.map((m) => ({
        id: m.id,
        label: m.subject,
        sublabel: `Message · from ${m.senderName}`,
        kind: "message" as const,
        deletedAt: m.deletedAt!.toISOString(),
      })),
    ];

    // Most recently deleted first.
    items.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
    return items;
  });
}

/**
 * Restore a soft-deleted project (clears deletedAt). Tasks that belonged to
 * it become visible again — their projectId references were preserved by
 * the L-P0-14 soft-delete.
 */
export async function restoreProject(id: string): Promise<ActionResult<void>> {
  return toResult(async () => {
    const auth = await requirePermission("project:delete");
    const existing = await db.project.findUnique({ where: { id } });
    if (!existing) throw new AuthorizationError("Project not found.");
    if (!existing.deletedAt) throw new AuthorizationError("Project is not in the trash.");
    await db.project.update({ where: { id }, data: { deletedAt: null } });
    await logAudit({
      actor: auth,
      action: "project.restored",
      entityType: "PROJECT",
      entityId: id,
      entityLabel: existing.name,
      detail: `Restored project “${existing.name}” from the trash`,
    });
    revalidatePath("/");
  });
}

/**
 * Restore a soft-deleted user (clears deletedAt on both the User row and the
 * linked TeamMember row). The user can sign in again immediately — sessions
 * were invalidated at delete time, so a fresh sign-in is required.
 */
export async function restoreUser(userId: string): Promise<ActionResult<void>> {
  return toResult(async () => {
    const auth = await requirePermissionForTargetCompat("role:manage", userId);
    if (userId === auth.userId) {
      throw new AuthorizationError("You cannot restore your own account this way.");
    }
    const target = await db.user.findUnique({ where: { id: userId } });
    if (!target) throw new AuthorizationError("User not found.");
    if (!target.deletedAt) throw new AuthorizationError("User is not in the trash.");
    await db.user.update({ where: { id: userId }, data: { deletedAt: null } });
    // Also restore the linked TeamMember row (soft-deleted alongside the User).
    if (target.email) {
      await db.teamMember.updateMany({
        where: { email: target.email.toLowerCase() },
        data: { deletedAt: null },
      });
    }
    await logAudit({
      actor: auth,
      action: "user.restored",
      entityType: "USER",
      entityId: userId,
      entityLabel: target.name,
      detail: `Restored user ${target.name} (${target.email}) from the trash`,
    });
    revalidatePath("/");
  });
}

/**
 * Restore a soft-deleted message (clears deletedAt). Read state (MessageRead
 * rows) was preserved by the L-P0-14 soft-delete.
 */
export async function restoreMessage(id: string): Promise<ActionResult<void>> {
  return toResult(async () => {
    const auth = await getSession();
    if (!auth) throw new AuthorizationError("You must be signed in.");
    const existing = await db.message.findUnique({ where: { id } });
    if (!existing) throw new AuthorizationError("Message not found.");
    if (!existing.deletedAt) throw new AuthorizationError("Message is not in the trash.");
    // Ownership: only the sender or the recipient may restore it.
    if (existing.senderUserId !== auth.userId && existing.recipientUserId !== auth.userId) {
      throw new AuthorizationError("You can only restore messages you sent or received.");
    }
    await db.message.update({ where: { id }, data: { deletedAt: null } });
    await logAudit({
      actor: auth,
      action: "message.restored",
      entityType: "MESSAGE",
      entityId: id,
      entityLabel: existing.subject,
      detail: `Restored message “${existing.subject}” from the trash`,
    });
    revalidatePath("/");
  });
}

// Local import shim: requirePermissionForTarget lives in auth-guard; using it
// directly keeps hierarchy checks consistent with updateUser/deleteUser.
async function requirePermissionForTargetCompat(permission: Parameters<typeof import("./auth-guard").requirePermissionForTarget>[0], targetUserId: string) {
  const { requirePermissionForTarget } = await import("./auth-guard");
  return requirePermissionForTarget(permission, targetUserId);
}
