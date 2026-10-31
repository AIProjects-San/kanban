import { describe, it, expect, vi, beforeEach } from "vitest";

// L-P0-10 — Redis-backed rate limiter tests, using a FakeRedis.

import {
  RedisSlidingWindowLimiter,
  createLoginLimiter,
  _resetLoginLimiterCacheForTests,
  type RedisLike,
} from "@/lib/rate-limit-redis";

class FakeRedis implements RedisLike {
  private store = new Map<string, Array<{ score: number; member: string }>>();

  async zadd(key: string, score: number, member: string): Promise<number> {
    const set = this.store.get(key) ?? [];
    const existing = set.findIndex((e) => e.member === member);
    if (existing >= 0) {
      set[existing].score = score;
      this.store.set(key, set);
      return 0;
    }
    set.push({ score, member });
    this.store.set(key, set);
    return 1;
  }

  async zremrangebyscore(key: string, min: number, max: number): Promise<number> {
    const set = this.store.get(key);
    if (!set) return 0;
    const before = set.length;
    const kept = set.filter((e) => e.score < min || e.score > max);
    this.store.set(key, kept);
    return before - kept.length;
  }

  async zcard(key: string): Promise<number> {
    return this.store.get(key)?.length ?? 0;
  }

  async zrangebyscore(key: string, min: number, max: number): Promise<string[]> {
    const set = this.store.get(key);
    if (!set) return [];
    return set
      .filter((e) => e.score >= min && e.score <= max)
      .sort((a, b) => a.score - b.score)
      .map((e) => String(e.score));
  }

  async del(...keys: string[]): Promise<number> {
    let n = 0;
    for (const k of keys) {
      if (this.store.delete(k)) n++;
    }
    return n;
  }

  async expire(): Promise<number> {
    return 1;
  }

  _inspect(key: string): Array<{ score: number; member: string }> {
    return this.store.get(key) ?? [];
  }
}

describe("RedisSlidingWindowLimiter (L-P0-10)", () => {
  let redis: FakeRedis;
  let limiter: RedisSlidingWindowLimiter;

  beforeEach(() => {
    redis = new FakeRedis();
    limiter = new RedisSlidingWindowLimiter({
      maxHits: 3,
      windowMs: 1000,
      redis,
      keyPrefix: "test:",
      progressiveDelayThreshold: 0,
    });
  });

  it("check() returns { blocked: false, count: 0 } for a fresh key", async () => {
    const state = await limiter.check("k1");
    expect(state.blocked).toBe(false);
    expect(state.count).toBe(0);
    expect(state.retryAfterSec).toBe(0);
  });

  it("hit() increments the count and blocks after maxHits", async () => {
    await limiter.hit("k1");
    await limiter.hit("k1");
    const third = await limiter.hit("k1");
    expect(third.count).toBe(3);
    expect(third.blocked).toBe(true);
    expect(third.retryAfterSec).toBeGreaterThan(0);
  });

  it("check() reflects the count after hits", async () => {
    await limiter.hit("k1");
    await limiter.hit("k1");
    const state = await limiter.check("k1");
    expect(state.count).toBe(2);
    expect(state.blocked).toBe(false);
  });

  it("reset() clears the key", async () => {
    await limiter.hit("k1");
    await limiter.hit("k1");
    await limiter.reset("k1");
    const state = await limiter.check("k1");
    expect(state.count).toBe(0);
  });

  it("expires old timestamps outside the window (sliding window)", async () => {
    await limiter.hit("k1", 0);
    await limiter.hit("k1", 100);
    await limiter.hit("k1", 200);
    const afterWindow = await limiter.hit("k1", 1500);
    expect(afterWindow.count).toBe(1);
    expect(afterWindow.blocked).toBe(false);
  });

  it("shares state across limiter instances (the whole point of Redis)", async () => {
    const limiter2 = new RedisSlidingWindowLimiter({
      maxHits: 3, windowMs: 1000, redis, keyPrefix: "test:",
    });
    await limiter.hit("shared-key");
    await limiter.hit("shared-key");
    const state = await limiter2.check("shared-key");
    expect(state.count).toBe(2);
  });

  it("uses the keyPrefix to namespace keys in a shared Redis", async () => {
    await limiter.hit("k1");
    expect(redis._inspect("test:k1").length).toBe(1);
    expect(redis._inspect("k1").length).toBe(0);
  });
});

describe("RedisSlidingWindowLimiter progressive delay (L-P0-10)", () => {
  let redis: FakeRedis;
  let limiter: RedisSlidingWindowLimiter;

  beforeEach(() => {
    redis = new FakeRedis();
    limiter = new RedisSlidingWindowLimiter({
      maxHits: 3,
      windowMs: 1000,
      redis,
      keyPrefix: "test:",
      progressiveDelayThreshold: 3,
      progressiveDelayMaxMs: 60_000,
    });
  });

  it("does not apply backoff below the threshold", async () => {
    await limiter.hit("k1");
    await limiter.hit("k1");
    const third = await limiter.hit("k1");
    expect(third.blocked).toBe(true);
    expect(third.retryAfterSec).toBeLessThanOrEqual(1);
  });

  it("applies exponential backoff after the threshold", async () => {
    await limiter.hit("k1");
    await limiter.hit("k1");
    await limiter.hit("k1");
    const fourth = await limiter.hit("k1");
    expect(fourth.count).toBe(4);
    expect(fourth.blocked).toBe(true);
    expect(fourth.retryAfterSec).toBeGreaterThanOrEqual(2);
  });

  it("caps backoff at progressiveDelayMaxMs", async () => {
    for (let i = 0; i < 10; i++) {
      await limiter.hit("k1");
    }
    const state = await limiter.check("k1");
    expect(state.retryAfterSec).toBeLessThanOrEqual(61);
  });
});

describe("createLoginLimiter factory (L-P0-10)", () => {
  beforeEach(() => {
    _resetLoginLimiterCacheForTests();
    vi.clearAllMocks();
  });

  it("returns the in-memory limiter when no Redis client is provided", async () => {
    const limiter = createLoginLimiter({});
    const state = await limiter.check("any-key");
    expect(state.blocked).toBe(false);
    expect(state.count).toBe(0);
  });

  it("returns the Redis-backed limiter when a Redis client is provided", async () => {
    const fakeRedis = new FakeRedis();
    const limiter = createLoginLimiter({
      redisClient: fakeRedis,
      redisUrl: "redis://localhost:6379",
      maxHits: 2,
      windowMs: 1000,
    });
    await limiter.hit("k1");
    await limiter.hit("k1");
    const state = await limiter.check("k1");
    expect(state.count).toBe(2);
    expect(state.blocked).toBe(true);
    expect(fakeRedis._inspect("fernly:login:k1").length).toBe(2);
  });

  it("caches the limiter for the process lifetime", () => {
    const a = createLoginLimiter({});
    const b = createLoginLimiter({});
    expect(a).toBe(b);
  });
});
