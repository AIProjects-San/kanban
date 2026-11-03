// SERVER-ONLY health probes shared by /api/health and /api/metrics
// (PR-32, production-readiness round 2 — the probes used to live inline in
// the health route; the new Prometheus endpoint needs the same signals, so
// they moved here unchanged).
//
//   probeDb()          — one cheap round trip (SELECT 1) behind a 2 s race
//                        timeout, so a wedged pool can't hang a probe.
//   probeRedis()       — "up" | "down" | "unconfigured". A down Redis does
//                        NOT fail the app (the rate limiter fails open) but
//                        operators need the degradation signal.
//   measureEventLoopLagMs() — setImmediate round-trip; the cheapest useful
//                        saturation signal for a single-threaded server.

import { logError, logWarn } from "@/lib/observability";
import { db } from "@/lib/db";

const DB_PROBE_TIMEOUT_MS = 2_000;
const REDIS_PROBE_TIMEOUT_MS = 1_000;

export async function probeDb(): Promise<boolean> {
  try {
    await Promise.race([
      db.$queryRaw`SELECT 1`,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("db probe timeout")), DB_PROBE_TIMEOUT_MS),
      ),
    ]);
    return true;
  } catch (err) {
    logError("[health] DB probe failed:", err);
    return false;
  }
}

export async function probeRedis(): Promise<"up" | "down" | "unconfigured"> {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) return "unconfigured";
  try {
    // Lazy-import so routes never pull ioredis into the bundle when
    // REDIS_URL is unset (e.g. dev environments, single-instance deploys).
    const { getSharedRedisClient } = await import("@/lib/redis-client");
    const client = getSharedRedisClient(redisUrl);
    if (!client) return "down";
    // ioredis exposes .ping(); the RedisLike minimal interface doesn't, so
    // cast — the shared client is always a real ioredis instance here.
    const result = await Promise.race([
      (client as unknown as { ping: () => Promise<string> }).ping(),
      new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error("redis probe timeout")), REDIS_PROBE_TIMEOUT_MS),
      ),
    ]);
    return result === "PONG" ? "up" : "down";
  } catch (err) {
    logWarn("[health] Redis probe failed (rate limiter is fail-open):", err);
    return "down";
  }
}

/**
 * Event-loop lag: how long a setImmediate callback waits behind whatever is
 * currently occupying the loop. Sub-millisecond on an idle server; grows
 * under CPU saturation or a blocked loop. Cheapest useful "is this instance
 * struggling" gauge — no perf_hooks dependency, one timer round trip.
 */
export function measureEventLoopLagMs(): Promise<number> {
  return new Promise((resolve) => {
    const start = Date.now();
    setImmediate(() => resolve(Date.now() - start));
  });
}
