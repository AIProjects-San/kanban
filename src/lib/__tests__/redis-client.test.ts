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
  subscribe: ReturnType<typeof vi.fn>;
  unsubscribe: ReturnType<typeof vi.fn>;
  publish: ReturnType<typeof vi.fn>;
  emitError: (err: Error) => void;
  emitMessage: (channel: string, message: string) => void;
};

let __lastInstance: MockRedisInstance | null = null;

const makeInstance = (): MockRedisInstance => {
  // Handlers take (...args) so both "error" (err) and "message"
  // (channel, message) signatures share one bag.
  const handlers: Record<string, Array<(...args: unknown[]) => void>> = {};
  const on = vi.fn((event: string, cb: (...args: unknown[]) => void) => {
    (handlers[event] ??= []).push(cb);
  });
  const disconnect = vi.fn(() => {
    /* simulated close */
  });
  return {
    on,
    disconnect,
    subscribe: vi.fn(async () => 1),
    unsubscribe: vi.fn(async () => 1),
    publish: vi.fn(async () => 1),
    emitError: (err: Error) => {
      (handlers["error"] ?? []).forEach((cb) => cb(err));
    },
    emitMessage: (channel: string, message: string) => {
      (handlers["message"] ?? []).forEach((cb) => cb(channel, message));
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
  redisKeyPrefix,
  configInvalidationChannel,
  getSharedRedisPublisher,
  subscribeToConfigInvalidation,
  _resetConfigSubscriberForTests,
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

// ---------------------------------------------------------------------------
// PR-31 — key namespacing + the config-invalidation pub/sub surface
// (redisKeyPrefix, configInvalidationChannel, getSharedRedisPublisher,
// subscribeToConfigInvalidation, _resetConfigSubscriberForTests).
// ---------------------------------------------------------------------------

describe("redisKeyPrefix / configInvalidationChannel (PR-31)", () => {
  const ORIGINAL = process.env.REDIS_KEY_PREFIX;

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.REDIS_KEY_PREFIX;
    else process.env.REDIS_KEY_PREFIX = ORIGINAL;
  });

  it("defaults to `app:` when REDIS_KEY_PREFIX is unset", () => {
    delete process.env.REDIS_KEY_PREFIX;
    expect(redisKeyPrefix()).toBe("app:");
  });

  it("appends the trailing colon when the configured prefix lacks one", () => {
    process.env.REDIS_KEY_PREFIX = "staging";
    expect(redisKeyPrefix()).toBe("staging:");
  });

  it("keeps a prefix that already ends with a colon as-is", () => {
    process.env.REDIS_KEY_PREFIX = "prod:";
    expect(redisKeyPrefix()).toBe("prod:");
  });

  it("namespaces the config-invalidation channel with the current prefix", () => {
    process.env.REDIS_KEY_PREFIX = "prod:";
    expect(configInvalidationChannel()).toBe("prod:config:invalidate");
    delete process.env.REDIS_KEY_PREFIX;
    expect(configInvalidationChannel()).toBe("app:config:invalidate");
  });
});

describe("getSharedRedisPublisher (PR-31)", () => {
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
    delete process.env.REDIS_URL;
    _resetSharedRedisClientForTests();
  });

  it("returns undefined when REDIS_URL is unset", () => {
    delete process.env.REDIS_URL;
    expect(getSharedRedisPublisher()).toBeUndefined();
  });

  it("returns a publisher that delegates to the shared client", async () => {
    process.env.REDIS_URL = "redis://localhost:6379";
    const publisher = getSharedRedisPublisher();
    expect(publisher).toBeDefined();
    const received = await publisher!.publish("app:config:invalidate", "bumped");
    expect(received).toBe(1);
    expect(__lastInstance?.publish).toHaveBeenCalledWith(
      "app:config:invalidate",
      "bumped",
    );
  });

  it("returns undefined when the shared client failed to construct", () => {
    process.env.REDIS_URL = "redis://localhost:6379";
    __constructImpl = () => {
      throw new Error("bad url");
    };
    expect(getSharedRedisPublisher()).toBeUndefined();
  });
});

describe("subscribeToConfigInvalidation (PR-31)", () => {
  beforeEach(() => {
    _resetConfigSubscriberForTests();
    _resetSharedRedisClientForTests();
    __lastInstance = null;
    __constructImpl = () => {
      __lastInstance = makeInstance();
      return __lastInstance;
    };
    logErrorSpy.mockClear();
    process.env.REDIS_URL = "redis://localhost:6379";
  });

  afterEach(() => {
    _resetConfigSubscriberForTests();
    delete process.env.REDIS_URL;
  });

  it("returns undefined when REDIS_URL is unset", () => {
    delete process.env.REDIS_URL;
    expect(subscribeToConfigInvalidation(() => {})).toBeUndefined();
  });

  it("creates a dedicated subscriber and subscribes to the namespaced channel", () => {
    const handle = subscribeToConfigInvalidation(() => {});
    expect(handle).toBeDefined();
    // A DEDICATED connection is created (never the shared command client).
    expect(__lastInstance).not.toBeNull();
    expect(__lastInstance!.subscribe).toHaveBeenCalledWith("app:config:invalidate");
    expect(__lastInstance!.on).toHaveBeenCalledWith("error", expect.any(Function));
    expect(__lastInstance!.on).toHaveBeenCalledWith("message", expect.any(Function));
  });

  it("PR-56: the subscriber's retryStrategy is a capped linear backoff (L166)", () => {
    // Same resilient options as the shared client: 200ms per retry, capped
    // at 5s, so a Redis restart can't spin the event loop.
    let capturedOpts: Record<string, unknown> | null = null;
    __constructImpl = (_url: string, opts?: Record<string, unknown>) => {
      capturedOpts = opts ?? {};
      __lastInstance = makeInstance();
      return __lastInstance;
    };
    subscribeToConfigInvalidation(() => {});
    const opts = capturedOpts as { retryStrategy?: (t: number) => number } | null;
    expect(typeof opts?.retryStrategy).toBe("function");
    expect(opts!.retryStrategy!(1)).toBe(200);
    expect(opts!.retryStrategy!(25)).toBe(5_000); // capped
    expect(opts!.retryStrategy!(1_000)).toBe(5_000);
  });

  it("invokes the callback only for messages on the config channel", () => {
    const onMessage = vi.fn();
    subscribeToConfigInvalidation(onMessage);
    __lastInstance!.emitMessage("app:config:invalidate", "bumped");
    expect(onMessage).toHaveBeenCalledWith("bumped");
    // A different channel is ignored — the subscriber connection may see
    // other traffic on a shared Redis.
    __lastInstance!.emitMessage("other:channel", "noise");
    expect(onMessage).toHaveBeenCalledTimes(1);
  });

  it("survives a throwing callback (the 10s TTL remains the backstop)", () => {
    const boom = vi.fn(() => {
      throw new Error("handler bug");
    });
    subscribeToConfigInvalidation(boom);
    expect(() =>
      __lastInstance!.emitMessage("app:config:invalidate", "bumped"),
    ).not.toThrow();
    expect(boom).toHaveBeenCalledTimes(1);
    expect(logErrorSpy).toHaveBeenCalledWith(
      "[redis] config-invalidation handler threw:",
      "handler bug",
    );
  });

  it("logs but does not throw when the subscriber connection errors", () => {
    subscribeToConfigInvalidation(() => {});
    expect(() =>
      __lastInstance!.emitError(new Error("ECONNRESET")),
    ).not.toThrow();
    expect(logErrorSpy).toHaveBeenCalledWith(
      "[redis] config-invalidation subscriber error:",
      "ECONNRESET",
    );
  });

  it("reuses the existing subscriber on repeat calls (unsubscribe handle per call)", () => {
    const first = subscribeToConfigInvalidation(() => {});
    const constructedHere = __lastInstance;
    const second = subscribeToConfigInvalidation(() => {});
    expect(second).toBeDefined();
    expect(first).not.toBe(second); // distinct handles
    // No second connection was constructed.
    expect(__lastInstance).toBe(constructedHere);
    expect(constructedHere!.subscribe).toHaveBeenCalledTimes(1);
    // Both handles unsubscribe the same dedicated connection.
    second!.unsubscribe();
    expect(constructedHere!.unsubscribe).toHaveBeenCalledWith("app:config:invalidate");
  });

  it("returns undefined when the subscriber constructor throws", () => {
    __constructImpl = () => {
      throw new Error("cannot construct");
    };
    expect(subscribeToConfigInvalidation(() => {})).toBeUndefined();
    expect(logErrorSpy).toHaveBeenCalledWith(
      "[redis] failed to construct the config-invalidation subscriber:",
      "cannot construct",
    );
  });

  it("the unsubscribe handle swallows a throwing unsubscribe (best-effort)", () => {
    const handle = subscribeToConfigInvalidation(() => {});
    __lastInstance!.unsubscribe.mockImplementation(() => {
      throw new Error("already closed");
    });
    expect(() => handle!.unsubscribe()).not.toThrow();
  });
});

describe("_resetConfigSubscriberForTests", () => {
  beforeEach(() => {
    _resetConfigSubscriberForTests();
    __lastInstance = null;
    __constructImpl = () => {
      __lastInstance = makeInstance();
      return __lastInstance;
    };
    process.env.REDIS_URL = "redis://localhost:6379";
  });

  afterEach(() => {
    _resetConfigSubscriberForTests();
    delete process.env.REDIS_URL;
  });

  it("disconnects the existing subscriber and allows a fresh one on next call", () => {
    subscribeToConfigInvalidation(() => {});
    const first = __lastInstance!;
    _resetConfigSubscriberForTests();
    expect(first.disconnect).toHaveBeenCalledTimes(1);
    // Next call constructs a brand-new dedicated connection.
    subscribeToConfigInvalidation(() => {});
    expect(__lastInstance!).not.toBe(first);
  });

  it("is a no-op when no subscriber exists", () => {
    expect(() => _resetConfigSubscriberForTests()).not.toThrow();
    // And subscribing still works afterwards.
    expect(subscribeToConfigInvalidation(() => {})).toBeDefined();
  });

  it("swallows disconnect errors when resetting (already-closed socket)", () => {
    subscribeToConfigInvalidation(() => {});
    __lastInstance!.disconnect.mockImplementation(() => {
      throw new Error("Connection is closed.");
    });
    expect(() => _resetConfigSubscriberForTests()).not.toThrow();
  });
});
