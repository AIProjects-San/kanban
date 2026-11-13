import { NextResponse } from "next/server";
import { probeDb, probeRedis } from "@/lib/infra/health-probes";

// ---------------------------------------------------------------------------
// Health & readiness endpoint — closes L-P0-4.
//
// Performs ONE cheap DB round trip (SELECT 1 via Prisma's $queryRaw) and
// returns 200 OK when the DB responds, 503 when it doesn't. Load balancers
// and orchestrators probe this to distinguish healthy instances from wedged
// ones (the old /api returned "Hello world").
//
// `/api/health`        — liveness + readiness (DB checked)
// `/api/health?ready=1`— same; kept for orchestrators that want a distinct URL
//
// The query is wrapped in Promise.race with a 2s timeout so a wedged DB
// pool can't hang the probe indefinitely (LBs typically time out at 5s).
//
// Redis probe (P1 — production-readiness re-audit): when `REDIS_URL` is set,
// we ALSO ping Redis and report `redis: "up"|"down"|"unconfigured"`. A down
// Redis does NOT fail the healthcheck — the rate limiter fails open, so the
// app still serves traffic — but operators need the signal that brute-force
// protection is degraded. The on-call runbook alerts on `redis: "down"`.
//
// PR-32 (production-readiness round 2) — the probe implementations moved to
// lib/infra/health-probes.ts so /api/metrics can share them; behaviour here is
// unchanged. Prometheus scraping uses /api/metrics, NOT this endpoint.
// ---------------------------------------------------------------------------

export async function GET(request: Request) {
  const url = new URL(request.url);
  const readiness = url.searchParams.get("ready") === "1";
  // P2 (production-readiness re-audit) — the `detail=1` query param gates
  // the detailed db/redis breakdown behind a shared secret. Without it, the
  // public endpoint returns only `{ status, timestamp }` so an unauthenticated
  // attacker can't probe when the DB is down. The secret is `CRON_SECRET`
  // (reused — operators already have it); pass `?detail=1` with
  // `Authorization: Bearer <CRON_SECRET>` for the full breakdown.
  const authHeader = request.headers.get("authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  const expectedToken = process.env.CRON_SECRET ?? "";
  // PR-12 (production-readiness audit) — constant-time comparison, mirroring
  // /api/cron/prune-audit. The previous `===` compare leaked (in theory) a
  // timing oracle on the secret; the length pre-check alone doesn't equalise
  // comparison time across matching lengths.
  const tokenEqualsExpected = (() => {
    if (token.length !== expectedToken.length) return false;
    let diff = 0;
    for (let i = 0; i < token.length; i++) diff |= token.charCodeAt(i) ^ expectedToken.charCodeAt(i);
    return diff === 0;
  })();
  const isAuthorized = expectedToken.length >= 16 && token.length > 0 && tokenEqualsExpected;
  const wantsDetail = url.searchParams.get("detail") === "1" && isAuthorized;

  const [dbUp, redisStatus] = await Promise.all([probeDb(), probeRedis()]);
  // The app is "down" only when the DB is unreachable. Redis being down
  // degrades rate limiting (fail-open) but the app still serves traffic.
  const ok = dbUp;

  // Public body — minimal. LBs only need the HTTP status code + status field.
  const body: Record<string, unknown> = {
    status: ok ? "ok" : "down",
    timestamp: new Date().toISOString(),
  };
  // Detailed body — only for authorized callers (operators, dashboards).
  if (wantsDetail) {
    body.db = dbUp ? "up" : "down";
    body.redis = redisStatus;
    body.readiness = readiness;
  }

  return NextResponse.json(body, {
    status: ok ? 200 : 503,
    headers: {
      // No caching — LBs must always get a fresh probe.
      "Cache-Control": "no-store, max-age=0",
    },
  });
}
