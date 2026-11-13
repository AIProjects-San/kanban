import { NextResponse } from "next/server";
import { probeDb, probeRedis, measureEventLoopLagMs } from "@/lib/infra/health-probes";
import { getMaintenanceLastRun } from "@/lib/infra/maintenance-lock";

// ---------------------------------------------------------------------------
// Prometheus metrics endpoint — PR-32 (production-readiness round 2, roadmap
// §6.8: "no Prometheus /metrics endpoint").
//
// Exposes infrastructure + process gauges in the Prometheus text exposition
// format (version 0.0.4) so an operator can point a scrape job at:
//
//   scrape_configs:
//     - job_name: fernly
//       scheme: https
//       authorization: { credentials: "<CRON_SECRET>" }   # bearer token
//       metrics_path: /api/metrics
//       static_configs: [{ targets: ["app.example.com"] }]
//
// Security model (mirrors /api/cron/prune-audit):
//   • Disabled unless CRON_SECRET is set (503 + no detail) — a metrics
//     endpoint must not silently appear because a secret was misconfigured.
//   • Bearer token, constant-time compared, ≥16 chars.
//   • Never exposes user counts, emails, or any workspace/business data —
//     infrastructure signals only (db/redis reachability, process health,
//     maintenance freshness).
//
// What is deliberately NOT here: per-request counters/histograms. The proxy
// already emits `metric=http_request` structured log lines with status +
// durationMs, and log aggregation (or Sentry) covers request-level
// alerting; duplicating that into a per-instance in-memory counter would be
// wrong under multi-replica scraping anyway (counters reset per scrape
// target, so only a push gateway or shared store gives correct rates).
// This endpoint answers the questions a per-instance scrape CAN answer
// correctly: is this instance up, is its DB/Redis reachable, is it leaking
// memory, is its loop saturated, when did maintenance last succeed.
//
// Fail-open semantics: if the DB probe fails the endpoint still returns 200
// with `fernly_app_up 0` — a monitoring target that vanishes behind a 503
// is strictly harder to reason about than one that reports its own death.
// ---------------------------------------------------------------------------

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

/** Render one metric family in the Prometheus text format. */
function family(
  name: string,
  help: string,
  value: number | string,
  type: "gauge" | "counter" = "gauge",
): string {
  return `# HELP ${name} ${help}\n# TYPE ${name} ${type}\n${name} ${value}\n`;
}

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 16) {
    // Same contract as the cron endpoint: visibly disabled, no detail.
    return NextResponse.json(
      { ok: false, error: "metrics disabled (CRON_SECRET not set)" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (!authorized(req)) {
    return NextResponse.json(
      { ok: false, error: "unauthorized" },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  const [dbUp, redisStatus, eventLoopLagMs, lastRun] = await Promise.all([
    probeDb(),
    probeRedis(),
    measureEventLoopLagMs(),
    getMaintenanceLastRun(),
  ]);

  const mem = process.memoryUsage();
  const lines: string[] = [
    family(
      "fernly_app_up",
      "1 when this instance can reach its database (the app's own definition of up)",
      dbUp ? 1 : 0,
    ),
    family(
      "fernly_db_up",
      "1 when the database probe (SELECT 1) succeeded",
      dbUp ? 1 : 0,
    ),
  ];
  if (redisStatus !== "unconfigured") {
    lines.push(
      family(
        "fernly_redis_up",
        "1 when Redis (shared rate limiting) is reachable; 0 means fail-open degradation",
        redisStatus === "up" ? 1 : 0,
      ),
    );
  }
  if (lastRun) {
    const ts = Date.parse(lastRun);
    if (!Number.isNaN(ts)) {
      lines.push(
        family(
          "fernly_maintenance_last_run_timestamp_seconds",
          "Unix time of the last successful daily maintenance pass (audit retention + purges); alert when stale > 36h",
          (ts / 1000).toFixed(3),
        ),
      );
    }
  }
  lines.push(
    family(
      "fernly_process_uptime_seconds",
      "Seconds since this instance started (sudden resets = restarts/crash loops)",
      process.uptime().toFixed(3),
    ),
    family(
      "fernly_process_memory_resident_bytes",
      "Resident set size of the Node.js process",
      mem.rss,
    ),
    family(
      "fernly_process_memory_heap_used_bytes",
      "Used heap of the Node.js process (a monotonic climb across restarts = leak)",
      mem.heapUsed,
    ),
    family(
      "fernly_nodejs_eventloop_lag_ms",
      "setImmediate round-trip latency; grows under CPU saturation or a blocked loop",
      eventLoopLagMs,
    ),
  );

  return new NextResponse(lines.join(""), {
    status: 200,
    headers: {
      "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
