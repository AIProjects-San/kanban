// @vitest-environment node
// ^ NextAuth + the route handler use Node-only crypto/headers APIs; jsdom
// is the wrong realm here.
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Regression tests for the NextAuth route-wrapper's "clear every auth
// cookie on signout" behaviour.
//
// NextAuth's built-in `/api/auth/signout` handler only expires the
// session-token cookie. Our wrapper appends expiry Set-Cookie headers for
// every auth cookie (session, csrf, callback-url, both `next-auth.*` and
// `__Secure-next-auth.*` name spaces) so that a stale CSRF cookie — which
// can wedge the next sign-in after a NEXTAUTH_SECRET rotation — is wiped
// on the way out too.
//
// We don't drive a full NextAuth round-trip here; we mock the inner
// handler so we can assert purely on the wrapper's "did it append the
// right Set-Cookie headers when path === 'signout'" contract.
// ---------------------------------------------------------------------------

// Reference the mock via a single hoisted object binding so the mock
// factory's closure always sees an initialised reference (destructured
// consts sit in the TDZ at the moment vi.mock runs).
const authMock = vi.hoisted(() => ({ handler: vi.fn() }));

vi.mock("next-auth", () => ({
  // NextAuth(authOptions) returns the request handler. For the wrapper
  // tests we don't care about the config — we just need the returned
  // handler to be our mock.
  default: () => authMock.handler,
}));

// Stub db so the events.signOut callback (loaded transitively via authOptions)
// doesn't try to touch a real database.
vi.mock("@/lib/db", () => ({
  db: {
    user: { findUnique: vi.fn().mockResolvedValue(null) },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  },
}));

import { GET, POST } from "@/app/api/auth/[...nextauth]/route";
import { AUTH_COOKIE_NAMES, clearCookieHeaders } from "@/lib/auth-cookies";

const authHandler = authMock.handler;

function makeResponse(): Response {
  // Minimal stand-in for the Response NextAuth would return.
  return new Response("ok", {
    status: 200,
    headers: { "content-type": "text/plain" },
  });
}

beforeEach(() => {
  authHandler.mockReset();
  authHandler.mockResolvedValue(makeResponse());
});

describe("auth route wrapper: signout clears every auth cookie", () => {
  it("appends a Set-Cookie expiry for every auth cookie on POST /api/auth/signout", async () => {
    const req = new Request("http://localhost/api/auth/signout", {
      method: "POST",
    });
    const ctx = { params: Promise.resolve({ nextauth: ["signout"] }) };

    const res = await POST(req, ctx);

    const setCookies = res.headers.getSetCookie();
    // Every cookie in our inventory must appear as a Max-Age=0 expiry.
    for (const name of AUTH_COOKIE_NAMES) {
      const match = setCookies.some(
        (c) => c.startsWith(`${name}=;`) || c.startsWith(`${name}=`),
      );
      expect(match, `expected a Set-Cookie expiry for ${name}`).toBe(true);
    }
    // Every header the helper produced must be present verbatim.
    for (const expected of clearCookieHeaders()) {
      expect(setCookies).toContain(expected);
    }
    // And they're genuinely expiries (Max-Age=0 OR a 1970 Expires).
    for (const c of setCookies) {
      if (c.startsWith("next-auth.") || c.startsWith("__Secure-next-auth.")) {
        expect(c).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/);
      }
    }
    // The original response status survives.
    expect(res.status).toBe(200);
  });

  it("also clears cookies on GET /api/auth/signout (logout-by-confirmation-page)", async () => {
    const req = new Request("http://localhost/api/auth/signout", {
      method: "GET",
    });
    const ctx = { params: Promise.resolve({ nextauth: ["signout"] }) };

    const res = await GET(req, ctx);

    const setCookies = res.headers.getSetCookie();
    expect(setCookies.length).toBeGreaterThanOrEqual(AUTH_COOKIE_NAMES.length);
    for (const name of AUTH_COOKIE_NAMES) {
      expect(
        setCookies.some(
          (c) => c.startsWith(`${name}=;`) || c.startsWith(`${name}=`),
        ),
      ).toBe(true);
    }
  });

  it("does NOT touch the response for non-signout NextAuth endpoints (e.g. /api/auth/session)", async () => {
    const req = new Request("http://localhost/api/auth/session", {
      method: "GET",
    });
    const ctx = { params: Promise.resolve({ nextauth: ["session"] }) };

    const res = await GET(req, ctx);

    // No cookie expiries appended.
    const setCookies = res.headers.getSetCookie().filter(
      (c) =>
        c.startsWith("next-auth.") || c.startsWith("__Secure-next-auth."),
    );
    expect(setCookies).toHaveLength(0);
    // Original status + body preserved.
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("forwards the request to NextAuth unchanged", async () => {
    const req = new Request("http://localhost/api/auth/signout", {
      method: "POST",
    });
    const ctx = { params: Promise.resolve({ nextauth: ["signout"] }) };

    await POST(req, ctx);

    expect(authHandler).toHaveBeenCalledTimes(1);
    // NextAuth sees the resolved (sync-shape) params, not the Promise.
    expect(authHandler).toHaveBeenCalledWith(req, {
      params: { nextauth: ["signout"] },
    });
  });

  it("preserves any Set-Cookie headers NextAuth itself emitted (e.g. its own session-token deletion)", async () => {
    authHandler.mockResolvedValue(
      new Response("ok", {
        status: 200,
        headers: {
          "set-cookie":
            "next-auth.session-token=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax",
        },
      }),
    );

    const req = new Request("http://localhost/api/auth/signout", {
      method: "POST",
    });
    const ctx = { params: Promise.resolve({ nextauth: ["signout"] }) };

    const res = await POST(req, ctx);
    const setCookies = res.headers.getSetCookie();
    // NextAuth's own deletion survived…
    expect(
      setCookies.some((c) =>
        c.startsWith("next-auth.session-token=;") &&
        c.includes("Max-Age=0"),
      ),
    ).toBe(true);
    // …and our appended expiries are also there.
    expect(
      setCookies.some((c) => c.startsWith("next-auth.csrf-token=")),
    ).toBe(true);
    expect(
      setCookies.some((c) => c.startsWith("next-auth.callback-url=")),
    ).toBe(true);
  });
});

describe("clearCookieHeaders()", () => {
  it("returns one expiry per cookie in AUTH_COOKIE_NAMES", () => {
    const headers = clearCookieHeaders();
    expect(headers).toHaveLength(AUTH_COOKIE_NAMES.length);
    for (const h of headers) {
      expect(h).toMatch(/Max-Age=0/);
      expect(h).toMatch(/Expires=Thu, 01 Jan 1970 00:00:01 GMT/);
      expect(h).toContain("Path=/");
      expect(h).toContain("SameSite=Lax");
    }
  });

  it("marks the session-token and csrf-token expiries as HttpOnly (matches the original cookie attributes)", () => {
    const headers = clearCookieHeaders();
    for (const name of AUTH_COOKIE_NAMES) {
      const h = headers.find((x) => x.startsWith(`${name}=;`));
      expect(h, `missing expiry for ${name}`).toBeDefined();
      if (
        name.endsWith(".session-token") ||
        name.endsWith(".csrf-token")
      ) {
        expect(h).toContain("HttpOnly");
      }
    }
  });
});
