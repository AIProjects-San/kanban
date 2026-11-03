// @vitest-environment node
// ^ the proxy is pure middleware — no DOM needed, run in a plain Node env.
import { describe, it, expect, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";

// ---------------------------------------------------------------------------
// proxy — obsolete v4 cookie cleanup + CSP (PR-49 cleanup).
//
// The NextAuth v4 stack is gone; the JWE cookie guard retired with it
// (Better Auth's DB-backed opaque tokens fail silent — nothing to
// self-heal). What the proxy must still do cookie-wise: expire leftover
// next-auth.* cookies from before the cutover, unconditionally, without
// ever touching the fernly.* set. The CSP suites below pin the nonce
// posture (PR-06/PR-40).
// ---------------------------------------------------------------------------

import proxy from "@/proxy";

const SESSION_COOKIE = "next-auth.session-token";

function makeRequest(cookieValue: string | null, url = "http://localhost:3000/") {
  const headers = new Headers();
  if (cookieValue !== null) headers.set("cookie", `${SESSION_COOKIE}=${cookieValue}`);
  return new NextRequest(url, { headers });
}

function setCookieHeader(res: Response): string[] {
  // getAll() on a Headers object from next/server — same call in Node & jsdom.
  return res.headers.getSetCookie();
}

// ---------------------------------------------------------------------------
// Obsolete v4 cookie cleanup
// ---------------------------------------------------------------------------

describe("proxy: obsolete v4 cookie cleanup", () => {
  it("expires a leftover v4 session cookie WITHOUT validating it (it is obsolete regardless of how it was signed)", async () => {
    const req = makeRequest("some-old-jwe-value");
    const res = await proxy(req);
    const setCookies = setCookieHeader(res).map((c) => c.split(";")[0]);
    expect(setCookies).toContain(`${SESSION_COOKIE}=`);
    // The forwarded request no longer carries it, so the page render starts
    // from a clean cookie jar.
    expect(req.headers.get("cookie") ?? "").not.toContain(SESSION_COOKIE);
    expect(res.status).toBe(200);
  });

  it("expires the CSRF and callback-url leftovers together with the session token", async () => {
    const headers = new Headers();
    headers.set(
      "cookie",
      [
        "next-auth.session-token=x",
        "next-auth.csrf-token=y",
        "next-auth.callback-url=z",
      ].join("; "),
    );
    const req = new NextRequest("http://localhost:3000/", { headers });
    const res = await proxy(req);
    const setCookies = setCookieHeader(res).map((c) => c.split(";")[0]);
    expect(setCookies).toContain("next-auth.session-token=");
    expect(setCookies).toContain("next-auth.csrf-token=");
    expect(setCookies).toContain("next-auth.callback-url=");
    expect(res.status).toBe(200);
  });

  it("expires the __Secure- (production) variants too", async () => {
    const headers = new Headers();
    headers.set(
      "cookie",
      "__Secure-next-auth.session-token=x; __Secure-next-auth.csrf-token=y",
    );
    const res = await proxy(new NextRequest("http://localhost:3000/", { headers }));
    const setCookies = setCookieHeader(res).map((c) => c.split(";")[0]);
    expect(setCookies).toContain("__Secure-next-auth.session-token=");
    expect(setCookies).toContain("__Secure-next-auth.csrf-token=");
  });

  it("expires a garbage v4 cookie the same way (no decode error path)", async () => {
    const res = await proxy(makeRequest("garbage-not-a-jwe"));
    const setCookies = setCookieHeader(res).map((c) => c.split(";")[0]);
    expect(setCookies).toContain(`${SESSION_COOKIE}=`);
    expect(res.status).toBe(200);
  });

  it("passes through untouched when there is no v4 cookie", async () => {
    const res = await proxy(makeRequest(null));
    expect(res.status).toBe(200);
    expect(setCookieHeader(res)).toEqual([]);
  });

  it("never touches the fernly.* cookie set (v4 leftovers cleaned alongside)", async () => {
    const headers = new Headers();
    headers.set(
      "cookie",
      "fernly.session_token=tok.sig; fernly.session_data=abc; next-auth.session-token=old",
    );
    const req = new NextRequest("http://localhost:3000/", { headers });
    const res = await proxy(req);
    expect(res.status).toBe(200);
    // No Set-Cookie expiring the better-auth cookies — Better Auth owns
    // them entirely (DB-backed opaque tokens fail silent, nothing to heal).
    const expiredBetter = setCookieHeader(res).filter((c) =>
      c.startsWith("fernly."),
    );
    expect(expiredBetter).toEqual([]);
    // The fernly cookies are still forwarded; only the v4 leftover is gone.
    expect(req.headers.get("cookie") ?? "").toContain("fernly.session_token=");
    expect(req.headers.get("cookie") ?? "").not.toContain("next-auth.session-token");
  });
});

// ---------------------------------------------------------------------------
// PR-40 — style-src hardening. Production ships `style-src 'self'` with NO
// 'unsafe-inline': Next.js injects zero inline <style> elements in the prod
// build (verified against the standalone server), and the one SSR'd style
// attribute (the login brand panel) became the f-decor-dots class. Client-side
// style updates go through the CSSOM, which CSP never blocks. Development
// keeps 'unsafe-inline' — Tailwind v4 injects styles at runtime for HMR.
// The end-to-end guard (SSR HTML contains no <style> / style=" at all) lives
// in scripts/prod-smoke.mjs.
// ---------------------------------------------------------------------------

describe("PR-40: CSP style-src — no unsafe-inline in production", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function cspForRequest() {
    const res = await proxy(makeRequest(null));
    return res.headers.get("content-security-policy") ?? "";
  }

  it("production ships style-src 'self' — no unsafe-inline", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const csp = await cspForRequest();
    expect(csp).toMatch(/style-src 'self';/);
    expect(csp).not.toMatch(/style-src[^;]*unsafe-inline/);
  });

  it("development keeps style-src 'unsafe-inline' (Tailwind v4 runtime injection)", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const csp = await cspForRequest();
    expect(csp).toMatch(/style-src 'self' 'unsafe-inline'/);
  });

  it("production script-src stays nonce-only (no unsafe-eval / unsafe-inline)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const csp = await cspForRequest();
    const scriptSrc = csp.match(/script-src[^;]*/)?.[0] ?? "";
    expect(scriptSrc).toMatch(/nonce-/);
    expect(scriptSrc).not.toMatch(/unsafe-(eval|inline)/);
  });
});
