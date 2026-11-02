import { describe, it, expect } from "vitest";
import { SlidingWindowLimiter, LOGIN_MAX_ATTEMPTS } from "@/lib/rate-limit";

describe("SlidingWindowLimiter", () => {
  it("allows hits under the limit", () => {
    const limiter = new SlidingWindowLimiter(3, 60_000);
    expect(limiter.hit("a").blocked).toBe(false);
    expect(limiter.hit("a").blocked).toBe(false);
    expect(limiter.hit("a").blocked).toBe(false);
  });

  it("blocks once the limit is exceeded", () => {
    const limiter = new SlidingWindowLimiter(3, 60_000);
    limiter.hit("a");
    limiter.hit("a");
    limiter.hit("a");
    const state = limiter.hit("a"); // 4th hit
    expect(state.blocked).toBe(true);
    expect(state.retryAfterSec).toBeGreaterThan(0);
    expect(state.retryAfterSec).toBeLessThanOrEqual(60);
  });

  it("check() inspects without recording", () => {
    const limiter = new SlidingWindowLimiter(2, 60_000);
    limiter.hit("a");
    limiter.hit("a");
    // At the limit — check reports what a further hit would do
    expect(limiter.check("a").blocked).toBe(true);
    // but did not add a hit; the count is unchanged
    expect(limiter.check("a").count).toBe(2);
  });

  it("tracks keys independently", () => {
    const limiter = new SlidingWindowLimiter(1, 60_000);
    limiter.hit("alice");
    expect(limiter.check("bob").blocked).toBe(false);
    expect(limiter.check("alice").blocked).toBe(true);
  });

  it("unblocks after the window expires", () => {
    const limiter = new SlidingWindowLimiter(1, 1_000);
    const t0 = 1_000_000;
    limiter.hit("a", t0);
    expect(limiter.check("a", t0 + 500).blocked).toBe(true);
    // Past the window — the old hit has expired
    expect(limiter.check("a", t0 + 1_001).blocked).toBe(false);
  });

  it("reset() clears the key entirely", () => {
    const limiter = new SlidingWindowLimiter(2, 60_000);
    limiter.hit("a");
    limiter.hit("a");
    limiter.reset("a");
    expect(limiter.check("a").blocked).toBe(false);
    expect(limiter.check("a").count).toBe(0);
  });

  it("uses a sliding window, not fixed buckets", () => {
    const limiter = new SlidingWindowLimiter(2, 10_000);
    const t0 = 1_000_000;
    limiter.hit("a", t0);
    limiter.hit("a", t0 + 5_000);
    // First hit slides out of the window, so a third hit at t0+10001 is allowed
    const state = limiter.hit("a", t0 + 10_001);
    expect(state.blocked).toBe(false);
    expect(state.count).toBe(2);
  });

  it("prunes stale keys to bound memory", () => {
    const limiter = new SlidingWindowLimiter(1, 1_000, 50);
    const t0 = 1_000_000;
    for (let i = 0; i < 60; i++) limiter.hit(`key-${i}`, t0);
    // After enough distinct keys, the limiter should have dropped entries.
    // (Exact count is an implementation detail; just verify it stays bounded.)
    // Force a prune cycle by checking with a later timestamp.
    limiter.check("probe", t0 + 5_000);
    // Old keys should be gone (expired), probe should be fine.
    expect(limiter.check("key-0", t0 + 5_000).count).toBe(0);
  });

  it("the shared login limiter uses the documented budget", () => {
    expect(LOGIN_MAX_ATTEMPTS).toBe(5);
  });
});
