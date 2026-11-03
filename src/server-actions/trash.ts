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
import { canManageUser, getSubtreeUserIds } from "@/lib/hierarchy";
import { isValidRole, type Role } from "@/lib/rbac";
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
    // PR-02 (production-readiness audit) — this previously routed through
    // requirePermissionForTarget, whose target lookup filters `deletedAt: null`.
    // A user in the trash is soft-deleted by definition, so the lookup ALWAYS
    // returned null and restoreUser could never restore anyone (the unit test
    // passed only because its mock intercepted both lookups). Now the guard is
    // done inline WITHOUT the deletedAt filter: permission first, then the
    // hierarchy check (admins manage everyone; managers only their subtree —
    // getSubtreeUserIds does not filter soft-deleted users, so a manager can
    // still restore their own former reports).
    const auth = await requirePermission("role:manage");
    if (userId === auth.userId) {
      throw new AuthorizationError("You cannot restore your own account this way.");
    }
    const target = await db.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, email: true, role: true, managerId: true, deletedAt: true },
    });
    if (!target) throw new AuthorizationError("User not found.");
    if (!target.deletedAt) throw new AuthorizationError("User is not in the trash.");
    if (auth.role !== "ADMIN") {
      const targetRole: Role = isValidRole(target.role) ? target.role : "MEMBER";
      const actorSubtree = await getSubtreeUserIds(auth.userId);
      if (!canManageUser(
        { userId: auth.userId, role: auth.role },
        { userId: target.id, role: targetRole, managerId: target.managerId },
        actorSubtree,
      )) {
        throw new AuthorizationError(
          "You can only restore users in your reporting chain. " +
          "This user is not one of your direct or transitive reports.",
        );
      }
    }
    // PR-15 — the User + TeamMember restores are two halves of one operation;
    // a crash between them used to leave the roster row soft-deleted while the
    // user could sign in again. Wrap both writes in a transaction.
    await db.$transaction(async (tx) => {
      await tx.user.update({ where: { id: userId }, data: { deletedAt: null } });
      // Also restore the linked TeamMember row (soft-deleted alongside the User).
      if (target.email) {
        await tx.teamMember.updateMany({
          where: { email: target.email.toLowerCase() },
          data: { deletedAt: null },
        });
      }
    });
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



// ---------------------------------------------------------------------------
// PR-38 (production-readiness round 2) — right-to-erasure hard erase.
//
// Roadmap §6.12: soft-delete + GDPR self-export existed, but the only way
// to truly remove a person's data was direct DB access. This action gives
// the workspace owner an auditable, safeguarded erasure path:
//
//   • ADMIN-only, and never yourself — irreversible actions are restricted
//     to the role that owns the privacy posture.
//   • Two-step safety: the user must ALREADY be soft-deleted (in the
//     trash). Erasing is therefore always a deliberate second decision,
//     never a mis-click on the live user list.
//   • One transaction, evidence-first ordering inside it:
//       1. the `user.erased` audit row is created INSIDE the transaction —
//          a failed erase leaves no misleading row, a successful erase can
//          never lose it (unlike logAudit, which is best-effort by design);
//       2. the TeamMember roster row(s) are deleted (name, email, avatar =
//          the remaining PII surface; Task/TimeEntry FKs SetNull so
//          business data survives, unlinked);
//       3. Message sender/recipient display names authored by the user are
//          anonymised to "Erased user" — message bodies are two-party
//          conversations, so the counterpart keeps their copy without
//          retaining the erased person's identity;
//       4. the User row is deleted. Cascades (schema-level) remove
//          UserSettings, personal Notifications, MessageReads,
//          PasswordResetTokens and ProjectAssignments; SetNull promotes
//          direct reports to roots and clears owned projects' ownerUserId.
//   • Retained BY DESIGN and documented for the privacy notice: the audit
//     trail (accountability — GDPR Art. 17(3)(b)), and tasks/time entries
//     (workspace business records, now identity-free).
//
// The audit row deliberately does NOT repeat the email — entityLabel is the
// user's id prefix, so the erasure evidence cannot itself be a PII leak.
// ---------------------------------------------------------------------------

export async function eraseUser(userId: string): Promise<ActionResult<void>> {
  return toResult(async () => {
    const auth = await requirePermission("role:manage");
    if (auth.role !== "ADMIN") {
      throw new AuthorizationError(
        "Only administrators can permanently erase users (right-to-erasure).",
      );
    }
    if (userId === auth.userId) {
      throw new AuthorizationError(
        "You cannot erase your own account. Ask another admin to do it.",
      );
    }
    const target = await db.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, email: true, deletedAt: true },
    });
    if (!target) throw new AuthorizationError("User not found.");
    if (!target.deletedAt) {
      throw new AuthorizationError(
        "Only users already in the trash can be permanently erased. " +
          "Soft-delete them first, then erase from the trash.",
      );
    }

    await db.$transaction(async (tx) => {
      // 1. Evidence-first — inside the tx (see header).
      await tx.auditLog.create({
        data: {
          actorId: auth.userId,
          actorName: auth.name,
          actorRole: auth.role,
          action: "user.erased",
          entityType: "USER",
          entityId: userId,
          entityLabel: target.id.slice(0, 10),
          detail:
            `Permanently erased the account of a soft-deleted user ` +
            `(id ${target.id.slice(0, 10)}). Roster row deleted, message ` +
            `display names anonymised, account row removed.`,
        },
      });

      // 2. Scrub the roster profile (PII: name, email, avatar). Rows are
      // matched by the stable userId link AND by email (legacy rows may
      // predate the link).
      await tx.teamMember.deleteMany({
        where: {
          OR: [{ userId }, { email: target.email.toLowerCase() }],
        },
      });

      // 3. Anonymise the erased person's display identity on shared
      // conversations (bodies stay — they are also the counterpart's data).
      await tx.message.updateMany({
        where: { senderUserId: userId },
        data: { senderName: "Erased user", senderRole: "" },
      });
      await tx.message.updateMany({
        where: { recipientUserId: userId },
        data: { recipientName: "Erased user" },
      });

      // 4. Delete the account row (cascades/SetNulls per the schema).
      await tx.user.delete({ where: { id: userId } });
    });

    revalidatePath("/");
  });
}
