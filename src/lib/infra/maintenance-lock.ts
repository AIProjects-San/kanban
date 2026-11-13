// SERVER-ONLY cross-instance maintenance lock (production-readiness round 2,
// PR-30 — closes roadmap item §6.3).
//
// The daily maintenance endpoint (/api/cron/prune-audit) used a module-level
// `lastRunAt` timestamp as its overlap guard. That guard is per-INSTANCE:
// with docker-compose `--scale fernly-1=2` and the cron calling through
// nginx (which round-robins), each replica kept its own timestamp, so the
// maintenance pass could run once per replica per trigger. The pass is
// idempotent and batched, so the cost was only a duplicated run — but the
// guarantee the comment claimed did not exist.
//
// This module implements the fix the roadmap called for: a Redis
// `SET key value NX PX <min-interval>` lock, shared by ALL instances.
// Whoever wins the SET owns the window; every other instance (including
// the winner's own second trigger) sees a null reply and skips. The key's
// TTL IS the min-interval — no release step, no stale-lock risk: if the
// winner crashes mid-run the lock simply expires and the next scheduled
// trigger retries.
//
// Degradation contract (mirrors the rate limiter):
//   • REDIS_URL unset            → in-memory per-instance guard (the old
//                                  behaviour — correct for single-instance).
//   • Redis error/outage         → fail-open to the in-memory guard, with a
//                                  rate-limited warning so ops can alert on
//                                  `metric=maintenance_lock_fail_open`.
//                                  Skipping maintenance because Redis is down
//                                  would be strictly worse (the purges would
//                                  silently stop).

import { logWarn, logInfo } from "@/lib/infra/observability";
import { getSharedRedisClient, redisKeyPrefix, type RedisLike } from "@/lib/infra/redis-client";

/** The Redis surface the lock needs — a slice of the shared RedisLike. */
export type LockRedis = Pick<RedisLike, "set" | "get">;

/** Redis key holding the cross-instance maintenance lock. */
export const MAINTENANCE_LOCK_KEY = `${redisKeyPrefix()}maintenance:lock`;
/** Redis key recording the last successful maintenance run (ISO string). */
export const MAINTENANCE_LAST_RUN_KEY = `${redisKeyPrefix()}maintenance:last_run`;
/** F2.4 — the leave-allocation job's OWN lock key (separate identity from
 * the audit purge's: one job's run must never suppress the other's). */
export const LEAVE_ALLOCATION_LOCK_KEY = `${redisKeyPrefix()}maintenance:leave_allocation`;
/** P25 (PL-02) — the engagement-reminders job's own lock identity (the
 * birthday/anniversary/holiday digests run beside the two above in the
 * scheduler's daily pass). */
export const EMPLOYEE_REMINDERS_LOCK_KEY = `${redisKeyPrefix()}maintenance:employee_reminders`;
/** P26 (PL-03/RJ-B18) — the interview-reminders job's own lock identity
 * (the day-of interviewer nudges; the fourth job the daily dispatcher
 * carries). Same discipline: one job's run never suppresses another's. */
export const INTERVIEW_REMINDERS_LOCK_KEY = `${redisKeyPrefix()}maintenance:interview_reminders`;
/** P31 (LV-J02/LV-09's remainder) — the encashment auto-draft job's own
 * lock identity (the benchmark's daily generate_leave_encashment; the
 * fifth job the daily dispatcher carries). Same discipline: one job's
 * run never suppresses another's. */
export const ENCASHMENT_AUTO_DRAFT_LOCK_KEY = `${redisKeyPrefix()}maintenance:encashment_auto_draft`;

export interface MaintenanceLockResult {
  acquired: boolean;
  /** Which backend decided — surfaced in the cron response for operators. */
  backend: "redis" | "memory";
}

// Fallback guard — the pre-PR-30 behaviour, still used when Redis is not
// configured (single-instance deployments) or unavailable (fail-open).
// Per-key map: the audit purge and the F2.4 leave-allocation job run on
// SEPARATE locks (same pattern, different windows) — one job's run must
// never suppress the other's.
const memoryLastRunAtByKey = new Map<string, number>();
let lastFailOpenWarnAt = 0;

/**
 * Try to acquire the cross-instance maintenance lock.
 *
 * @param opts.minIntervalMs how long a successful run suppresses further
 *   runs (the Redis lock TTL / the in-memory window). Default 1 hour.
 * @param opts.key the lock's identity — distinct jobs (audit purge, leave
 *   allocation) pass their own key so one job's run never suppresses the
 *   other's. Defaults to the shared maintenance key (pre-F2.4 callers).
 * @param opts.redisClient injectable for tests; defaults to the shared
 *   ioredis client when REDIS_URL is set.
 */
export async function tryAcquireMaintenanceLock(opts?: {
  minIntervalMs?: number;
  key?: string;
  redisClient?: LockRedis | null;
  redisUrl?: string;
  now?: number;
}): Promise<MaintenanceLockResult> {
  const minIntervalMs = opts?.minIntervalMs ?? 60 * 60 * 1_000;
  const now = opts?.now ?? Date.now();
  const key = opts?.key ?? MAINTENANCE_LOCK_KEY;

  const redisUrl = opts?.redisUrl ?? process.env.REDIS_URL;
  let client: LockRedis | null | undefined = opts?.redisClient;
  if (client === undefined) {
    if (!redisUrl) client = null;
    else client = getSharedRedisClient(redisUrl) ?? null;
  }

  if (client) {
    try {
      const reply = await client.set(
        key,
        `${process.pid}:${now}`,
        "PX",
        minIntervalMs,
        "NX",
      );
      return { acquired: reply === "OK", backend: "redis" };
    } catch (err) {
      // Fail-open (see header): fall through to the in-memory guard. The
      // warning is throttled to 30s so a Redis outage cannot spam the logs.
      if (now - lastFailOpenWarnAt > 30_000) {
        lastFailOpenWarnAt = now;
        logWarn(
          "[maintenance] Redis lock unavailable — falling back to the " +
            "per-instance in-memory guard (multi-instance dedup is degraded " +
            "for this run)",
          {
            metric: "maintenance_lock_fail_open",
            error: err instanceof Error ? err.message : String(err),
          },
        );
      }
    }
  }

  // In-memory guard (single-instance semantics).
  const memoryLastRunAt = memoryLastRunAtByKey.get(key) ?? 0;
  if (now - memoryLastRunAt < minIntervalMs) {
    return { acquired: false, backend: "memory" };
  }
  memoryLastRunAtByKey.set(key, now);
  return { acquired: true, backend: "memory" };
}

/**
 * Record a successful maintenance run: stamps the shared Redis timestamp
 * (read by /api/metrics as `fernly_maintenance_last_run_*`) and the
 * in-memory fallback. Fire-and-forget — a Redis failure here never fails
 * the (already successful) maintenance run.
 */
export async function recordMaintenanceRun(opts?: {
  redisClient?: LockRedis | null;
  redisUrl?: string;
  finishedAt?: Date;
}): Promise<void> {
  const finishedAt = opts?.finishedAt ?? new Date();

  const redisUrl = opts?.redisUrl ?? process.env.REDIS_URL;
  let client: LockRedis | null | undefined = opts?.redisClient;
  if (client === undefined) {
    if (!redisUrl) client = null;
    else client = getSharedRedisClient(redisUrl) ?? null;
  }
  if (client) {
    try {
      // Plain SET (no NX): every successful run overwrites the timestamp.
      // Interface note: LockRedis.set is the NX overload shape; ioredis
      // accepts the plain (key, value) form through the same call site, so
      // a narrow cast keeps the interface honest for the lock's usage.
      await (client as unknown as {
        set(key: string, value: string): Promise<"OK">;
      }).set(MAINTENANCE_LAST_RUN_KEY, finishedAt.toISOString());
      logInfo("[maintenance] last-run timestamp published to Redis");
    } catch {
      // Best-effort — metrics simply omit the field while Redis is down.
    }
  }
}

/** Read the last successful maintenance run (ISO string) — for /api/metrics. */
export async function getMaintenanceLastRun(opts?: {
  redisClient?: LockRedis | null;
  redisUrl?: string;
}): Promise<string | null> {
  const redisUrl = opts?.redisUrl ?? process.env.REDIS_URL;
  let client: LockRedis | null | undefined = opts?.redisClient;
  if (client === undefined) {
    if (!redisUrl) client = null;
    else client = getSharedRedisClient(redisUrl) ?? null;
  }
  if (!client) return null;
  try {
    return await client.get(MAINTENANCE_LAST_RUN_KEY);
  } catch {
    return null;
  }
}

/** Test-only: reset the in-memory fallback guards between test cases. */
export function _resetMaintenanceLockForTests(): void {
  memoryLastRunAtByKey.clear();
  lastFailOpenWarnAt = 0;
}
