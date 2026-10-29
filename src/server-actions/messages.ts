"use server";

// Team messaging. Messages are routed by stable user ids: sender is always
// the signed-in user, and read-state mutations are scoped to the recipient.

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requirePermission, getSessionOrThrow, AuthorizationError } from "./auth-guard";
import { sendMessageSchema, parseOrThrow } from "@/lib/validation";
import { logAudit } from "./shared";
import { toResult } from "./result";
import type { ActionResult } from "@/lib/action-result";

export async function sendMessage(raw: {
  direction: "OUT" | "IN";
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
        direction: input.direction,
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
        read: input.direction === "OUT" ? true : false, // outgoing is always "read"
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
    // Only the recipient of a message may mark it as read.
    const auth = await getSessionOrThrow();
    await db.message.updateMany({
      where: { id, recipientUserId: auth.userId },
      data: { read: true },
    });
    revalidatePath("/");
  });
}

export async function markThreadRead(threadId: string): Promise<ActionResult<void>> {
  return toResult(async () => {
    // Only messages addressed to the signed-in user are marked read.
    const auth = await getSessionOrThrow();
    await db.message.updateMany({
      where: { threadId, direction: "IN", read: false, recipientUserId: auth.userId },
      data: { read: true },
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
