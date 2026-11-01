"use server";

// Team messaging. L-P0-2 remodel: direction is now DERIVED per viewer
// (recipientUserId === me ? "IN" : "OUT") and read state is per-recipient
// via the MessageRead join table. The legacy `direction` and `read` columns
// are kept for backward-compat with seed data but new code MUST NOT trust
// them for viewer-relative logic.

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requirePermission, getSessionOrThrow, AuthorizationError } from "./auth-guard";
import { sendMessageSchema, parseOrThrow } from "@/lib/validation";
import { logAudit } from "./shared";
import { toResult } from "./result";
import type { ActionResult } from "@/lib/action-result";

export async function sendMessage(raw: {
  // direction is now ignored — always derived as "OUT" from the sender's POV
  // at write time. Kept in the signature for backward-compat with the
  // existing callers (inbox-drawer.tsx, team-view.tsx MessageModal).
  direction?: "OUT" | "IN";
  threadId?: string;
  memberId?: string | null;
  // senderName / senderAvatarColor / senderRole are IGNORED — deep-dive
  // review F-08: they are display identity and were client-controlled, so
  // any signed-in user could send a message that rendered as "from" someone
  // else (impersonation / social engineering). The server now derives them
  // from the session user + their roster profile.
  senderName?: string;
  senderAvatarColor?: string;
  senderRole?: string;
  // recipientName is a display fallback used when the recipient has no User
  // account (roster-only member); when recipientUserId is provided the name
  // is resolved from the database.
  recipientName?: string;
  recipientUserId?: string;
  subject: string;
  body: string;
}): Promise<ActionResult<string>> {
  return toResult(async () => {
    const auth = await requirePermission("message:send");
    const input = parseOrThrow(sendMessageSchema, raw);

    // F-08 — server-side sender identity. Prefer the roster profile (has the
    // job title + avatar color); fall back to the session user.
    const senderProfile = await db.teamMember.findUnique({
      where: { userId: auth.userId },
      select: { name: true, role: true, avatarColor: true },
    });
    const senderName = senderProfile?.name || auth.name;
    const senderRole = senderProfile?.role ?? "";
    const senderAvatarColor = senderProfile?.avatarColor ?? "forest";

    // Resolve the recipient's display name from the DB when we have a user
    // id, so the client can't spoof who a thread is "with".
    let recipientName = input.recipientName ?? "";
    if (input.recipientUserId) {
      const recipient = await db.user.findUnique({
        where: { id: input.recipientUserId },
        select: { name: true },
      });
      if (recipient) recipientName = recipient.name;
    }

    // Generate a threadId if not provided (new conversation)
    const threadId = input.threadId || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await db.message.create({
      data: {
        // Always "OUT" from the sender's POV at write time. The viewer-
        // relative direction is derived at read time in the dashboard loader.
        direction: "OUT",
        threadId,
        memberId: input.memberId || null,
        senderUserId: auth.userId,
        recipientUserId: input.recipientUserId || "",
        senderName,
        senderAvatarColor,
        senderRole,
        recipientName,
        subject: input.subject,
        body: input.body,
        // Legacy: false for the recipient (who hasn't seen it yet). The
        // sender's own copy is implicitly read (they wrote it).
        read: false,
      },
    });
    await logAudit({
      actor: auth,
      action: "message.sent",
      entityType: "MESSAGE",
      entityLabel: input.subject,
      detail: `Sent “${input.subject}” to ${recipientName}`,
    });
    revalidatePath("/");
    return threadId;
  });
}

export async function markMessageRead(id: string): Promise<ActionResult<void>> {
  return toResult(async () => {
    // Only the recipient of a message may mark it as read. L-P0-2: insert
    // a MessageRead row instead of mutating the legacy `read` column.
    const auth = await getSessionOrThrow();
    // Verify the message is addressed to me (recipient check).
    const msg = await db.message.findUnique({
      where: { id },
      select: { recipientUserId: true },
    });
    if (!msg || msg.recipientUserId !== auth.userId) {
      // Not addressed to me — silently no-op (don't leak existence).
      return;
    }
    // Upsert the read-state row (compound unique on (userId, messageId)).
    await db.messageRead.upsert({
      where: { userId_messageId: { userId: auth.userId, messageId: id } },
      update: { readAt: new Date() },
      create: { userId: auth.userId, messageId: id },
    });
    revalidatePath("/");
  });
}

export async function markThreadRead(threadId: string): Promise<ActionResult<void>> {
  return toResult(async () => {
    // L-P0-2: mark all messages in this thread that are addressed to me as
    // read. The old code required `direction: "IN"` which never matched
    // real sent messages (they were stored as "OUT"). The new check uses
    // recipientUserId === me, which is the actual recipient check.
    const auth = await getSessionOrThrow();
    // Find all unread messages in this thread addressed to me.
    const unreadMsgs = await db.message.findMany({
      where: {
        threadId,
        recipientUserId: auth.userId,
        readBy: { none: { userId: auth.userId } },
      },
      select: { id: true },
    });
    if (unreadMsgs.length === 0) return;
    // Bulk-insert MessageRead rows. `skipDuplicates` is deliberately NOT set:
    // it is unsupported on SQLite (typed as `never` and rejected at runtime),
    // and the `readBy: { none }` pre-filter above already guarantees the rows
    // are new for this user, so the compound unique can only be violated by a
    // concurrent duplicate call, which would simply fail that call cleanly.
    await db.messageRead.createMany({
      data: unreadMsgs.map((m) => ({ userId: auth.userId, messageId: m.id })),
    });
    revalidatePath("/");
  });
}

export async function deleteMessage(id: string): Promise<ActionResult<void>> {
  return toResult(async () => {
    const auth = await requirePermission("message:send"); // anyone who can send can delete their own
    const existing = await db.message.findUnique({ where: { id } });
    // Deep-dive review F-15 — not-found is a clean no-op (matching the
    // updateTask pattern), not a P2025 INTERNAL error.
    if (!existing) return;
    // Ownership: only the sender or the recipient of a message may delete it.
    if (existing.senderUserId !== auth.userId && existing.recipientUserId !== auth.userId) {
      throw new AuthorizationError("You can only delete messages you sent or received.");
    }
    // L-P0-14 — soft-delete instead of hard delete. The message is hidden
    // from read paths (which filter `deletedAt: null`) but the row is
    // preserved so audit trails and MessageRead state stay intact.
    await db.message.update({ where: { id }, data: { deletedAt: new Date() } });
    await logAudit({
      actor: auth,
      action: "message.deleted",
      entityType: "MESSAGE",
      entityId: id,
      entityLabel: existing.subject,
      detail: `Soft-deleted message “${existing.subject}”`,
    });
    revalidatePath("/");
  });
}
