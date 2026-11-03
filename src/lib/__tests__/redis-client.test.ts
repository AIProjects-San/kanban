import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Cover the lazy singleton + failure-path branches of redis-client.ts that the
// rate-limit-redis suite stubs out (it spies on getSharedRedisClient instead
// of exercising it). Without these tests src/lib/** drops to 89.97% statement
// coverage, 0.03% under the 90% CI gate — see vitest.config.ts thresholds.

// --- Mock ioredis default export (constructor + per-instance .on/.disconnect) ---
// Each test can swap the constructor behaviour via `__constructImpl`.
type MockRedisInstance = {
  on: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  emitError: (err: Error) => void;
};

let __lastInstance: MockRedisInstance | null = null;

const makeInstance = (): MockRedisInstance => {
  const handlers: Record<string, Array<(err: Error) => void>> = {};
  const on = vi.fn((event: string, cb: (err: Error) => void) => {
    (handlers[event] ??= []).push(cb);
  });
  const disconnect = vi.fn(() => {
    /* simulated close */
  });
  return {
    on,
    disconnect,
    emitError: (err: Error) => {
      (handlers["error"] ?? []).forEach((cb) => cb(err));
    },
  };
};

// Default impl: build a fresh instance, remember it, return it.
let __constructImpl: (
  url: string,
  opts?: Record<string, unknown>,
) => MockRedisInstance = () => {
  __lastInstance = makeInstance();
  return __lastInstance;
};

vi.mock("ioredis", () => ({
  default: class FakeRedis {
    constructor(url: string, opts?: Record<string, unknown>) {
      return __constructImpl(url, opts);
    }
  },
}));

// --- Mock observability.logError so the catch-path side effect is observable ---
const logErrorSpy = vi.fn();
vi.mock("@/lib/observability", () => ({
  logError: (...args: unknown[]) => logErrorSpy(...args),
}));

import {
  getSharedRedisClient,
  _resetSharedRedisClientForTests,
} from "@/lib/redis-client";

// Helper: the singleton returns RedisLike | undefined; tests need access to the
// .on/.disconnect surface to assert against the underlying mock instance.
const getClientMock = (url: string): MockRedisInstance | undefined =>
  getSharedRedisClient(url) as unknown as MockRedisInstance | undefined;

describe("redis-client (getSharedRedisClient singleton)", () => {
  beforeEach(() => {
    _resetSharedRedisClientForTests();
    __lastInstance = null;
    __constructImpl = () => {
      __lastInstance = makeInstance();
      return __lastInstance;
    };
    logErrorSpy.mockClear();
  });

  afterEach(() => {
    _resetSharedRedisClientForTests();
  });

  it("constructs and returns a client on the first call", () => {
    const client = getClientMock("redis://localhost:6379");
    expect(client).toBeDefined();
    expect(typeof client?.on).toBe("function");
    expect(typeof client?.disconnect).toBe("function");
    // construction wires up an error listener on the new client
    expect(__lastInstance?.on).toHaveBeenCalledWith("error", expect.any(Function));
  });

  it("returns the same singleton instance on subsequent calls", () => {
    const first = getClientMock("redis://localhost:6379");
    const second = getClientMock("redis://localhost:6379");
    expect(second).toBe(first);
  });

  it("passes the supplied URL and resilient options to the ioredis constructor", () => {
    const captured: Array<{ url: string; opts: Record<string, unknown> }> = [];
    __constructImpl = (url, opts) => {
      captured.push({ url, opts: opts ?? {} });
      __lastInstance = makeInstance();
      return __lastInstance;
    };
    getClientMock("redis://example:6380");
    expect(captured).toHaveLength(1);
    expect(captured[0].url).toBe("redis://example:6380");
    expect(captured[0].opts).toMatchObject({
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 2_000,
      keepAlive: 30_000,
      lazyConnect: false,
    });
    // retryStrategy is a function with the documented backoff shape
    const retry = captured[0].opts.retryStrategy as (t: number) => number;
    expect(typeof retry).toBe("function");
    expect(retry(1)).toBe(200);
    expect(retry(25)).toBe(5_000); // capped
  });

  it("logs (but does not throw) when the underlying client emits an error event", () => {
    getClientMock("redis://localhost:6379");
    expect(__lastInstance).not.toBeNull();
    __lastInstance!.emitError(new Error("ECONNREFUSED"));
    expect(logErrorSpy).toHaveBeenCalledTimes(1);
    expect(logErrorSpy).toHaveBeenCalledWith(
      "[redis] client error:",
      "ECONNREFUSED",
    );
  });

  it("returns undefined and sets constructionFailed when new Redis() throws", () => {
    __constructImpl = () => {
      throw new Error("bad url");
    };
    const client = getClientMock("redis://localhost:6379");
    expect(client).toBeUndefined();
    expect(logErrorSpy).toHaveBeenCalledTimes(1);
    expect(logErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("[redis] failed to construct the shared client"),
      "bad url",
    );
  });

  it("does not retry construction after a failure (returns undefined immediately)", () => {
    // First call: constructor throws.
    let throws = true;
    __constructImpl = () => {
      if (throws) throw new Error("first attempt fails");
      throw new Error("second attempt should never be reached");
    };
    expect(getClientMock("redis://localhost:6379")).toBeUndefined();
    // Second call: even if the constructor would now succeed, it must NOT be called.
    throws = false;
    expect(getClientMock("redis://localhost:6379")).toBeUndefined();
    // logError only fired once (from the first call) — the short-circuit on the
    // second call skips both the constructor and the catch block.
    expect(logErrorSpy).toHaveBeenCalledTimes(1);
  });
});

describe("redis-client (_resetSharedRedisClientForTests)", () => {
  beforeEach(() => {
    _resetSharedRedisClientForTests();
    __lastInstance = null;
    __constructImpl = () => {
      __lastInstance = makeInstance();
      return __lastInstance;
    };
    logErrorSpy.mockClear();
  });

  afterEach(() => {
    _resetSharedRedisClientForTests();
  });

  it("disconnects the existing singleton and allows a fresh client on next call", () => {
    const first = getClientMock("redis://localhost:6379");
    expect(first).toBeDefined();
    expect(__lastInstance).not.toBeNull();
    _resetSharedRedisClientForTests();
    // The previously held client was disconnected.
    expect(__lastInstance!.disconnect).toHaveBeenCalledTimes(1);
    // After reset, a new call constructs a brand-new instance.
    const second = getClientMock("redis://localhost:6379");
    expect(second).not.toBe(first);
  });

  it("is a no-op when no client has been constructed yet", () => {
    expect(() => _resetSharedRedisClientForTests()).not.toThrow();
    // And a fresh call still works.
    const client = getClientMock("redis://localhost:6379");
    expect(client).toBeDefined();
  });

  it("swallows disconnect errors when resetting (already-closed socket)", () => {
    getClientMock("redis://localhost:6379");
    expect(__lastInstance).not.toBeNull();
    // Make .disconnect throw — the reset path must catch and ignore it.
    __lastInstance!.disconnect.mockImplementation(() => {
      throw new Error("Connection is closed.");
    });
    expect(() => _resetSharedRedisClientForTests()).not.toThrow();
    // After reset, construction works again (state is clean).
    const client = getClientMock("redis://localhost:6379");
    expect(client).toBeDefined();
  });

  it("clears the constructionFailed flag so a previously-failing URL is retried", () => {
    // First call: constructor throws, flag is set.
    let throws = true;
    __constructImpl = () => {
      if (throws) throw new Error("transient");
      __lastInstance = makeInstance();
      return __lastInstance;
    };
    expect(getClientMock("redis://localhost:6379")).toBeUndefined();
    // Without reset, a second call short-circuits and returns undefined.
    expect(getClientMock("redis://localhost:6379")).toBeUndefined();
    // After reset, the flag is cleared — a healthy constructor is retried.
    throws = false;
    _resetSharedRedisClientForTests();
    const client = getClientMock("redis://localhost:6379");
    expect(client).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// PR-33 (production-readiness round 2) — Redis AUTH via REDIS_URL.
//
// docker-compose now defaults the app's REDIS_URL to
// `redis://:${REDIS_PASSWORD:-}@redis:6379`. With no password that renders
// as `redis://:@redis:6379` — these tests pin ioredis's ACTUAL URL-parser
// behaviour so the compose default can never silently start sending AUTH
// with an empty string (which a passwordless redis-server rejects):
//   • empty password → falsy → ioredis never issues AUTH
//   • real password  → parsed and used
// Uses the real parser (ioredis/built/utils), not the constructor mock.
// ---------------------------------------------------------------------------

describe("PR-33 REDIS_URL password parsing (real ioredis parseURL)", () => {
  it("an empty password slot (redis://:@host) stays falsy — no AUTH is sent", async () => {
    const utils = (await import("ioredis/built/utils")) as unknown as {
      parseURL: (url: string) => { password?: string; port: number | string; host: string };
    };
    const parsed = utils.parseURL("redis://:@redis:6379");
    expect(parsed.password ? parsed.password.length : 0).toBe(0);
    expect(parsed.host).toBe("redis");
    expect(String(parsed.port)).toBe("6379");
  });

  it("a set password slot (redis://:secret@host) is extracted verbatim", async () => {
    const utils = (await import("ioredis/built/utils")) as unknown as {
      parseURL: (url: string) => { password?: string };
    };
    const parsed = utils.parseURL("redis://:s3cret-pw@redis:6379");
    expect(parsed.password).toBe("s3cret-pw");
  });
});
