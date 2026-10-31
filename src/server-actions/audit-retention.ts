"use server";

// ---------------------------------------------------------------------------
// L-P1-20 — Audit log retention.
//
// `pruneAuditLogs` deletes audit rows older than the configured retention
// window (Workspace.auditRetentionDays, default 180 days, clamped to a
// 30-day minimum). Deletes run in genuine 10k-row batches (raw SQL with a
// LIMIT — Prisma's deleteMany has no row cap, so the previous "batching"
// loop was a single unbounded transaction) with a 1M-row safety cap. Writes
// a self-documenting `audit.pruned` meta-row. `getAuditRetentionInfo`
// returns the retention config + a pg_class row-count estimate.
//
// Deep-dive review F-09 — three fixes:
//   • Permission raised from audit:view (which MANAGERs hold) to
//     role:manage — purging the audit trail is an admin action; letting a
//     MANAGER irreversibly delete history undermined the trail's purpose.
//   • Retention now reads Workspace.auditRetentionDays instead of
//     auditLogLimit (the UI display limit) — the conflation meant changing
//     how many rows the page shows silently changed how long logs live.
//   • Batching is real: DELETE ... WHERE id IN (SELECT id ... LIMIT 10000).
//
// NOTE: "use server" file — only async functions can be exported. Constants
// + types live in src/lib/audit-retention-config.ts.
// ---------------------------------------------------------------------------

import { db } from "@/lib/db";
import { requirePermission } from "./auth-guard";
import { logAudit } from "./shared";
import { toResult } from "./result";
import type { ActionResult } from "@/lib/action-result";
import {
  DEFAULT_AUDIT_RETENTION_DAYS,
  MIN_AUDIT_RETENTION_DAYS,
  type PruneResult,
} from "@/lib/audit-retention-config";

function clampRetentionDays(configured: number | undefined | null): number {
  if (!configured || configured <= 0) return DEFAULT_AUDIT_RETENTION_DAYS;
  return Math.max(configured, MIN_AUDIT_RETENTION_DAYS);
}

export async function pruneAuditLogs(): Promise<ActionResult<PruneResult>> {
  return toResult(async () => {
    // Deep-dive review F-09 — role:manage, not audit:view.
    const auth = await requirePermission("role:manage");

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
      actor: auth,
      action: "audit.pruned",
      entityType: "AUDIT",
      detail: `Pruned ${totalDeleted} audit rows older than ${cutoff.toISOString()} (retention: ${retentionDays} days)`,
    });

    return {
      cutoff: cutoff.toISOString(),
      deletedCount: totalDeleted,
      retentionDays,
    };
  });
}

export async function getAuditRetentionInfo(): Promise<ActionResult<{
  retentionDays: number;
  cutoff: string;
  estimatedRowCount: number;
}>> {
  return toResult(async () => {
    // Deep-dive review F-09 — role:manage (matches pruneAuditLogs).
    await requirePermission("role:manage");
    const workspace = await db.workspace.findUnique({
      where: { id: "default" },
      select: { auditRetentionDays: true },
    });
    const retentionDays = clampRetentionDays(workspace?.auditRetentionDays);
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
    const countResult = await db.$queryRaw<Array<{ estimate: number }>>`
      SELECT reltuples::bigint AS estimate FROM pg_class WHERE relname = 'AuditLog'
    `;
    const estimatedRowCount = countResult[0]?.estimate ?? 0;
    return {
      retentionDays,
      cutoff: cutoff.toISOString(),
      estimatedRowCount,
    };
  });
}
