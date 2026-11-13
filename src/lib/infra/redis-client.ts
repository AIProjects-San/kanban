// SERVER-ONLY shared Redis client (deep-dive F-12 closure).
//
// The Redis-backed limiter (L-P0-10) existed and was tested, but nothing in
// the app ever constructed a client — `createLoginLimiter()` required one to
// be passed in, so multi-instance deployments silently ran per-instance
// in-memory limiters while docker-compose advertised a "shared Redis".
//
// This module owns the process-wide singleton:
//   • Constructed lazily, once, when REDIS_URL is set.
//   • ioredis connects in the background; the constructor returns instantly,
//     so the sync limiter factory is unaffected.
//   • `enableOfflineQueue: false` — limiter commands fail fast while the
//     connection is down instead of buffering (the limiter's fail-open
//     adapter handles those errors; a buffered throttle check would silently
//     delay every login by the reconnect time).
//   • `maxRetriesPerRequest: 1` — bounded retries, same reasoning.
//
// Never import this from a client component (it pulls in `net`/`tls`).

import { logError } from "@/lib/infra/observability";
import Redis from "ioredis";

/** Minimal Redis command surface the app's consumers need — satisfied by
 *  ioredis clients (and node-redis with adapter wrappers). Lives here, with
 *  the client it describes, so every consumer shares one shape; consumers
 *  that need less take a `Pick` of it. */
export interface RedisLike {
  zadd(key: string, score: number, member: string): Promise<number>;
  zremrangebyscore(key: string, min: number, max: number): Promise<number>;
  zcard(key: string): Promise<number>;
  zrangebyscore(key: string, min: number, max: number): Promise<string[]>;
  del(...keys: string[]): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  set(key: string, value: string): Promise<"OK" | null>;
  set(key: string, value: string, mode: "PX", ttlMs: number, nx: "NX"): Promise<"OK" | null>;
  get(key: string): Promise<string | null>;
  publish(channel: string, message: string): Promise<number>;
}

let sharedClient: Redis | null = null;
let constructionFailed = false;

/**
 * Redis key namespace prefix for ALL app keys (rate-limit buckets, the
 * maintenance lock, config-invalidation pub/sub). Read from
 * `REDIS_KEY_PREFIX` (env) so multiple apps — or multiple environments —
 * can share one Redis instance without colliding. Defaults to `app:`.
 *
 * PR-31 (production-readiness round 2) — moved here from rate-limit-redis
 * so every Redis consumer shares one namespacing rule. Always ends with `:`
 * so key segments read `app:login:k1` rather than `applogin:k1`.
 */
export function redisKeyPrefix(): string {
  const raw = process.env.REDIS_KEY_PREFIX;
  if (!raw) return "app:";
  return raw.endsWith(":") ? raw : `${raw}:`;
}

/**
 * Pub/sub channel used for instant cross-instance config-cache
 * invalidation (PR-31). Namespaced like every other key so shared Redis
 * instances don't cross-talk.
 */
export function configInvalidationChannel(): string {
  return `${redisKeyPrefix()}config:invalidate`;
}

/**
 * Get (or lazily create) the process-wide Redis client for rate limiting.
 * Returns `undefined` when construction previously failed — callers fall
 * back to the in-memory limiter rather than retrying on every request.
 */
export function getSharedRedisClient(redisUrl: string): RedisLike | undefined {
  if (constructionFailed) return undefined;
  if (sharedClient) return sharedClient;
  try {
    sharedClient = new Redis(redisUrl, {
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 2_000,
      keepAlive: 30_000,
      // Reconnect with capped backoff so a Redis restart doesn't spin the
      // event loop; the limiter runs fail-open meanwhile.
      retryStrategy: (times) => Math.min(times * 200, 5_000),
      lazyConnect: false,
    });
    sharedClient.on("error", (err: Error) => {
      // Logged but not thrown: the fail-open adapters surface degradation
      // through their own (rate-limited) warnings.
      logError("[redis] client error:", err.message);
    });
    return sharedClient;
  } catch (err) {
    constructionFailed = true;
    logError(
      "[redis] failed to construct the shared client — rate limiting falls " +
      "back to in-memory (single-instance semantics):",
      err instanceof Error ? err.message : err,
    );
    return undefined;
  }
}

/** Test-only: drop the singleton so a fresh client is built on next call. */
export function _resetSharedRedisClientForTests(): void {
  if (sharedClient) {
    try {
      sharedClient.disconnect();
    } catch {
      /* already closed */
    }
  }
  sharedClient = null;
  constructionFailed = false;
}

// ---------------------------------------------------------------------------
// PR-31 (production-readiness round 2) — config-cache invalidation pub/sub.
//
// Roadmap §6.10: an admin's config mutation is visible on instance A
// immediately (bumpConfigCache) but only on instance B after the 10 s TTL.
// For a security-relevant cache (the RBAC ceiling reads through it) that
// window was acceptable but not great. These helpers give config-loader
// instant cross-instance invalidation over Redis pub/sub:
//
//   • getSharedRedisPublisher() — PUBLISH on the shared command client.
//   • subscribeToConfigInvalidation() — a DEDICATED subscriber connection
//     (a connection in subscribe mode may not issue regular commands, so
//     it can never be the shared client) that invokes the callback on every
//     message and keeps its own error handling: a dead subscriber never
//     crashes the app, the 10 s TTL remains the backstop.
//
// Both are no-ops (undefined) when REDIS_URL is unset — single-instance
// deployments keep the pure in-memory behaviour.
// ---------------------------------------------------------------------------

/**
 * Get a publisher for the config-invalidation channel (the shared command
 * client), or undefined when Redis is not configured / construction failed.
 */
export function getSharedRedisPublisher(): Pick<RedisLike, "publish"> | undefined {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) return undefined;
  const client = getSharedRedisClient(redisUrl);
  if (!client) return undefined;
  return { publish: (channel, message) => client.publish(channel, message) };
}

let configSubscriber: Redis | null = null;

/**
 * Subscribe to the config-invalidation channel on a dedicated connection.
 * Returns an unsubscribe handle, or undefined when Redis is not configured.
 * Safe to call repeatedly — only the first call creates the connection.
 */
export function subscribeToConfigInvalidation(
  onMessage: (message: string) => void,
): { unsubscribe(): void } | undefined {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) return undefined;
  if (configSubscriber) {
    // Already subscribed — rebind the callback by storing it on the handle.
    return { unsubscribe: () => void configSubscriber?.unsubscribe(configInvalidationChannel()) };
  }
  try {
    const sub = new Redis(redisUrl, {
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 2_000,
      keepAlive: 30_000,
      retryStrategy: (times) => Math.min(times * 200, 5_000),
      lazyConnect: false,
    });
    sub.on("error", (err: Error) => {
      // A dead subscriber is not fatal: the 10 s config TTL remains the
      // invalidation backstop. Log (observability throttles noise upstream).
      logError("[redis] config-invalidation subscriber error:", err.message);
    });
    sub.on("message", (channel: string, message: string) => {
      if (channel === configInvalidationChannel()) {
        try {
          onMessage(message);
        } catch (err) {
          logError(
            "[redis] config-invalidation handler threw:",
            err instanceof Error ? err.message : err,
          );
        }
      }
    });
    // ioredis queues SUBSCRIBE once connected; failures surface via "error".
    void sub.subscribe(configInvalidationChannel()).catch(() => {
      /* retried by the reconnect strategy */
    });
    configSubscriber = sub;
    return {
      unsubscribe: () => {
        try {
          void configSubscriber?.unsubscribe(configInvalidationChannel());
        } catch {
          /* best-effort */
        }
      },
    };
  } catch (err) {
    logError(
      "[redis] failed to construct the config-invalidation subscriber:",
      err instanceof Error ? err.message : err,
    );
    return undefined;
  }
}

/** Test-only: drop the subscriber so a fresh one is created on next call. */
export function _resetConfigSubscriberForTests(): void {
  if (configSubscriber) {
    try {
      configSubscriber.disconnect();
    } catch {
      /* already closed */
    }
  }
  configSubscriber = null;
}
