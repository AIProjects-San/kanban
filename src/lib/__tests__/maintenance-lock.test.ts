import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// PR-30 (production-readiness round 2) — cross-instance maintenance lock.
//
// Regression tests for the Redis SET NX PX lock that replaced the
// per-instance `lastRunAt` guard on /api/cron/prune-audit (roadmap §6.3):
//   • Redis path: first SET NX wins ("OK"), second within the TTL is
//     skipped (null), different keys/namespacing honoured.
//   • Fail-open: a Redis error degrades to the in-memory guard instead of
//     blocking maintenance forever.
//   • Memory path: the pre-PR-30 behaviour (per-instance window) still
//     works for single-instance deployments.
//   • recordMaintenanceRun / getMaintenanceLastRun round-trip (the
//     /api/metrics source for fernly_maintenance_last_run_*).
// ---------------------------------------------------------------------------

vi.mock("@/lib/observability", () => ({
  logWarn: vi.fn(),
  logInfo: vi.fn(),
  logError: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// The shared ioredis client must never be constructed in these tests —
// every case injects a fake or forces the memory path.
vi.mock("@/lib/redis-client", () => ({
  getSharedRedisClient: vi.fn(() => undefined),
  redisKeyPrefix: () => "app:",
  configInvalidationChannel: () => "app:config:invalidate",
  getSharedRedisPublisher: vi.fn(() => undefined),
  subscribeToConfigInvalidation: vi.fn(() => undefined),
}));

import {
  tryAcquireMaintenanceLock,
  recordMaintenanceRun,
  getMaintenanceLastRun,
  _resetMaintenanceLockForTests,
  MAINTENANCE_LOCK_KEY,
  MAINTENANCE_LAST_RUN_KEY,
  type LockRedis,
} from "@/lib/maintenance-lock";

function fakeRedis(behaviour: {
  setReply?: "OK" | null;
  setImpl?: LockRedis["set"];
  stored?: Map<string, string>;
  getImpl?: (key: string) => Promise<string | null>;
}): LockRedis {
  const stored = behaviour.stored ?? new Map<string, string>();
  return {
    set: behaviour.setImpl
      ? behaviour.setImpl
      : async (key, value) => {
          if (behaviour.setReply !== null && !stored.has(key)) {
            stored.set(key, value);
            return "OK" as const;
          }
          return null;
        },
    get: behaviour.getImpl ?? (async (key) => stored.get(key) ?? null),
  };
}

describe("maintenance lock (PR-30)", () => {
  beforeEach(() => {
    _resetMaintenanceLockForTests();
    delete process.env.REDIS_URL;
  });
  afterEach(() => {
    delete process.env.REDIS_URL;
  });

  it("acquires on the Redis path and reports the redis backend", async () => {
    const client = fakeRedis({});
    const res = await tryAcquireMaintenanceLock({ redisClient: client });
    expect(res).toEqual({ acquired: true, backend: "redis" });
  });

  it("skips (acquired=false) when another instance holds the lock", async () => {
    const client = fakeRedis({ setReply: null });
    const res = await tryAcquireMaintenanceLock({ redisClient: client });
    expect(res).toEqual({ acquired: false, backend: "redis" });
  });

  it("uses the namespaced lock key and the min-interval as TTL", async () => {
    const setImpl = vi.fn(
      async (_key: string, _value: string, _mode: "PX", _ttl: number, _nx: "NX") =>
        "OK" as const,
    );
    const client = fakeRedis({ setImpl });
    await tryAcquireMaintenanceLock({ redisClient: client, minIntervalMs: 3_600_000 });
    expect(setImpl).toHaveBeenCalledWith(
      MAINTENANCE_LOCK_KEY,
      expect.any(String),
      "PX",
      3_600_000,
      "NX",
    );
    expect(MAINTENANCE_LOCK_KEY).toBe("app:maintenance:lock");
  });

  it("fails open to the memory guard when Redis errors (and still acquires)", async () => {
    const client = fakeRedis({
      setImpl: async () => {
        throw new Error("connection refused");
      },
    });
    const res = await tryAcquireMaintenanceLock({ redisClient: client });
    // Fail-open: maintenance must not silently stop because Redis is down.
    expect(res).toEqual({ acquired: true, backend: "memory" });
    const { logWarn } = await import("@/lib/observability");
    expect(logWarn).toHaveBeenCalledWith(
      expect.stringContaining("Redis lock unavailable"),
      expect.objectContaining({ metric: "maintenance_lock_fail_open" }),
    );
  });

  it("memory backend keeps the one-hour window semantics", async () => {
    const now = Date.now();
    const first = await tryAcquireMaintenanceLock({ now });
    expect(first).toEqual({ acquired: true, backend: "memory" });
    const second = await tryAcquireMaintenanceLock({ now: now + 1_000 });
    expect(second).toEqual({ acquired: false, backend: "memory" });
    // After the window passes, a new run is allowed again.
    const third = await tryAcquireMaintenanceLock({ now: now + 3_600_001 });
    expect(third).toEqual({ acquired: true, backend: "memory" });
  });

  it("an instance that saw a Redis outage re-acquires after the memory window", async () => {
    const broken = fakeRedis({
      setImpl: async () => {
        throw new Error("down");
      },
    });
    const now = Date.now();
    await tryAcquireMaintenanceLock({ redisClient: broken, now });
    const again = await tryAcquireMaintenanceLock({ redisClient: broken, now: now + 60_000 });
    expect(again).toEqual({ acquired: false, backend: "memory" });
  });

  it("recordMaintenanceRun stores the ISO timestamp and getMaintenanceLastRun reads it", async () => {
    const stored = new Map<string, string>();
    const client = fakeRedis({ stored });
    const finishedAt = new Date("2026-11-03T03:00:00.000Z");
    await recordMaintenanceRun({ redisClient: client, finishedAt });
    expect(stored.get(MAINTENANCE_LAST_RUN_KEY)).toBe(finishedAt.toISOString());
    const read = await getMaintenanceLastRun({ redisClient: client });
    expect(read).toBe("2026-11-03T03:00:00.000Z");
  });

  it("recordMaintenanceRun swallows Redis errors (best-effort)", async () => {
    const client: LockRedis = {
      set: async () => {
        throw new Error("down");
      },
      get: async () => null,
    };
    await expect(
      recordMaintenanceRun({ redisClient: client }),
    ).resolves.toBeUndefined();
  });

  it("getMaintenanceLastRun returns null without a client / on error", async () => {
    expect(await getMaintenanceLastRun({ redisClient: null })).toBeNull();
    const broken: LockRedis = {
      set: async () => "OK",
      get: async () => {
        throw new Error("down");
      },
    };
    expect(await getMaintenanceLastRun({ redisClient: broken })).toBeNull();
  });

  // -------------------------------------------------------------------------
  // PR-56 — the no-injected-client resolution branches. Production callers
  // (the cron route) never pass redisClient; the functions must resolve the
  // shared client from REDIS_URL themselves, and degrade cleanly when the
  // shared-client factory returns undefined (construction failed).
  // -------------------------------------------------------------------------

  it("tryAcquireMaintenanceLock resolves the shared client from REDIS_URL (undefined → memory path)", async () => {
    process.env.REDIS_URL = "redis://localhost:6379";
    // The mocked getSharedRedisClient returns undefined → client null →
    // the in-memory one-hour guard applies (single-instance semantics).
    const now = Date.now();
    const first = await tryAcquireMaintenanceLock({ now });
    expect(first).toEqual({ acquired: true, backend: "memory" });
    const second = await tryAcquireMaintenanceLock({ now: now + 1_000 });
    expect(second).toEqual({ acquired: false, backend: "memory" });
  });

  it("recordMaintenanceRun without a client is a silent no-op (best-effort by design)", async () => {
    process.env.REDIS_URL = "redis://localhost:6379";
    await expect(recordMaintenanceRun()).resolves.toBeUndefined();
  });

  it("getMaintenanceLastRun returns null when no client can be resolved (no REDIS_URL)", async () => {
    delete process.env.REDIS_URL;
    expect(await getMaintenanceLastRun()).toBeNull();
  });

  it("getMaintenanceLastRun returns null when the shared client fails to construct", async () => {
    process.env.REDIS_URL = "redis://localhost:6379";
    // Mocked factory → undefined → null → metrics omit the field.
    expect(await getMaintenanceLastRun()).toBeNull();
  });
});
