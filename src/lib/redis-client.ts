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

import Redis from "ioredis";
import type { RedisLike } from "./rate-limit-redis";

let sharedClient: Redis | null = null;
let constructionFailed = false;

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
      console.error("[redis] client error:", err.message);
    });
    return sharedClient;
  } catch (err) {
    constructionFailed = true;
    console.error(
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
