import { describe, it, expect, beforeAll, vi } from "vitest";
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

  // -------------------------------------------------------------------------
  // Launch-crosscheck additions (audit §1.15): env-driven origins split and
  // optional CSP reporting.
  // -------------------------------------------------------------------------

  it("Server Actions allowedOrigins defaults to the conservative preview/dev list", () => {
    const origins = (
      nextConfig.experimental as { serverActions: { allowedOrigins: string[] } }
    ).serverActions.allowedOrigins;
    expect(origins).toContain("localhost:3000");
    expect(origins).toContain("*.space-z.ai");
  });

  it("SERVER_ACTIONS_ALLOWED_ORIGINS narrows the list for production builds", async () => {
    // Re-import the config with the env var set. vi.resetModules + dynamic
    // import re-evaluates next.config.ts with the new environment.
    const prev = process.env.SERVER_ACTIONS_ALLOWED_ORIGINS;
    process.env.SERVER_ACTIONS_ALLOWED_ORIGINS = "app.example.com,staging.example.com";
    try {
      vi.resetModules();
      const mod = await import("../../next.config");
      const origins = (
        (mod.default.experimental as { serverActions: { allowedOrigins: string[] } })
          .serverActions.allowedOrigins
      );
      expect(origins).toEqual(["app.example.com", "staging.example.com"]);
      expect(origins).not.toContain("*.space-z.ai");
    } finally {
      process.env.SERVER_ACTIONS_ALLOWED_ORIGINS = prev;
      vi.resetModules();
    }
  });

  it("REPORT_URI adds report-uri/report-to directives and the Report-To header", async () => {
    const prev = process.env.REPORT_URI;
    process.env.REPORT_URI = "https://csp-collector.example.com/report";
    try {
      vi.resetModules();
      const mod = await import("../../next.config");
      const fn = mod.default.headers;
      if (typeof fn !== "function") throw new Error("headers() missing");
      const rules = (await fn()) as HeaderEntry[];
      const csp = rules
        .flatMap((r) => r.headers)
        .find((h) => h.key === "Content-Security-Policy");
      expect(csp?.value).toContain("report-uri https://csp-collector.example.com/report");
      expect(csp?.value).toContain("report-to csp-endpoint");
      const reportTo = rules
        .flatMap((r) => r.headers)
        .find((h) => h.key === "Report-To");
      expect(reportTo?.value).toContain("csp-endpoint");
    } finally {
      process.env.REPORT_URI = prev;
      vi.resetModules();
    }
  });
});
