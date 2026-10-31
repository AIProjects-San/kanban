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
import { logAudit } from "@/server-actions/shared";
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

  await logAudit({
    actor,
    action: "audit.pruned",
    entityType: "AUDIT",
    detail: `Pruned ${totalDeleted} audit rows older than ${cutoff.toISOString()} (retention: ${retentionDays} days)`,
  });

  return {
    cutoff: cutoff.toISOString(),
    deletedCount: totalDeleted,
    retentionDays,
  };
}
