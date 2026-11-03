import { describe, it, expect, vi, beforeEach } from "vitest";

// L-P0-10 — Redis-backed rate limiter tests, using a FakeRedis.

import {
  RedisSlidingWindowLimiter,
  createLoginLimiter,
  createPasswordResetLimiter,
  createClientErrorLimiter,
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
    // The Redis key namespace prefix is configurable via REDIS_KEY_PREFIX
    // so multiple apps can share one Redis instance. Set it explicitly here
    // so the assertion below stays deterministic regardless of test runner
    // env. Default when unset is `app:` (covered by the next test).
    process.env.REDIS_KEY_PREFIX = "fernly:";
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
    delete process.env.REDIS_KEY_PREFIX;
  });

  it("uses the `app:` default Redis key prefix when REDIS_KEY_PREFIX is unset", async () => {
    delete process.env.REDIS_KEY_PREFIX;
    const fakeRedis = new FakeRedis();
    const limiter = createLoginLimiter({
      redisClient: fakeRedis,
      redisUrl: "redis://localhost:6379",
      maxHits: 2,
      windowMs: 1000,
    });
    await limiter.hit("k1");
    await limiter.hit("k1");
    // Default prefix is `app:` so the key reads `app:login:k1`.
    expect(fakeRedis._inspect("app:login:k1").length).toBe(2);
    // And the legacy hardcoded `fernly:` prefix is NOT used.
    expect(fakeRedis._inspect("fernly:login:k1").length).toBe(0);
  });

  it("caches the limiter for the process lifetime", () => {
    const a = createLoginLimiter({});
    const b = createLoginLimiter({});
    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// Launch-crosscheck additions (deep-dive F-12 closure): the factory must
// auto-wire the shared ioredis client, and Redis outages must fail OPEN
// (logins stay possible; throttling degrades) instead of 500-ing every
// sign-in.
// ---------------------------------------------------------------------------

describe("fail-open behaviour when Redis errors (F-12 closure)", () => {
  beforeEach(() => {
    _resetLoginLimiterCacheForTests();
    vi.clearAllMocks();
  });

  it("returns not-blocked instead of throwing when Redis commands reject", async () => {
    const brokenRedis: RedisLike = {
      zadd: async () => { throw new Error("ECONNREFUSED"); },
      zremrangebyscore: async () => { throw new Error("ECONNREFUSED"); },
      zcard: async () => { throw new Error("ECONNREFUSED"); },
      zrangebyscore: async () => { throw new Error("ECONNREFUSED"); },
      del: async () => { throw new Error("ECONNREFUSED"); },
      expire: async () => { throw new Error("ECONNREFUSED"); },
    };
    const limiter = createLoginLimiter({
      redisClient: brokenRedis,
      redisUrl: "redis://broken:6379",
    });
    // Neither check nor hit may throw — a Redis outage must not 500 logins.
    const checked = await limiter.check("some-email");
    expect(checked.blocked).toBe(false);
    const hit = await limiter.hit("some-email");
    expect(hit.blocked).toBe(false);
    await expect(limiter.reset("some-email")).resolves.toBeUndefined();
  });

  it("degrades with at most one warning per 30s (no log spam)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const brokenRedis: RedisLike = {
      zadd: async () => { throw new Error("boom"); },
      zremrangebyscore: async () => { throw new Error("boom"); },
      zcard: async () => { throw new Error("boom"); },
      zrangebyscore: async () => { throw new Error("boom"); },
      del: async () => { throw new Error("boom"); },
      expire: async () => { throw new Error("boom"); },
    };
    const limiter = createLoginLimiter({
      redisClient: brokenRedis,
      redisUrl: "redis://broken:6379",
    });
    for (let i = 0; i < 10; i++) await limiter.check("k");
    expect(errSpy.mock.calls.filter((c) => String(c[0]).includes("UNTHROTTLED")).length).toBe(1);
    errSpy.mockRestore();
  });

  it("falls back to the in-memory limiter when client construction fails", async () => {
    const clientModule = await import("@/lib/redis-client");
    const failing = vi
      .spyOn(clientModule, "getSharedRedisClient")
      .mockReturnValue(undefined);
    try {
      const limiter = createLoginLimiter({ redisUrl: "redis://unreachable:6379" });
      // In-memory limiter still works (per-instance semantics).
      await limiter.hit("k2");
      await limiter.hit("k2");
      const state = await limiter.check("k2");
      expect(state.count).toBe(2);
    } finally {
      failing.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// PR-56 — the other two factory-built limiters had zero direct coverage:
//   • createPasswordResetLimiter (F-05) — 5/email/hour anti-bombing budget
//   • createClientErrorLimiter (PR-13) — 20/IP/5min ingestion budget
// Both share the login limiter's shape (Redis when wired, in-memory
// fallback, process-lifetime cache, fail-open) but distinct key namespaces.
// ---------------------------------------------------------------------------

describe("createPasswordResetLimiter factory (F-05)", () => {
  beforeEach(() => {
    _resetLoginLimiterCacheForTests();
    vi.clearAllMocks();
    delete process.env.REDIS_KEY_PREFIX;
  });

  it("returns the in-memory limiter when no Redis client is provided", async () => {
    const limiter = createPasswordResetLimiter({});
    await limiter.hit("victim@x.co");
    await limiter.hit("victim@x.co");
    const state = await limiter.check("victim@x.co");
    expect(state.count).toBe(2);
    expect(state.blocked).toBe(false);
  });

  it("wires the Redis limiter under the pwreset: namespace when a client is provided", async () => {
    const fakeRedis = new FakeRedis();
    const limiter = createPasswordResetLimiter({
      redisClient: fakeRedis,
      redisUrl: "redis://localhost:6379",
      maxHits: 5,
      windowMs: 1000,
    });
    for (let i = 0; i < 5; i++) await limiter.hit("victim@x.co");
    const state = await limiter.check("victim@x.co");
    expect(state.count).toBe(5);
    expect(state.blocked).toBe(true);
    // Namespaced under the app prefix + pwreset:, isolated from login keys.
    expect(fakeRedis._inspect("app:pwreset:victim@x.co").length).toBe(5);
    expect(fakeRedis._inspect("app:login:victim@x.co").length).toBe(0);
    // F-05 explicitly disables progressive delay (plain window).
    expect(state.retryAfterSec).toBeLessThanOrEqual(1);
  });

  it("caches the limiter for the process lifetime (independent of the login cache)", () => {
    const a = createPasswordResetLimiter({});
    const b = createPasswordResetLimiter({});
    expect(a).toBe(b);
    // And the login cache holds a DIFFERENT limiter instance.
    expect(createLoginLimiter({})).not.toBe(a);
  });
});

describe("createClientErrorLimiter factory (PR-13)", () => {
  beforeEach(() => {
    _resetLoginLimiterCacheForTests();
    vi.clearAllMocks();
    delete process.env.REDIS_KEY_PREFIX;
    delete process.env.REDIS_URL;
  });

  it("returns the in-memory limiter when no Redis client is provided", async () => {
    const limiter = createClientErrorLimiter({});
    await limiter.hit("203.0.113.9");
    const state = await limiter.check("203.0.113.9");
    expect(state.count).toBe(1);
    expect(state.blocked).toBe(false);
  });

  it("wires the Redis limiter under the clienterr: namespace when a client is provided", async () => {
    const fakeRedis = new FakeRedis();
    const limiter = createClientErrorLimiter({
      redisClient: fakeRedis,
      redisUrl: "redis://localhost:6379",
      maxHits: 20,
      windowMs: 1000,
    });
    for (let i = 0; i < 20; i++) await limiter.hit("203.0.113.9");
    const state = await limiter.check("203.0.113.9");
    expect(state.count).toBe(20);
    expect(state.blocked).toBe(true);
    expect(fakeRedis._inspect("app:clienterr:203.0.113.9").length).toBe(20);
  });

  it("fails open when Redis errors mid-flight (error reports are never 500s)", async () => {
    const brokenRedis: RedisLike = {
      zadd: async () => { throw new Error("ECONNREFUSED"); },
      zremrangebyscore: async () => { throw new Error("ECONNREFUSED"); },
      zcard: async () => { throw new Error("ECONNREFUSED"); },
      zrangebyscore: async () => { throw new Error("ECONNREFUSED"); },
      del: async () => { throw new Error("ECONNREFUSED"); },
      expire: async () => { throw new Error("ECONNREFUSED"); },
    };
    const limiter = createClientErrorLimiter({
      redisClient: brokenRedis,
      redisUrl: "redis://broken:6379",
    });
    const checked = await limiter.check("203.0.113.9");
    expect(checked.blocked).toBe(false);
    const hit = await limiter.hit("203.0.113.9");
    expect(hit.blocked).toBe(false);
  });

  it("caches the limiter for the process lifetime (independent of the other caches)", () => {
    const a = createClientErrorLimiter({});
    const b = createClientErrorLimiter({});
    expect(a).toBe(b);
    expect(createPasswordResetLimiter({})).not.toBe(a);
    expect(createLoginLimiter({})).not.toBe(a);
  });
});

// ---------------------------------------------------------------------------
// PR-56 — remaining adapter/warning branches:
//   • InMemoryLimiterAdapter.reset (L151) — never called by the factory tests
//   • the production no-REDIS_URL warning (L245-249) — only fires when
//     NODE_ENV=production, which the test env never is
// ---------------------------------------------------------------------------

describe("in-memory adapter + production warning (PR-56)", () => {
  beforeEach(() => {
    _resetLoginLimiterCacheForTests();
    vi.clearAllMocks();
    delete process.env.REDIS_URL;
    delete process.env.REDIS_KEY_PREFIX;
  });

  it("the in-memory limiter's reset clears the window (L151)", async () => {
    const limiter = createLoginLimiter({ maxHits: 2, windowMs: 60_000 });
    await limiter.hit("k");
    await limiter.hit("k");
    expect((await limiter.check("k")).count).toBe(2);
    await limiter.reset("k");
    expect((await limiter.check("k")).count).toBe(0);
  });

  it("warns (loudly, once) when production runs without REDIS_URL (L245-249)", () => {
    // The multi-instance gap warning must be visible to operators. logWarn
    // emits a JSON line via console.error — see structuredLog.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const prevNodeEnv = process.env.NODE_ENV;
    // @ts-expect-error — deliberately override the read-only env for the test
    process.env.NODE_ENV = "production";
    try {
      const limiter = createLoginLimiter({});
      // Still functional (single-instance semantics).
      expect(limiter).toBeDefined();
      const logged = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toContain("REDIS_URL not set");
      expect(logged).toContain("L-P0-10");
    } finally {
      // @ts-expect-error — restore
      process.env.NODE_ENV = prevNodeEnv;
      errSpy.mockRestore();
      _resetLoginLimiterCacheForTests();
    }
  });

  it("does NOT warn outside production when REDIS_URL is unset (dev default)", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      createLoginLimiter({});
      const logged = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).not.toContain("REDIS_URL not set");
    } finally {
      errSpy.mockRestore();
    }
  });
});
