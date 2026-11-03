import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// PR-56 — direct unit tests for the health-probe helpers. The /api/health
// route suite covers probeDb + the "unconfigured"/"down" probeRedis paths
// through the route; the "up" path (a client that answers PONG) and
// measureEventLoopLagMs had no coverage at all.

vi.mock("@/lib/db", () => ({
  db: { $queryRaw: vi.fn() },
}));

const logErrorSpy = vi.fn();
const logWarnSpy = vi.fn();
vi.mock("@/lib/observability", () => ({
  logError: (...args: unknown[]) => logErrorSpy(...args),
  logWarn: (...args: unknown[]) => logWarnSpy(...args),
}));

import { probeDb, probeRedis, measureEventLoopLagMs } from "@/lib/health-probes";
import { db } from "@/lib/db";

const REDIS_URL_ORIGINAL = process.env.REDIS_URL;

describe("probeDb", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns true when SELECT 1 resolves", async () => {
    (db.$queryRaw as ReturnType<typeof vi.fn>).mockResolvedValue([{ "?column?": 1 }]);
    expect(await probeDb()).toBe(true);
  });

  it("returns false and logs when the query rejects", async () => {
    (db.$queryRaw as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("ECONNREFUSED"));
    expect(await probeDb()).toBe(false);
    expect(logErrorSpy).toHaveBeenCalledWith(
      "[health] DB probe failed:",
      expect.any(Error),
    );
  });

  it("returns false when the probe exceeds the 2s race timeout", async () => {
    // A wedged pool: the query neither resolves nor rejects within the race
    // window — the timeout arm must win and report down, not hang forever.
    (db.$queryRaw as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise(() => { /* never settles */ }),
    );
    const pending = probeDb();
    vi.advanceTimersByTime(2_100);
    expect(await pending).toBe(false);
  });
});

describe("probeRedis", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    delete process.env.REDIS_URL;
  });
  afterEach(async () => {
    if (REDIS_URL_ORIGINAL === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = REDIS_URL_ORIGINAL;
    vi.doUnmock("@/lib/redis-client");
    vi.resetModules();
  });

  it("returns 'unconfigured' when REDIS_URL is unset", async () => {
    expect(await probeRedis()).toBe("unconfigured");
  });

  it("returns 'up' when the shared client answers PONG", async () => {
    process.env.REDIS_URL = "redis://localhost:6379";
    vi.doMock("@/lib/redis-client", () => ({
      getSharedRedisClient: () => ({ ping: async () => "PONG" }),
    }));
    const { probeRedis: fresh } = await import("@/lib/health-probes");
    expect(await fresh()).toBe("up");
  });

  it("returns 'down' when the client answers something other than PONG", async () => {
    process.env.REDIS_URL = "redis://localhost:6379";
    vi.doMock("@/lib/redis-client", () => ({
      getSharedRedisClient: () => ({ ping: async () => "BUSY" }),
    }));
    const { probeRedis: fresh } = await import("@/lib/health-probes");
    expect(await fresh()).toBe("down");
  });

  it("returns 'down' when construction fails (no client)", async () => {
    process.env.REDIS_URL = "redis://localhost:6379";
    vi.doMock("@/lib/redis-client", () => ({
      getSharedRedisClient: () => undefined,
    }));
    const { probeRedis: fresh } = await import("@/lib/health-probes");
    expect(await fresh()).toBe("down");
  });

  it("returns 'down' (and logs) when ping throws", async () => {
    process.env.REDIS_URL = "redis://localhost:6379";
    vi.doMock("@/lib/redis-client", () => ({
      getSharedRedisClient: () => ({
        ping: async () => { throw new Error("Connection is closed."); },
      }),
    }));
    const { probeRedis: fresh } = await import("@/lib/health-probes");
    expect(await fresh()).toBe("down");
  });

  it("PR-56: returns 'down' when ping never settles within the 1s race timeout (L49)", async () => {
    // A wedged Redis that neither answers nor errors: the race's timeout
    // arm must win and report down instead of hanging the probe forever.
    // Runs on the REAL clock — the 1s probe timeout resolves comfortably
    // inside the 5s test budget, and faking the clock would stall the lazy
    // module import inside probeRedis.
    process.env.REDIS_URL = "redis://localhost:6379";
    vi.doMock("@/lib/redis-client", () => ({
      getSharedRedisClient: () => ({
        ping: () => new Promise<string>(() => { /* never settles */ }),
      }),
    }));
    const { probeRedis: fresh } = await import("@/lib/health-probes");
    const started = Date.now();
    expect(await fresh()).toBe("down");
    // The race's timeout arm fired — not the ping (which never settles).
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(elapsed).toBeLessThan(5_000);
  });
});

describe("measureEventLoopLagMs", () => {
  it("resolves to a non-negative number via a setImmediate round trip", async () => {
    const lag = await measureEventLoopLagMs();
    expect(typeof lag).toBe("number");
    expect(lag).toBeGreaterThanOrEqual(0);
    // A sub-second bound keeps the assertion meaningful without being flaky:
    // an idle jsdom event loop should return within a few ms.
    expect(lag).toBeLessThan(1_000);
  });
});
