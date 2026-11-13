// ---------------------------------------------------------------------------
// L-P0-10 — Redis-backed sliding-window rate limiter.
//
// `RedisSlidingWindowLimiter` — same API as the in-memory limiter but backed
// by Redis sorted sets, so throttling state is shared across ALL app
// instances. Accepts a `RedisLike` client interface (minimal sorted-set
// command subset satisfied by ioredis or node-redis with an adapter).
//
// Progressive delay: after `progressiveDelayThreshold` hits (default 3),
// each subsequent hit adds an exponential backoff window (2^excess seconds,
// capped at 60s) on top of the existing block.
//
// `createLoginLimiter()` — factory that picks Redis when `REDIS_URL` is set.
// Deep-dive F-12 closure: when no client is injected, the factory now
// constructs a real ioredis client itself (`getSharedRedisClient()`), so
// multi-instance deployments actually share the window — previously the
// Redis path existed but was unreachable because nothing ever built a
// client. Falls back to the in-memory limiter when REDIS_URL is unset.
// ---------------------------------------------------------------------------

import { logInfo, logWarn, log } from "@/lib/infra/observability";
import { LOGIN_MAX_ATTEMPTS, LOGIN_WINDOW_MS } from "@/lib/infra/rate-limit";
import { SlidingWindowLimiter, type RateLimitState } from "@/lib/infra/rate-limit";
import { getSharedRedisClient, redisKeyPrefix, type RedisLike } from "@/lib/infra/redis-client";

/** The sorted-set surface the limiter needs — a slice of the shared RedisLike. */
export type LimiterRedis = Pick<
  RedisLike,
  "zadd" | "zremrangebyscore" | "zcard" | "zrangebyscore" | "del" | "expire"
>;

export interface RedisLimiterOptions {
  maxHits: number;
  windowMs: number;
  redis: LimiterRedis;
  keyPrefix?: string;
  progressiveDelayThreshold?: number;
  progressiveDelayMaxMs?: number;
}

export class RedisSlidingWindowLimiter {
  private readonly maxHits: number;
  private readonly windowMs: number;
  private readonly redis: LimiterRedis;
  private readonly keyPrefix: string;
  private readonly progressiveDelayThreshold: number;
  private readonly progressiveDelayMaxMs: number;

  constructor(opts: RedisLimiterOptions) {
    this.maxHits = opts.maxHits;
    this.windowMs = opts.windowMs;
    this.redis = opts.redis;
    this.keyPrefix = opts.keyPrefix ?? "ratelimit:";
    this.progressiveDelayThreshold = opts.progressiveDelayThreshold ?? 3;
    this.progressiveDelayMaxMs = opts.progressiveDelayMaxMs ?? 60_000;
  }

  private redisKey(key: string): string {
    return `${this.keyPrefix}${key}`;
  }

  async check(key: string, now = Date.now()): Promise<RateLimitState> {
    const rkey = this.redisKey(key);
    const windowStart = now - this.windowMs;
    await this.redis.zremrangebyscore(rkey, 0, windowStart);
    const count = await this.redis.zcard(rkey);
    if (count >= this.maxHits) {
      const members = await this.redis.zrangebyscore(rkey, windowStart, now);
      const oldest = members.length > 0 ? Math.min(...members.map((m) => Number(m))) : now;
      const retryAfterMs = this.windowMs - (now - oldest);
      const backoffMs = this.progressiveBackoffMs(count);
      const totalRetryMs = Math.max(retryAfterMs, 0) + backoffMs;
      return {
        blocked: true,
        count,
        retryAfterSec: Math.max(1, Math.ceil(totalRetryMs / 1000)),
      };
    }
    return { blocked: false, count, retryAfterSec: 0 };
  }

  async hit(key: string, now = Date.now()): Promise<RateLimitState> {
    const rkey = this.redisKey(key);
    const windowStart = now - this.windowMs;
    await this.redis.zremrangebyscore(rkey, 0, windowStart);
    // Unique member suffix prevents collision for sub-millisecond hits.
    const member = `${now}:${Math.random().toString(36).slice(2, 10)}`;
    await this.redis.zadd(rkey, now, member);
    await this.redis.expire(rkey, Math.ceil((this.windowMs + this.progressiveDelayMaxMs) / 1000));
    const count = await this.redis.zcard(rkey);
    if (count >= this.maxHits) {
      const members = await this.redis.zrangebyscore(rkey, windowStart, now);
      const oldest = members.length > 0 ? Math.min(...members.map((m) => Number(m))) : now;
      const retryAfterMs = this.windowMs - (now - oldest);
      const backoffMs = this.progressiveBackoffMs(count);
      const totalRetryMs = Math.max(retryAfterMs, 0) + backoffMs;
      return {
        blocked: true,
        count,
        retryAfterSec: Math.max(1, Math.ceil(totalRetryMs / 1000)),
      };
    }
    return { blocked: false, count, retryAfterSec: 0 };
  }

  async reset(key: string): Promise<void> {
    await this.redis.del(this.redisKey(key));
  }

  /**
   * Progressive delay backoff: 0 below the threshold, then 2^(excess) seconds
   * capped at progressiveDelayMaxMs. Capped at 60s by default.
   */
  private progressiveBackoffMs(count: number): number {
    if (this.progressiveDelayThreshold <= 0 || count <= this.progressiveDelayThreshold) {
      return 0;
    }
    const excess = count - this.progressiveDelayThreshold;
    const backoffMs = Math.pow(2, excess) * 1000;
    return Math.min(backoffMs, this.progressiveDelayMaxMs);
  }
}

// ---------------------------------------------------------------------------
// Factory — pick Redis when REDIS_URL is set, fall back to in-memory.
// ---------------------------------------------------------------------------

export interface LimiterLike {
  check(key: string, now?: number): Promise<RateLimitState>;
  hit(key: string, now?: number): Promise<RateLimitState>;
  reset(key: string): Promise<void> | void;
}

class InMemoryLimiterAdapter implements LimiterLike {
  private readonly inner: SlidingWindowLimiter;
  constructor(inner: SlidingWindowLimiter) {
    this.inner = inner;
  }
  async check(key: string, now?: number): Promise<RateLimitState> {
    return this.inner.check(key, now);
  }
  async hit(key: string, now?: number): Promise<RateLimitState> {
    return this.inner.hit(key, now);
  }
  async reset(key: string): Promise<void> {
    this.inner.reset(key);
  }
}

/**
 * Fail-open adapter (deep-dive F-12 follow-up): if Redis errors mid-flight
 * (outage, restart, eviction storm) the limiter must not turn every login
 * into a 500. Brute-force protection degrades to "not throttled" for the
 * duration — bcrypt cost 12 still meters online attacks — and a loud
 * warning fires at most once per 30s so log spam cannot hide the signal.
 */
class FailOpenRedisLimiterAdapter implements LimiterLike {
  private readonly inner: RedisSlidingWindowLimiter;
  private readonly label: string;
  private lastWarnedAt = 0;
  constructor(inner: RedisSlidingWindowLimiter, label: string) {
    this.inner = inner;
    this.label = label;
  }
  private async guard<T>(op: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await op();
    } catch (err) {
      const now = Date.now();
      if (now - this.lastWarnedAt > 30_000) {
        this.lastWarnedAt = now;
        // P2 (production-readiness re-audit) — emit a structured `metric`
        // field so operators can alert on `metric=rate_limit_fail_open`. The
        // 30s throttle prevents log spam; the metric lets dashboards surface
        // "brute-force protection is degraded" without grepping message text.
        log.error(
          `[rate-limit] Redis unavailable — ${this.label} limiter running UNTHROTTLED (fail-open)`,
          {
            metric: "rate_limit_fail_open",
            limiter: this.label,
            error: err instanceof Error ? err.message : String(err),
          },
        );
      }
      return fallback;
    }
  }
  check(key: string, now?: number): Promise<RateLimitState> {
    return this.guard(() => this.inner.check(key, now), { blocked: false, count: 0, retryAfterSec: 0 });
  }
  hit(key: string, now?: number): Promise<RateLimitState> {
    return this.guard(() => this.inner.hit(key, now), { blocked: false, count: 0, retryAfterSec: 0 });
  }
  async reset(key: string): Promise<void> {
    try {
      await this.inner.reset(key);
    } catch {
      /* reset is best-effort */
    }
  }
}

let cachedLoginLimiter: LimiterLike | null = null;
let cachedPasswordResetLimiter: LimiterLike | null = null;
let cachedClientErrorLimiter: LimiterLike | null = null;

/**
 * Create (and cache) the login limiter. Picks Redis when `REDIS_URL` is set
 * AND a Redis client is provided; otherwise falls back to the in-memory
 * limiter with a warning.
 */
export function createLoginLimiter(opts?: {
  redisClient?: LimiterRedis;
  redisUrl?: string;
  maxHits?: number;
  windowMs?: number;
}): LimiterLike {
  if (cachedLoginLimiter) return cachedLoginLimiter;

  const maxHits = opts?.maxHits ?? LOGIN_MAX_ATTEMPTS;
  const windowMs = opts?.windowMs ?? LOGIN_WINDOW_MS;
  const redisUrl = opts?.redisUrl ?? process.env.REDIS_URL;
  // Deep-dive F-12 — when no client is injected, build the shared ioredis
  // client ourselves so the Redis path is actually reachable.
  const redisClient = opts?.redisClient ?? (redisUrl ? getSharedRedisClient(redisUrl) : undefined);

  if (redisUrl && redisClient) {
    const limiter = new RedisSlidingWindowLimiter({
      maxHits,
      windowMs,
      redis: redisClient,
      keyPrefix: `${redisKeyPrefix()}login:`,
      progressiveDelayThreshold: 3,
      progressiveDelayMaxMs: 60_000,
    });
    cachedLoginLimiter = new FailOpenRedisLimiterAdapter(limiter, "login");
    logInfo("[rate-limit] login limiter backed by Redis (shared across instances, L-P0-10)");
  } else {
    if (process.env.NODE_ENV === "production") {
      logWarn(
        "[rate-limit] REDIS_URL not set — falling back to in-memory login " +
        "limiter. In a multi-instance deployment this is a known gap (L-P0-10). " +
        "Set REDIS_URL to close it.",
      );
    }
    const inner = new SlidingWindowLimiter(maxHits, windowMs);
    cachedLoginLimiter = new InMemoryLimiterAdapter(inner);
  }
  return cachedLoginLimiter;
}

/**
 * Deep-dive review F-05 — rate limiter for the password-reset REQUEST
 * endpoint. The login endpoint was throttled but requestPasswordReset was
 * not, so an attacker could email-bomb a victim's inbox (each request also
 * invalidates the previous token, locking the user out of resetting) and
 * hammer the DB with token writes.
 *
 * Budget: 5 requests per email per hour, 20 per source IP per hour — enough
 * for a legitimate user who retries a few times, too tight for bombing.
 */
export function createPasswordResetLimiter(opts?: {
  redisClient?: LimiterRedis;
  redisUrl?: string;
  maxHits?: number;
  windowMs?: number;
}): LimiterLike {
  if (cachedPasswordResetLimiter) return cachedPasswordResetLimiter;

  const maxHits = opts?.maxHits ?? 5;
  const windowMs = opts?.windowMs ?? 60 * 60 * 1000; // 1 hour
  const redisUrl = opts?.redisUrl ?? process.env.REDIS_URL;
  const redisClient = opts?.redisClient ?? (redisUrl ? getSharedRedisClient(redisUrl) : undefined);

  if (redisUrl && redisClient) {
    const limiter = new RedisSlidingWindowLimiter({
      maxHits,
      windowMs,
      redis: redisClient,
      keyPrefix: `${redisKeyPrefix()}pwreset:`,
      progressiveDelayThreshold: 0, // no progressive delay — plain window
    });
    cachedPasswordResetLimiter = new FailOpenRedisLimiterAdapter(limiter, "password-reset");
  } else {
    const inner = new SlidingWindowLimiter(maxHits, windowMs);
    cachedPasswordResetLimiter = new InMemoryLimiterAdapter(inner);
  }
  return cachedPasswordResetLimiter;
}

/**
 * PR-13 (production-readiness audit) — rate limiter for the client-error
 * ingestion endpoint (/api/client-errors). The endpoint is unauthenticated
 * by design (error bridges must report before/without a session) and accepts
 * Origin-less probes (QA-9), so a scripted non-browser client could flood
 * the operator's error tracker with 8 KB payloads. Budget: 20 reports per
 * source IP per 5 minutes — far above what one browser tab can legitimately
 * produce (the bridge batches + dedupes), far below flood volume. Fail-open
 * on Redis outage like the other limiters: losing throttle here only means
 * noisier logs, never a broken app.
 */
export function createClientErrorLimiter(opts?: {
  redisClient?: LimiterRedis;
  redisUrl?: string;
  maxHits?: number;
  windowMs?: number;
}): LimiterLike {
  if (cachedClientErrorLimiter) return cachedClientErrorLimiter;

  const maxHits = opts?.maxHits ?? 20;
  const windowMs = opts?.windowMs ?? 5 * 60 * 1000; // 5 minutes
  const redisUrl = opts?.redisUrl ?? process.env.REDIS_URL;
  const redisClient = opts?.redisClient ?? (redisUrl ? getSharedRedisClient(redisUrl) : undefined);

  if (redisUrl && redisClient) {
    const limiter = new RedisSlidingWindowLimiter({
      maxHits,
      windowMs,
      redis: redisClient,
      keyPrefix: `${redisKeyPrefix()}clienterr:`,
      progressiveDelayThreshold: 0, // no progressive delay — plain window
    });
    cachedClientErrorLimiter = new FailOpenRedisLimiterAdapter(limiter, "client-errors");
  } else {
    const inner = new SlidingWindowLimiter(maxHits, windowMs);
    cachedClientErrorLimiter = new InMemoryLimiterAdapter(inner);
  }
  return cachedClientErrorLimiter;
}

/** Test-only: reset the cached limiters so new ones are created on next call. */
export function _resetLoginLimiterCacheForTests(): void {
  cachedLoginLimiter = null;
  cachedPasswordResetLimiter = null;
  cachedClientErrorLimiter = null;
}
