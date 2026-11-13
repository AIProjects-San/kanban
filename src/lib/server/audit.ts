// SERVER-ONLY audit-trail writer.
//
// Lives in lib so cron jobs and lib kernels (audit-prune-core, the payroll
// auto-drafts) can write audit rows without importing the action layer.

import { db } from "@/lib/db";
import { logError } from "@/lib/observability";
import type { AuditAction } from "@/lib/audit-meta";
import { extractClientIp } from "@/lib/client-ip";
import { headers as nextHeaders } from "next/headers";
import type { Prisma } from "@prisma/client";

export interface AuditEntry {
  actor: { userId: string; name: string; role: string };
  action: AuditAction;
  entityType: string;
  entityId?: string;
  entityLabel?: string;
  detail: string;
  /** Source IP + user agent for post-incident forensics. Callers inside a
   *  request context may pass them through; otherwise they are read from
   *  the headers if available. */
  ipAddress?: string;
  userAgent?: string;
}

/**
 * Read the client IP + user agent from the request context. Returns empty
 * fields outside a request context (tests, cron jobs) — never throws.
 * Uses the trusted-proxy convention (x-real-ip, else the LAST
 * x-forwarded-for hop) so a client cannot spoof its IP by prepending hops.
 */
export async function getClientInfo(): Promise<{ ip: string; userAgent: string }> {
  try {
    const h = await nextHeaders();
    const ip = extractClientIp((name) => h.get(name));
    const userAgent = (h.get("user-agent") ?? "").slice(0, 500) || "unknown";
    return { ip, userAgent };
  } catch {
    // headers() throws outside a request context — expected there.
    return { ip: "", userAgent: "" };
  }
}

type AuditClient = Pick<Prisma.TransactionClient, "auditLog">;

async function writeAuditRow(client: AuditClient, entry: AuditEntry): Promise<void> {
  await client.auditLog.create({
    data: {
      actorId: entry.actor.userId,
      actorName: entry.actor.name,
      actorRole: entry.actor.role,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? "",
      entityLabel: entry.entityLabel ?? "",
      detail: entry.detail,
      ...(entry.ipAddress !== undefined ? { ipAddress: entry.ipAddress } : {}),
      ...(entry.userAgent !== undefined ? { userAgent: entry.userAgent } : {}),
    },
  });
}

/** Write an audit row on the default client. Audit logging must never break
 *  the underlying operation, so failures are logged and swallowed. When the
 *  caller did not supply IP/UA and a request context exists, both are read
 *  from it (outside a request context the columns stay at their default). */
export async function logAudit(entry: AuditEntry): Promise<void> {
  try {
    if (entry.ipAddress === undefined && entry.userAgent === undefined) {
      const info = await getClientInfo();
      if (info.ip || info.userAgent) {
        return await writeAuditRow(db, {
          ...entry,
          ipAddress: info.ip || undefined,
          userAgent: info.userAgent || undefined,
        });
      }
    }
    await writeAuditRow(db, entry);
  } catch (err) {
    logError("[audit] failed to write log entry:", err);
  }
}

/** Write an audit row on a caller-supplied transaction client, so a business
 *  write and its audit trail land atomically. Failure semantics are the
 *  caller's choice: inside a transaction the throw should roll the business
 *  write back with it. */
export async function logAuditOn(client: AuditClient, entry: AuditEntry): Promise<void> {
  await writeAuditRow(client, entry);
}
