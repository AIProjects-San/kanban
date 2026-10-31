"use server";

// ---------------------------------------------------------------------------
// L-P1-20 — Audit log retention.
//
// `pruneAuditLogs` deletes audit rows older than the configured retention
// window (default 180 days, clamped to a 30-day minimum). Batches deletes in
// 10k-row chunks with a 1M-row safety cap. Writes a self-documenting
// `audit.pruned` meta-row. `getAuditRetentionInfo` returns the retention
// config + a pg_class row-count estimate.
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
    const auth = await requirePermission("audit:view");

    const workspace = await db.workspace.findUnique({
      where: { id: "default" },
      select: { auditLogLimit: true },
    });
    const retentionDays = clampRetentionDays(workspace?.auditLogLimit);
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

    const BATCH_SIZE = 10_000;
    let totalDeleted = 0;
    let batchDeleted = BATCH_SIZE;
    while (batchDeleted === BATCH_SIZE) {
      const result = await db.auditLog.deleteMany({
        where: { createdAt: { lt: cutoff } },
      });
      batchDeleted = result.count;
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
    await requirePermission("audit:view");
    const workspace = await db.workspace.findUnique({
      where: { id: "default" },
      select: { auditLogLimit: true },
    });
    const retentionDays = clampRetentionDays(workspace?.auditLogLimit);
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
