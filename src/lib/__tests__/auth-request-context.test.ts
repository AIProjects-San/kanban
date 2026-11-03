import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// PR-34 (production-readiness round 2) — the auth request-context bridge.
//
// NextAuth v4's signOut event exposes no request object, so the
// auth.signed_out audit row could not record IP/UA. The route handler now
// wraps every NextAuth request in an AsyncLocalStorage context; these tests
// pin the bridge semantics (isolation between concurrent requests, shared
// trusted-proxy IP extraction) that the audit row depends on.
// ---------------------------------------------------------------------------

import {
  runWithAuthRequestContext,
  getAuthRequestContext,
  extractClientIp,
} from "@/lib/auth-request-context";

describe("extractClientIp (trusted-proxy convention)", () => {
  it("prefers x-real-ip (set unconditionally by our edge proxy)", () => {
    const ip = extractClientIp(
      (n) =>
        ({
          "x-real-ip": "203.0.113.9",
          "x-forwarded-for": "1.2.3.4, 10.0.0.1",
        })[n] ?? null,
    );
    expect(ip).toBe("203.0.113.9");
  });

  it("falls back to the LAST x-forwarded-for hop (the trusted proxy's)", () => {
    // An attacker controlling the first hop must not choose their throttle
    // bucket: only the hop OUR proxy appended is trusted.
    const ip = extractClientIp((n) =>
      n === "x-forwarded-for" ? "6.6.6.6, 10.0.0.2" : null,
    );
    expect(ip).toBe("10.0.0.2");
  });

  it("ignores a client-supplied single-hop x-forwarded-for spoof… by using it only when it is all there is", () => {
    // Reality check: with NO trusted proxy in front (dev/preview), a lone
    // XFF hop is the only signal available — documented behaviour, and the
    // production edge always sets x-real-ip on top.
    const ip = extractClientIp((n) => (n === "x-forwarded-for" ? "198.51.100.7" : null));
    expect(ip).toBe("198.51.100.7");
  });

  it("returns 'unknown' when no proxy headers exist", () => {
    expect(extractClientIp(() => null)).toBe("unknown");
    expect(extractClientIp(() => "  ")).toBe("unknown");
  });

  it("trims whitespace around x-real-ip", () => {
    const ip = extractClientIp((n) => (n === "x-real-ip" ? "  203.0.113.10  " : null));
    expect(ip).toBe("203.0.113.10");
  });
});

describe("runWithAuthRequestContext (AsyncLocalStorage bridge)", () => {
  it("exposes the context inside the wrapped scope", async () => {
    await runWithAuthRequestContext({ ip: "203.0.113.1", userAgent: "vitest" }, async () => {
      expect(getAuthRequestContext()).toEqual({ ip: "203.0.113.1", userAgent: "vitest" });
    });
  });

  it("returns undefined outside any wrapped scope", async () => {
    expect(getAuthRequestContext()).toBeUndefined();
  });

  it("restores the outer scope after the inner one completes (no leakage)", async () => {
    await runWithAuthRequestContext({ ip: "outer", userAgent: "outer-ua" }, async () => {
      await runWithAuthRequestContext({ ip: "inner", userAgent: "inner-ua" }, async () => {
        expect(getAuthRequestContext()?.ip).toBe("inner");
      });
      expect(getAuthRequestContext()?.ip).toBe("outer");
    });
    expect(getAuthRequestContext()).toBeUndefined();
  });

  it("keeps concurrent requests isolated from each other", async () => {
    const seen: Record<string, string | undefined> = {};
    const run = (ip: string, delayMs: number) =>
      runWithAuthRequestContext({ ip, userAgent: `ua-${ip}` }, async () => {
        await new Promise((r) => setTimeout(r, delayMs));
        seen[ip] = getAuthRequestContext()?.ip;
      });
    await Promise.all([run("A", 20), run("B", 2), run("C", 10)]);
    expect(seen).toEqual({ A: "A", B: "B", C: "C" });
  });

  it("survives awaits inside the scope (the async chain keeps the context)", async () => {
    await runWithAuthRequestContext({ ip: "203.0.113.99", userAgent: "chain" }, async () => {
      await new Promise((r) => setTimeout(r, 5));
      await Promise.resolve();
      expect(getAuthRequestContext()?.ip).toBe("203.0.113.99");
    });
  });
});
