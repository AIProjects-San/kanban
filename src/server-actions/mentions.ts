// SERVER-ONLY mention notification helper (no "use server" — imported by the
// task/message action modules, never by client components).
//
// L-P2-29 — parse @Name mentions from a text body and emit MENTION
// notifications to the referenced users.

import { logError } from "@/lib/observability";
import { db } from "@/lib/db";
import { extractMentionedNames, normaliseNameForMention } from "@/lib/mentions";

export interface MentionContext {
  /** The text body to scan for @mentions (task description, message body). */
  text: string;
  /** The user who wrote the text (they are never notified about their own mention). */
  actorUserId: string;
  actorName: string;
  /** What the mention points at, for the notification copy. */
  entityType: "TASK" | "MESSAGE";
  entityLabel: string;
  /** Optional deep-link fragment appended to the notification message. */
  detail?: string;
}

/**
 * Scan `ctx.text` for @mentions and create a MENTION notification for each
 * referenced user (excluding the actor).
 *
 * Matching is case-insensitive on the full display name, or on a single
 * first-name word only when it is unambiguous (exactly one user matches).
 * Best-effort: a failure to notify never breaks the underlying mutation.
 *
 * Returns the ids of the users that were notified.
 */
export async function notifyMentionedUsers(ctx: MentionContext): Promise<string[]> {
  try {
    const mentionedNames = extractMentionedNames(ctx.text);
    if (mentionedNames.length === 0) return [];

    // P2 (production-readiness re-audit) — previously loaded ALL non-deleted
    // users into memory on every mention-bearing task/message write. A 10k-
    // user workspace would load 10k rows on every @mention. Now we scope the
    // query to only users whose name could plausibly match one of the
    // mentioned names (case-insensitive contains on each token), capped at
    // a generous take limit as a safety net.
    //
    // We still fetch each user's notification preferences so the Settings →
    // "Mentions" toggle is genuinely honoured (audit gate 9: no cosmetic
    // controls — a toggle must either work or be absent/labelled).
    const mentionTokens = mentionedNames
      .flatMap((n) => n.trim().split(/\s+/))
      .filter((t) => t.length >= 2);
    const users = mentionTokens.length > 0
      ? await db.user.findMany({
          where: {
            deletedAt: null,
            OR: mentionTokens.map((token) => ({
              name: { contains: token, mode: "insensitive" as const },
            })),
          },
          take: 500, // safety cap — a single mention list rarely matches >50
          select: {
            id: true,
            name: true,
            settings: { select: { notifMentions: true } },
          },
        })
      : [];

    const byName = new Map<string, string>(); // normalised full name → userId
    const byFirstName = new Map<string, string[]>(); // first word → userIds
    const mentionsOptOut = new Set<string>(); // users with the Mentions toggle OFF
    for (const u of users) {
      if (u.settings?.notifMentions === false) mentionsOptOut.add(u.id);
      byName.set(normaliseNameForMention(u.name), u.id);
      const first = u.name.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
      if (first) {
        const list = byFirstName.get(first) ?? [];
        list.push(u.id);
        byFirstName.set(first, list);
      }
    }

    const notified: string[] = [];
    const notifiedSet = new Set<string>();

    for (const rawName of mentionedNames) {
      const normalised = normaliseNameForMention(rawName);
      let userId: string | undefined;

      // 1) Exact full-name match ("@Ada Lovelace" → candidate "Ada Lovelace").
      userId = byName.get(normalised);

      // 2) First-word match — covers both a bare "@Ada" and the maximal
      //    candidate "Ada about" when the real name is just "Ada". Only
      //    applies when exactly one user has that first word (unambiguous).
      if (!userId) {
        const firstWord = normalised.split(" ")[0];
        const candidates = byFirstName.get(firstWord) ?? [];
        if (candidates.length === 1) {
          userId = candidates[0];
        }
      }

      if (!userId || userId === ctx.actorUserId) continue;
      if (notifiedSet.has(userId)) continue;
      // Honour the recipient's Settings → Notifications → Mentions toggle.
      if (mentionsOptOut.has(userId)) continue;
      notifiedSet.add(userId);
      notified.push(userId);
    }

    if (notified.length === 0) return [];

    const where =
      ctx.entityType === "TASK"
        ? "in a task"
        : "in a message";

    await db.notification.createMany({
      data: notified.map((userId) => ({
        recipientUserId: userId,
        type: "MENTION",
        title: `${ctx.actorName} mentioned you ${where}`,
        message: ctx.detail
          ? `“${ctx.entityLabel}” — ${ctx.detail}`
          : `“${ctx.entityLabel}”`,
      })),
    });

    return notified;
  } catch (err) {
    // Mention notification must never break the underlying mutation.
    logError("[mentions] failed to notify:", err);
    return [];
  }
}
