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
// Launch gate 12 — the batched delete core moved to src/lib/audit/audit-prune-core.ts
// so the CRON_SECRET-protected /api/cron/prune-audit route can run it on a
// schedule without a user session; this action remains the admin-invocable
// path (Workspace Config) and keeps the role:manage gate.
//
// NOTE: "use server" file — only async functions can be exported. Constants
// + types live in src/lib/audit/audit-retention-config.ts.
// ---------------------------------------------------------------------------

import { db } from "@/lib/infra/db";
import { requirePermission } from "./auth-guard";
import { toResult } from "./result";
import type { ActionResult } from "@/lib/action-result";
import type { PruneResult } from "@/lib/audit/audit-retention-config";
import { runAuditPrune, clampRetentionDays } from "@/lib/audit/audit-prune-core";

export async function pruneAuditLogs(): Promise<ActionResult<PruneResult>> {
  return toResult(async () => {
    // Deep-dive review F-09 — role:manage, not audit:view.
    const auth = await requirePermission("role:manage");
    // The session auth object carries { userId, name, role, email } — a
    // structural superset of the actor shape runAuditPrune expects.
    return runAuditPrune(auth);
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
