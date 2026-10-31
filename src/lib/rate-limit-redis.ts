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
// `createLoginLimiter()` — factory that picks Redis when REDIS_URL + a
// redisClient are provided, falls back to the in-memory limiter otherwise.
// ---------------------------------------------------------------------------

import { SlidingWindowLimiter, type RateLimitState } from "./rate-limit";

// Minimal Redis client interface — satisfied by ioredis and node-redis
// (with adapter wrappers).
export interface RedisLike {
  zadd(key: string, score: number, member: string): Promise<number>;
  zremrangebyscore(key: string, min: number, max: number): Promise<number>;
  zcard(key: string): Promise<number>;
  zrangebyscore(key: string, min: number, max: number): Promise<string[]>;
  del(...keys: string[]): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
}

export interface RedisLimiterOptions {
  maxHits: number;
  windowMs: number;
  redis: RedisLike;
  keyPrefix?: string;
  progressiveDelayThreshold?: number;
  progressiveDelayMaxMs?: number;
}

export class RedisSlidingWindowLimiter {
  private readonly maxHits: number;
  private readonly windowMs: number;
  private readonly redis: RedisLike;
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

class RedisLimiterAdapter implements LimiterLike {
  private readonly inner: RedisSlidingWindowLimiter;
  constructor(inner: RedisSlidingWindowLimiter) {
    this.inner = inner;
  }
  check(key: string, now?: number): Promise<RateLimitState> {
    return this.inner.check(key, now);
  }
  hit(key: string, now?: number): Promise<RateLimitState> {
    return this.inner.hit(key, now);
  }
  reset(key: string): Promise<void> {
    return this.inner.reset(key);
  }
}

let cachedLoginLimiter: LimiterLike | null = null;

/**
 * Create (and cache) the login limiter. Picks Redis when `REDIS_URL` is set
 * AND a Redis client is provided; otherwise falls back to the in-memory
 * limiter with a warning.
 */
export function createLoginLimiter(opts?: {
  redisClient?: RedisLike;
  redisUrl?: string;
  maxHits?: number;
  windowMs?: number;
}): LimiterLike {
  if (cachedLoginLimiter) return cachedLoginLimiter;

  const maxHits = opts?.maxHits ?? 5; // LOGIN_MAX_ATTEMPTS
  const windowMs = opts?.windowMs ?? 15 * 60 * 1000; // LOGIN_WINDOW_MS
  const redisUrl = opts?.redisUrl ?? process.env.REDIS_URL;
  const redisClient = opts?.redisClient;

  if (redisUrl && redisClient) {
    const limiter = new RedisSlidingWindowLimiter({
      maxHits,
      windowMs,
      redis: redisClient,
      keyPrefix: "fernly:login:",
      progressiveDelayThreshold: 3,
      progressiveDelayMaxMs: 60_000,
    });
    cachedLoginLimiter = new RedisLimiterAdapter(limiter);
    console.info("[rate-limit] login limiter backed by Redis (shared across instances, L-P0-10)");
  } else {
    if (process.env.NODE_ENV === "production" && !redisUrl) {
      console.warn(
        "[rate-limit] REDIS_URL not set — falling back to in-memory login " +
        "limiter. In a multi-instance deployment this is a known gap (L-P0-10). " +
        "Set REDIS_URL and provide a Redis client to close it.",
      );
    }
    const inner = new SlidingWindowLimiter(maxHits, windowMs);
    cachedLoginLimiter = new InMemoryLimiterAdapter(inner);
  }
  return cachedLoginLimiter;
}

/** Test-only: reset the cached limiter so a new one is created on next call. */
export function _resetLoginLimiterCacheForTests(): void {
  cachedLoginLimiter = null;
}
