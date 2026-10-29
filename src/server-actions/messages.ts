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
  senderName: string;
  senderAvatarColor?: string;
  senderRole?: string;
  recipientName: string;
  recipientUserId?: string;
  subject: string;
  body: string;
}): Promise<ActionResult<string>> {
  return toResult(async () => {
    const auth = await requirePermission("message:send");
    const input = parseOrThrow(sendMessageSchema, raw);
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
        senderName: input.senderName,
        senderAvatarColor: input.senderAvatarColor || "forest",
        senderRole: input.senderRole || "",
        recipientName: input.recipientName,
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
      detail: `Sent “${input.subject}” to ${input.recipientName}`,
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
    // Bulk-insert MessageRead rows (skip duplicates via the compound unique).
    await db.messageRead.createMany({
      data: unreadMsgs.map((m) => ({ userId: auth.userId, messageId: m.id })),
      skipDuplicates: true,
    });
    revalidatePath("/");
  });
}

export async function deleteMessage(id: string): Promise<ActionResult<void>> {
  return toResult(async () => {
    const auth = await requirePermission("message:send"); // anyone who can send can delete their own
    const existing = await db.message.findUnique({ where: { id } });
    // Ownership: only the sender or the recipient of a message may delete it.
    if (existing && existing.senderUserId !== auth.userId && existing.recipientUserId !== auth.userId) {
      throw new AuthorizationError("You can only delete messages you sent or received.");
    }
    await db.message.delete({ where: { id } });
    if (existing) {
      await logAudit({
        actor: auth,
        action: "message.deleted",
        entityType: "MESSAGE",
        entityId: id,
        entityLabel: existing.subject,
        detail: `Deleted message “${existing.subject}”`,
      });
    }
    revalidatePath("/");
  });
}
