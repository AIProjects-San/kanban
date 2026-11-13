import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// extractClientIp — the trusted-proxy convention shared by the sign-in
// throttle (email + IP budgets), the auth audit rows, and Better Auth's
// own ipAddress config. Ported from auth-request-context.test.ts when the
// v4-only AsyncLocalStorage bridge was removed (PR-49 cleanup).
// ---------------------------------------------------------------------------

import { extractClientIp } from "@/lib/auth/client-ip";

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
