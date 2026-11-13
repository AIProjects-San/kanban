import { NextResponse, type NextRequest } from "next/server";
import { withRequestId, generateRequestId, log } from "@/lib/infra/observability";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// Obsolete v4 cookie cleanup + nonce-based CSP.
// ---------------------------------------------------------------------------
// The NextAuth v4 stack is gone (PR-49 cleanup); authentication is Better
// Auth with DB-backed OPAQUE tokens, which fail silent — an unknown token
// simply means signed out: no log spam, no CSRF wedge, nothing to
// self-heal. The old JWE cookie guard (secret-rotation self-healing for
// the v4 next-auth.* cookies) is retired with it.
//
// What remains cookie-wise: a browser that last authenticated BEFORE the
// cutover may still carry obsolete next-auth.* cookies. They are stripped
// from the forwarded request and expired in the response, once, on every
// request that presents them — no secret needed (they are obsolete
// regardless of how they were signed).
//
// P1 re-audit — CSP is nonce-based. A fresh nonce is generated per
// request and stamped into the `Content-Security-Policy` header. Next.js
// auto-detects the nonce and applies it to its inline bootstrap scripts,
// so we can drop `'unsafe-inline'` from `script-src`. `'unsafe-eval'` is
// kept ONLY in development (HMR / React Refresh needs it); production
// ships without it.

// The v4 cookie names (dev + prod prefixes) — kept ONLY for the cutover
// cleanup below. Better Auth's cookies are the fernly.* set and are never
// touched here.
const V4_SESSION_COOKIES = [
  "next-auth.session-token",
  "__Secure-next-auth.session-token",
];
const V4_CSRF_COOKIES = [
  "next-auth.csrf-token",
  "__Secure-next-auth.csrf-token",
];
const V4_CALLBACK_COOKIES = [
  "next-auth.callback-url",
  "__Secure-next-auth.callback-url",
];

/**
 * Generate a per-request nonce for CSP. 16 bytes (128 bits) base64-encoded
 * — standard nonce size, sufficient entropy against guessing.
 */
function generateNonce(): string {
  return randomBytes(16).toString("base64");
}

/**
 * Build the Content-Security-Policy header value with the given nonce.
 * In production: `script-src 'self' 'nonce-<value>'` (no unsafe-inline/eval).
 * In development: adds `'unsafe-eval'` for HMR / React Refresh.
 */
function buildCsp(nonce: string): string {
  const isDev = process.env.NODE_ENV !== "production";
  const scriptSrc = isDev
    ? `script-src 'self' 'nonce-${nonce}' 'unsafe-eval'`
    : `script-src 'self' 'nonce-${nonce}'`;
  // PR-06 (production-readiness audit) — connect-src was `'self' https: ws:
  // wss:'`, where the bare `https:` scheme-source allows the page to POST to
  // ANY https origin — a single XSS (or a compromised dependency) could exfil
  // everything to an attacker host. The app makes no cross-origin client
  // requests (server actions, the error bridge and auth are same-origin; mail
  // and Sentry are server-side), so production is now strictly `'self'`.
  // Development keeps `ws:` for the HMR websocket (CSP2 'self' does not
  // cover the ws: scheme on all engines).
  const connectSrc = isDev
    ? "connect-src 'self' ws:"
    : "connect-src 'self'";
  // PR-40 — style-src hardened: production ships 'self' with NO
  // 'unsafe-inline'. Verified empirically against the standalone build: the
  // production SSR HTML contains zero inline <style> elements (Next.js links
  // compiled stylesheets; Tailwind v4's runtime injection is dev-only) and
  // the one historical style= attribute (the login brand panel) became the
  // f-decor-dots class. Data-driven styling (progress widths, avatar colors)
  // happens client-side via the CSSOM, which CSP never blocks — enforced
  // end-to-end by the prod-smoke HTML scan. Development keeps
  // 'unsafe-inline' because Tailwind v4 injects styles at runtime for HMR.
  const styleSrc = isDev
    ? "style-src 'self' 'unsafe-inline'"
    : "style-src 'self'";
  const directives = [
    "default-src 'self'",
    scriptSrc,
    styleSrc,
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    connectSrc,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ];
  if (process.env.REPORT_URI) {
    directives.push(`report-uri ${process.env.REPORT_URI}`);
    directives.push("report-to csp-endpoint");
  }
  return directives.join("; ");
}

export const config = {
  // Run on app pages and Server Actions; never on the auth endpoints
  // (they must stay free to rotate/overwrite their own cookies — racing
  // them with a delete here could eat a fresh cookie) and never on static
  // assets. `api/auth` covers BOTH the retired v4 mount and the live
  // `api/auth-better` handler (prefix match).
  matcher: [
    "/((?!api/auth|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js|map)$).*)",
  ],
};

export default async function proxy(req: NextRequest) {
  // L-P1-19 — wrap every request in a request-id context so all log lines
  // and captured errors can be correlated back to the request that produced
  // them. The id is generated per-request (not from a header) so we don't
  // trust client-supplied ids.
  const requestId = generateRequestId();
  // P1 re-audit — per-request nonce for CSP.
  const nonce = generateNonce();
  const csp = buildCsp(nonce);
  // P2 (production-readiness re-audit) — record the start time so we can
  // emit `durationMs` in the per-request structured log. This lets operators
  // build p95 latency dashboards + alert on slow requests from the existing
  // log stream without a separate metrics dependency.
  const startMs = Date.now();

  return withRequestId(requestId, async () => {
    // Helper: stamp CSP + request-id on any response we return + emit a
    // per-request structured log line with duration + route + status.
    function stampHeaders(res: NextResponse) {
      res.headers.set("Content-Security-Policy", csp);
      res.headers.set("X-Request-Id", requestId);
      const durationMs = Date.now() - startMs;
      const method = req.method;
      const path = req.nextUrl.pathname;
      log.info("proxy: request", {
        method,
        path,
        statusCode: res.status,
        durationMs,
        metric: "http_request",
      });
      return res;
    }

    // PR-06 — propagate the CSP + nonce on the FORWARDED REQUEST headers so
    // (a) Next.js picks the nonce out of `content-security-policy` and stamps
    // its bootstrap scripts with it, and (b) server components can read the
    // nonce via `headers().get("x-nonce")` for custom <script> tags. The old
    // code set both only on the RESPONSE, which the renderer never sees —
    // the nonce was decorative. Build the header set AFTER any cookie
    // stripping below so a cleaned request is what gets forwarded.
    function forward(): NextResponse {
      const requestHeaders = new Headers(req.headers);
      requestHeaders.set("x-nonce", nonce);
      requestHeaders.set("content-security-policy", csp);
      return NextResponse.next({ request: { headers: requestHeaders } });
    }

    // Cutover cleanup: a leftover v4 cookie from before the Better Auth
    // migration is obsolete regardless of how it was signed — strip it from
    // the forwarded request and expire it in the browser so it never comes
    // back. The fernly.* cookie set is never touched.
    const stale = [
      ...V4_SESSION_COOKIES,
      ...V4_CSRF_COOKIES,
      ...V4_CALLBACK_COOKIES,
    ].filter((name) => req.cookies.get(name)?.value !== undefined);
    if (stale.length > 0) {
      log.info("proxy: expiring obsolete v4 session cookies (better stack)", {
        path: req.nextUrl.pathname,
      });
      for (const name of stale) {
        req.cookies.delete(name);
      }
      const res = forward();
      const expiredCookie = {
        httpOnly: true,
        sameSite: "lax" as const,
        path: "/",
        maxAge: 0,
      };
      for (const name of stale) {
        res.cookies.set(name, "", expiredCookie);
      }
      return stampHeaders(res);
    }

    return stampHeaders(forward());
  });
}
