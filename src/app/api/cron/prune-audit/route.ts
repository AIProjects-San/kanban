import { NextResponse } from "next/server";
import { runAuditPrune } from "@/lib/audit-prune-core";
import { captureError } from "@/lib/observability";

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
//   • One-shot guard: a run is skipped when another prune ran within the
//     last hour, so overlapping cron triggers cannot churn the table.
// ---------------------------------------------------------------------------

const MIN_INTERVAL_MS = 60 * 60 * 1_000; // 1 hour
let lastRunAt = 0;

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

  const now = Date.now();
  if (now - lastRunAt < MIN_INTERVAL_MS) {
    return NextResponse.json(
      { ok: true, skipped: true, reason: "a prune ran less than an hour ago" },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  }
  lastRunAt = now;

  try {
    const data = await runAuditPrune();
    return NextResponse.json(
      { ok: true, ...data },
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
