import { describe, it, expect, beforeAll } from "vitest";
// next.config is at the project root — the alias doesn't cover it, so import
// via a relative path.
import nextConfig from "../../next.config";

// ---------------------------------------------------------------------------
// P2-20 regression — security headers are configured in next.config.ts.
//
// `nextConfig.headers` is an async function returning an array of route rules.
// We invoke it directly and assert the security headers are present on the
// catch-all `/:path*` rule. This catches accidental removal (e.g. someone
// deleting the headers() block while refactoring).
// ---------------------------------------------------------------------------

type HeaderEntry = { source: string; headers: Array<{ key: string; value: string }> };

describe("security headers (P2-20)", () => {
  let headersResult: HeaderEntry[];

  beforeAll(async () => {
    const fn = nextConfig.headers;
    if (typeof fn !== "function") {
      throw new Error("nextConfig.headers is not a function — security headers missing");
    }
    headersResult = (await fn()) as HeaderEntry[];
  });

  function headerFor(name: string): { key: string; value: string } | undefined {
    for (const rule of headersResult) {
      const found = rule.headers.find(
        (h) => h.key.toLowerCase() === name.toLowerCase(),
      );
      if (found) return found;
    }
    return undefined;
  }

  it("applies headers to the catch-all /:path* route", () => {
    const rule = headersResult.find((r) => r.source === "/:path*");
    expect(rule, "missing catch-all /:path* rule").toBeDefined();
    expect(rule!.headers.length).toBeGreaterThanOrEqual(6);
  });

  it("X-Frame-Options: DENY (clickjacking)", () => {
    const h = headerFor("X-Frame-Options");
    expect(h, "X-Frame-Options header missing").toBeDefined();
    expect(h!.value).toBe("DENY");
  });

  it("X-Content-Type-Options: nosniff (MIME sniffing)", () => {
    const h = headerFor("X-Content-Type-Options");
    expect(h, "X-Content-Type-Options header missing").toBeDefined();
    expect(h!.value).toBe("nosniff");
  });

  it("Referrer-Policy: strict-origin-when-cross-origin", () => {
    const h = headerFor("Referrer-Policy");
    expect(h, "Referrer-Policy header missing").toBeDefined();
    expect(h!.value).toBe("strict-origin-when-cross-origin");
  });

  it("Permissions-Policy locks down camera/microphone/geolocation/payment", () => {
    const h = headerFor("Permissions-Policy");
    expect(h, "Permissions-Policy header missing").toBeDefined();
    expect(h!.value).toContain("camera=()");
    expect(h!.value).toContain("microphone=()");
    expect(h!.value).toContain("geolocation=()");
    expect(h!.value).toContain("payment=()");
  });

  it("Strict-Transport-Security is set (HSTS — proxy terminates TLS)", () => {
    const h = headerFor("Strict-Transport-Security");
    expect(h, "HSTS header missing").toBeDefined();
    expect(h!.value).toMatch(/max-age=\d+/);
    expect(h!.value).toMatch(/31536000/); // 1 year
  });

  it("Content-Security-Policy is conservative (frame-ancestors 'none', object-src 'none')", () => {
    const h = headerFor("Content-Security-Policy");
    expect(h, "CSP header missing").toBeDefined();
    const v = h!.value;
    expect(v).toContain("default-src 'self'");
    expect(v).toContain("frame-ancestors 'none'");
    expect(v).toContain("object-src 'none'");
    expect(v).toContain("base-uri 'self'");
    expect(v).toContain("form-action 'self'");
  });
});
