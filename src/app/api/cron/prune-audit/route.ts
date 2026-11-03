import { NextResponse } from "next/server";
import { runMaintenancePurge } from "@/lib/audit-prune-core";
import { captureError } from "@/lib/observability";
import {
  tryAcquireMaintenanceLock,
  recordMaintenanceRun,
} from "@/lib/maintenance-lock";

// ---------------------------------------------------------------------------
// Audit-log retention cron endpoint — closes launch gate 12 ("audit
// retention job running with a demonstrated prune", maps to L-P1-20).
//
// The prune itself lives in src/server-actions/audit-retention.ts (admin-
// invocable, batched, floor of 30 days). This route makes it schedulable:
// any cron system (Kubernetes CronJob, system crontab, the docker-compose
// scheduler service) can call it once a day:
//
//   curl -fsS -H "Authorization: Bearer $CRON_SECRET" \
//        https://app.example.com/api/cron/prune-audit
//
// Security:
//   • Disabled unless CRON_SECRET is set (503 + no information beyond that).
//   • Requires a Bearer token that must match CRON_SECRET exactly
//     (constant-time comparison).
//   • Never returns audit contents — only the prune counters.
//   • Overlap guard (PR-30, production-readiness round 2): a run is
//     skipped when a maintenance pass ran within the last hour. The lock
//     is a Redis `SET NX PX` key shared by ALL instances (the roadmap
//     §6.3 item — previously the guard was per-instance module memory, so
//     with 2 replicas behind nginx the cron could trigger one run per
//     replica). Single-instance deployments (no REDIS_URL) keep the
//     in-memory guard; a Redis outage fails open to it (a duplicated run
//     beats silently stopping maintenance).
// ---------------------------------------------------------------------------

const MIN_INTERVAL_MS = 60 * 60 * 1_000; // 1 hour

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 16) return false;
  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  return token.length > 0 && timingSafeEqual(token, secret);
}

async function handle(req: Request): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 16) {
    // Not configured → the job is disabled. 503 (not 404) so a misconfigured
    // scheduler visibly fails instead of silently doing nothing.
    return NextResponse.json(
      { ok: false, error: "cron disabled (CRON_SECRET not set)" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (!authorized(req)) {
    return NextResponse.json(
      { ok: false, error: "unauthorized" },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  // PR-30 — cross-instance overlap guard (Redis SET NX PX when REDIS_URL
  // is set; in-memory per-instance guard otherwise). See maintenance-lock.
  const lock = await tryAcquireMaintenanceLock({ minIntervalMs: MIN_INTERVAL_MS });
  if (!lock.acquired) {
    return NextResponse.json(
      {
        ok: true,
        skipped: true,
        reason: `a maintenance pass ran less than ${Math.round(MIN_INTERVAL_MS / 60000)} minutes ago`,
        lockBackend: lock.backend,
      },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    // PR-17 — the daily pass is now full maintenance: audit retention PLUS
    // purges of expired password-reset tokens, read notifications and stale
    // message-read state (see audit-prune-core.ts).
    const data = await runMaintenancePurge();
    // PR-30 — publish the last-run timestamp for /api/metrics (best-effort;
    // omitted from metrics while Redis is down).
    await recordMaintenanceRun();
    return NextResponse.json(
      { ok: true, lockBackend: lock.backend, ...data },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    captureError(err, { route: "/api/cron/prune-audit" });
    return NextResponse.json(
      { ok: false, error: "prune failed" },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}

// Both verbs supported: Kubernetes CronJobs typically GET; system crontabs
// often POST. Both require the same bearer token.
export async function GET(req: Request) {
  return handle(req);
}
export async function POST(req: Request) {
  return handle(req);
}
