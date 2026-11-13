// SERVER-ONLY audit prune core (no "use server" — imported by the admin
// server action and the cron route, never by client components).
//
// Launch gate 12 ("audit retention job running with a demonstrated prune")
// requires the prune to be schedulable without a user session, so the
// batched delete logic lives here with the caller deciding the auth model:
//
//   • server-actions/audit-retention.ts  → requirePermission("role:manage")
//   • api/cron/prune-audit/route.ts      → CRON_SECRET bearer token
//
// Both paths write the same self-documenting `audit.pruned` meta-row; the
// cron path attributes it to the synthetic "system (cron)" actor.

import { db } from "@/lib/db";
import { logWarn } from "@/lib/observability";
import { logAudit } from "@/lib/server/audit";
import {
  DEFAULT_AUDIT_RETENTION_DAYS,
  MIN_AUDIT_RETENTION_DAYS,
  type PruneResult,
} from "@/lib/audit-retention-config";

/** Synthetic identity used when the scheduler (not a human) runs the prune. */
export const CRON_ACTOR = {
  userId: "system-cron",
  name: "system (cron)",
  role: "ADMIN",
} as const;

export function clampRetentionDays(configured: number | undefined | null): number {
  if (!configured || configured <= 0) return DEFAULT_AUDIT_RETENTION_DAYS;
  return Math.max(configured, MIN_AUDIT_RETENTION_DAYS);
}

export async function runAuditPrune(
  actor: { userId: string; name: string; role: string } = CRON_ACTOR,
): Promise<PruneResult> {
  const workspace = await db.workspace.findUnique({
    where: { id: "default" },
    select: { auditRetentionDays: true },
  });
  const retentionDays = clampRetentionDays(workspace?.auditRetentionDays);
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

  // P1 (edge-case audit) — write the `audit.pruned` meta-row BEFORE the
  // deletes. The prior order (deletes → logAudit) meant an admin pruning to
  // cover their tracks could engineer a DB-write failure on AuditLog (or
  // have DB console access to drop the meta-row) and erase the evidence that
  // a prune happened. logAudit swallows errors (best-effort by design), so
  // the meta-row write was silently lossy. Now: write it first; if the write
  // fails, the prune still proceeds (the meta-row is best-effort) but at
  // least a successful prune always has its meta-row persisted before any
  // deletes run.
  await logAudit({
    actor,
    action: "audit.pruned",
    entityType: "AUDIT",
    detail: `Pruning audit rows older than ${cutoff.toISOString()} (retention: ${retentionDays} days)`,
  });

  // Real batching (F-09): deleteMany has no LIMIT, so a "batch loop" over
  // deleteMany was one unbounded transaction. This raw statement caps each
  // round at BATCH_SIZE rows; the loop runs until a round comes back short.
  const BATCH_SIZE = 10_000;
  let totalDeleted = 0;
  let batchDeleted = BATCH_SIZE;
  while (batchDeleted === BATCH_SIZE) {
    batchDeleted = await db.$executeRaw`
      DELETE FROM "AuditLog"
      WHERE "id" IN (
        SELECT "id" FROM "AuditLog" WHERE "createdAt" < ${cutoff} LIMIT ${BATCH_SIZE}
      )
    `;
    totalDeleted += batchDeleted;
    // Safety cap: if we've deleted more than 1M rows in one prune call,
    // stop and let the next scheduled run continue.
    if (totalDeleted > 1_000_000) break;
  }

  return {
    cutoff: cutoff.toISOString(),
    deletedCount: totalDeleted,
    retentionDays,
  };
}

// ---------------------------------------------------------------------------
// PR-17 (production-readiness audit) — daily maintenance purges.
//
// The audit log was the only table with a retention story. Three more tables
// grow without bound and hold either garbage or derived state:
//
//   PasswordResetToken — expired (or long-used) tokens are pure garbage: the
//                        raw token was emailed once and is unusable. Kept 24h
//                        after use for incident forensics, then deleted.
//   Notification       — a notification the recipient has READ has done its
//                        job; 90 days later it is noise. Unread rows are NEVER
//                        purged (an unread badge must not silently vanish).
//   MessageRead        — read-state rows pointing at messages soft-deleted
//                        >90 days ago can never be rendered again.
//
// Deliberately NOT purged: Message bodies, TimeEntry, CalendarEvent, Reminder
// (workspace business data — deletion there is an owner decision, documented
// in docs/PRODUCTION_READINESS.md).
//
// All volumes are inherently bounded (reset requests are rate-limited to
// 5/email/h + 20/IP/h; notifications are per-action), so plain deleteMany is
// safe here — unlike the audit table, which needs the batched raw loop above.
// ---------------------------------------------------------------------------

/** How long a used reset token is kept after use (incident forensics). */
const RESET_TOKEN_USED_GRACE_MS = 24 * 60 * 60 * 1000;
/** Read notifications older than this are purged. */
const READ_NOTIFICATION_RETENTION_DAYS = 90;
/** Read-state rows of messages soft-deleted longer ago than this are purged. */
const STALE_MESSAGE_READ_RETENTION_DAYS = 90;

export interface MaintenanceResult extends PruneResult {
  /** Expired/used password-reset tokens deleted. */
  purgedResetTokens: number;
  /** Read notifications older than the retention window deleted. */
  purgedReadNotifications: number;
  /** Read-state rows of long-soft-deleted messages deleted. */
  purgedStaleMessageReads: number;
  /** Expired Better Auth session rows deleted (PR-48). */
  purgedExpiredSessions: number;
}

/**
 * The full daily maintenance pass: audit retention (above) + the PR-17
 * purges. The cron route calls this; failures in one purge do not abort the
 * others — each is wrapped so a wedged table can't block the rest.
 */
export async function runMaintenancePurge(
  actor: { userId: string; name: string; role: string } = CRON_ACTOR,
): Promise<MaintenanceResult> {
  const audit = await runAuditPrune(actor);

  const now = Date.now();
  const notifCutoff = new Date(now - READ_NOTIFICATION_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const readCutoff = new Date(now - STALE_MESSAGE_READ_RETENTION_DAYS * 24 * 60 * 60 * 1000);

  let purgedResetTokens = 0;
  let purgedReadNotifications = 0;
  let purgedStaleMessageReads = 0;
  let purgedExpiredSessions = 0;
  try {
    const r = await db.passwordResetToken.deleteMany({
      where: {
        OR: [
          { expiresAt: { lt: new Date(now) } },
          { usedAt: { lt: new Date(now - RESET_TOKEN_USED_GRACE_MS) } },
        ],
      },
    });
    purgedResetTokens = r.count;
  } catch (err) {
    // Counted as 0 — the next run retries. Never block the other purges.
    logWarn("[audit-prune] password-reset-token purge failed (counted as 0):", err);
  }
  try {
    // PR-48 — Better Auth sessions that expired without an explicit
    // sign-out (browser closed, cookie lost) linger as rows; sweep them so
    // the table stays bounded. Live sessions are untouched (expiresAt is
    // only in the past once the 7-day window elapsed).
    const r = await db.session.deleteMany({
      where: { expiresAt: { lt: new Date(now) } },
    });
    purgedExpiredSessions = r.count;
  } catch (err) {
    // see above — also 0 while the v4 stack runs (tables may be absent in
    // environments that never ran the Phase 1 migration).
    logWarn("[audit-prune] expired-session purge failed (counted as 0):", err);
  }
  try {
    const r = await db.notification.deleteMany({
      where: { read: true, createdAt: { lt: notifCutoff } },
    });
    purgedReadNotifications = r.count;
  } catch (err) {
    // see above
    logWarn("[audit-prune] read-notification purge failed (counted as 0):", err);
  }
  try {
    const r = await db.messageRead.deleteMany({
      where: { message: { deletedAt: { lt: readCutoff } } },
    });
    purgedStaleMessageReads = r.count;
  } catch (err) {
    // see above
    logWarn("[audit-prune] stale-message-read purge failed (counted as 0):", err);
  }

  return {
    ...audit,
    purgedResetTokens,
    purgedReadNotifications,
    purgedStaleMessageReads,
    purgedExpiredSessions,
  };
}
