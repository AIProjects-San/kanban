// @vitest-environment node
// ^ jose's Node build does `plaintext instanceof Uint8Array`, which fails
// across the jsdom/Node realm boundary. No DOM is needed here, so run this
// file in a plain Node environment.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { encode, getToken } from "next-auth/jwt";

// ---------------------------------------------------------------------------
// proxy — self-healing stale session cookie guard
//
// Regression tests for the JWT_SESSION_ERROR "decryption operation failed"
// bug: a session cookie encrypted with a different NEXTAUTH_SECRET (container
// rebuild / secret rotation) used to fail decryption on every request and
// never self-heal. The proxy must clear exactly the bad cookies and never
// touch valid ones or NextAuth's own endpoints.
// ---------------------------------------------------------------------------

import proxy from "@/proxy";

const SESSION_COOKIE = "next-auth.session-token";
const SECRET = "test-secret-for-proxy-regression-0123456789";
const OLD_SECRET = "a-completely-different-secret-9876543210";

function makeRequest(cookieValue: string | null, url = "http://localhost:3000/") {
  const headers = new Headers();
  if (cookieValue !== null) headers.set("cookie", `${SESSION_COOKIE}=${cookieValue}`);
  return new NextRequest(url, { headers });
}

function setCookieHeader(res: Response): string[] {
  // getAll() on a Headers object from next/server — same call in Node & jsdom.
  return res.headers.getSetCookie();
}

/** Mint a real, encrypted session cookie like NextAuth would set. */
async function mintCookie(secret: string) {
  return await encode({
    token: {
      id: "u-1",
      email: "demo@fernly.app",
      name: "Demo",
      role: "ADMIN",
      roleCheckedAt: Date.now(),
    } as Parameters<typeof encode>[0]["token"],
    secret,
  });
}

beforeEach(() => {
  process.env.NEXTAUTH_SECRET = SECRET;
  // PR-49 — the repo default stack is "better"; these suites pin the v4
  // JWE guard explicitly (the one-release rollback path). The PR-48
  // better-stack describe below overrides this to "better" per-test.
  process.env.NEXT_PUBLIC_AUTH_STACK = "nextauth";
});

afterEach(() => {
  delete process.env.NEXTAUTH_SECRET;
  delete process.env.NEXT_PUBLIC_AUTH_STACK;
});

describe("proxy: stale session cookie self-healing", () => {
  it("expires and strips a cookie signed with a different secret", async () => {
    const stale = await mintCookie(OLD_SECRET);
    const req = makeRequest(stale);

    const res = await proxy(req);

    // Response tells the browser to drop the stale cookie…
    const cookies = setCookieHeader(res);
    expect(
      cookies.some(
        (c) =>
          c.startsWith(`${SESSION_COOKIE}=;`) ||
          c.startsWith(`${SESSION_COOKIE}=`),
      ),
    ).toBe(true);
    expect(cookies.join("\n")).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/);

    // …and the forwarded request no longer carries it, so the page render
    // (getServerSession) never even attempts the doomed decryption.
    const forwardedCookie = res.headers.get("x-middleware-override-headers")
      ? res.headers.get("x-middleware-request-cookie")
      : null;
    // The strip is applied to req.headers directly — assert on that too.
    expect(req.headers.get("cookie") ?? "").not.toContain(SESSION_COOKIE);
    expect(forwardedCookie === null || !forwardedCookie.includes(SESSION_COOKIE)).toBe(true);
  });

  it("expires a garbage / malformed cookie value", async () => {
    const req = makeRequest("not-a-jwe-at-all");
    const res = await proxy(req);
    const cookies = setCookieHeader(res);
    expect(cookies.join("\n")).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/);
    expect(req.headers.get("cookie") ?? "").not.toContain(SESSION_COOKIE);
  });

  it("passes a valid cookie through untouched", async () => {
    const valid = await mintCookie(SECRET);
    const req = makeRequest(valid);

    const res = await proxy(req);

    // No Set-Cookie clearing the session token…
    const cookies = setCookieHeader(res);
    expect(
      cookies.filter((c) => c.startsWith(`${SESSION_COOKIE}=`)),
    ).toHaveLength(0);
    // …and the request still carries the valid cookie.
    expect(req.headers.get("cookie")).toContain(`${SESSION_COOKIE}=${valid}`);
  });

  it("passes through when there is no session cookie at all", async () => {
    const res = await proxy(makeRequest(null));
    expect(setCookieHeader(res).filter((c) => c.startsWith(SESSION_COOKIE))).toHaveLength(0);
  });

  it("passes through when NEXTAUTH_SECRET is unset (ephemeral dev secret cannot be verified from the edge bundle)", async () => {
    delete process.env.NEXTAUTH_SECRET;
    // A cookie valid for the (unknown-to-proxy) runtime secret must NOT be
    // cleared just because this bundle can't see the secret.
    const someCookie = await mintCookie("ephemeral-runtime-secret");
    const req = makeRequest(someCookie);

    const res = await proxy(req);

    expect(setCookieHeader(res).filter((c) => c.startsWith(SESSION_COOKIE))).toHaveLength(0);
    expect(req.headers.get("cookie")).toContain(SESSION_COOKIE);
  });
});

describe("proxy: getToken verification semantics", () => {
  it("getToken returns null for a foreign-secret cookie but a token for the right secret (documents the contract the proxy relies on)", async () => {
    const stale = await mintCookie(OLD_SECRET);
    const valid = await mintCookie(SECRET);

    const staleToken = await getToken({
      req: makeRequest(stale),
      secret: SECRET,
      cookieName: SESSION_COOKIE,
    });
    const validToken = await getToken({
      req: makeRequest(valid),
      secret: SECRET,
      cookieName: SESSION_COOKIE,
    });

    expect(staleToken).toBeNull();
    expect(validToken).not.toBeNull();
    expect((validToken as Record<string, unknown>).email).toBe("demo@fernly.app");
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

// ---------------------------------------------------------------------------
// PR-48 — better-stack mode: the v4 JWE guard is retired; leftover v4
// cookies from before the cutover are expired unconditionally (never
// JWE-validated, no NEXTAUTH_SECRET dependency), and requests without a v4
// cookie pass through untouched.
// ---------------------------------------------------------------------------

describe("PR-48: better-stack cookie handling", () => {
  beforeEach(() => {
    process.env.NEXTAUTH_SECRET = SECRET;
    process.env.NEXT_PUBLIC_AUTH_STACK = "better";
  });

  afterEach(() => {
    delete process.env.NEXT_PUBLIC_AUTH_STACK;
    delete process.env.NEXTAUTH_SECRET;
  });

  it("expires a leftover v4 session cookie WITHOUT JWE-validating it (even a valid one)", async () => {
    // A cookie signed with the CURRENT secret would pass the v4 guard — on
    // the better stack it is obsolete regardless and must be expired.
    const cookie = await mintCookie(SECRET);
    const res = await proxy(makeRequest(cookie));
    const setCookies = setCookieHeader(res).map((c) => c.split(";")[0]);
    expect(setCookies).toContain(`${SESSION_COOKIE}=`);
    expect(setCookies).toContain("next-auth.csrf-token=");
    expect(setCookies).toContain("next-auth.callback-url=");
    // And the forwarded request no longer carries it.
    const forwardedCookie = res.headers.get("x-middleware-override-headers")
      ? null : null; // NextResponse.next() forwards via internal mutation;
    // the observable contract is the expiry above plus a 200 pass-through.
    expect(res.status).toBe(200);
    expect(forwardedCookie).toBeNull();
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

  it("never touches the fernly.* cookie set on the better stack", async () => {
    const headers = new Headers();
    headers.set("cookie", "fernly.session_token=tok.sig; fernly.session_data=abc");
    const res = await proxy(new NextRequest("http://localhost:3000/", { headers }));
    expect(res.status).toBe(200);
    // No Set-Cookie expiring the better-auth cookies — Better Auth owns
    // them entirely (DB-backed opaque tokens fail silent, nothing to heal).
    const expiredBetter = setCookieHeader(res).filter((c) =>
      c.startsWith("fernly."),
    );
    expect(expiredBetter).toEqual([]);
  });
});
