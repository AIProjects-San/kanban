// ---------------------------------------------------------------------------
// In-memory sliding-window rate limiter.
//
// Good enough for single-instance deployments (the current Fernly topology).
// If the app is ever scaled horizontally, swap this for a shared store
// (Redis, Upstash, …) — the API below is intentionally store-agnostic.
// ---------------------------------------------------------------------------

export interface RateLimitState {
  /** true if the key is currently over the limit */
  blocked: boolean;
  /** hits recorded inside the current window */
  count: number;
  /** seconds until the key is unblocked (0 when not blocked) */
  retryAfterSec: number;
}

export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    /** max hits allowed per window before the key is blocked */
    private readonly maxHits: number,
    /** window length in milliseconds */
    private readonly windowMs: number,
    /** guard against unbounded memory growth from unique keys */
    private readonly maxKeys = 10_000,
  ) {}

  private pruneExpired(now: number): void {
    for (const [key, stamps] of this.hits) {
      const live = stamps.filter((t) => now - t < this.windowMs);
      if (live.length === 0) this.hits.delete(key);
      else if (live.length !== stamps.length) this.hits.set(key, live);
    }
    // Hard cap: if we've accumulated too many keys (attack spray), drop the
    // oldest half to bound memory. Map preserves insertion order.
    if (this.hits.size > this.maxKeys) {
      const keys = Array.from(this.hits.keys());
      for (const k of keys.slice(0, Math.floor(keys.length / 2))) {
        this.hits.delete(k);
      }
    }
  }

  private window(key: string, now: number): number[] {
    const stamps = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    this.hits.set(key, stamps);
    return stamps;
  }

  /** Inspect a key WITHOUT recording a hit. */
  check(key: string, now = Date.now()): RateLimitState {
    this.pruneExpired(now);
    const stamps = this.window(key, now);
    const count = stamps.length;
    if (count >= this.maxHits) {
      const oldest = Math.min(...stamps);
      const retryAfterMs = this.windowMs - (now - oldest);
      return { blocked: true, count, retryAfterSec: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
    }
    return { blocked: false, count, retryAfterSec: 0 };
  }

  /** Record a hit. Returns the state AFTER recording. */
  hit(key: string, now = Date.now()): RateLimitState {
    this.pruneExpired(now);
    const stamps = this.window(key, now);
    stamps.push(now);
    this.hits.set(key, stamps);
    const count = stamps.length;
    if (count > this.maxHits) {
      const oldest = Math.min(...stamps);
      const retryAfterMs = this.windowMs - (now - oldest);
      return { blocked: true, count, retryAfterSec: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
    }
    return { blocked: false, count, retryAfterSec: 0 };
  }

  /** Clear a key (e.g. after a successful login for that identity). */
  reset(key: string): void {
    this.hits.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Login throttling — shared instance used by the credentials provider.
// 5 failed attempts per email OR per IP within 15 minutes.
// ---------------------------------------------------------------------------

export const LOGIN_MAX_ATTEMPTS = 5;
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;

export const loginLimiter = new SlidingWindowLimiter(LOGIN_MAX_ATTEMPTS, LOGIN_WINDOW_MS);
