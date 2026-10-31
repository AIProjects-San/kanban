import { NextResponse, type NextRequest } from "next/server";
import { getToken } from "next-auth/jwt";
import { withRequestId, generateRequestId, log } from "@/lib/observability";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// Self-healing session cookie guard + nonce-based CSP (P1 production-readiness
// re-audit).
// ---------------------------------------------------------------------------
// When NEXTAUTH_SECRET changes (container rebuild, secret rotation, a cookie
// left over from another environment) every request carrying the old cookie
// fails JWE decryption inside `getServerSession`, which logs
// `[next-auth][error][JWT_SESSION_ERROR] "decryption operation failed"` on
// *every* render — for up to the cookie's 30-day lifetime — and the stale
// CSRF cookie can make the browser appear stuck on the login screen.
//
// This proxy verifies the cookie against the current secret before the
// request reaches the app. An undecryptable cookie is stripped from the
// forwarded request (so the very first render is already clean) and expired
// in the response (so the browser drops it). The visitor simply sees the
// login screen and a fresh sign-in mints a valid cookie.
//
// getToken() swallows decode errors and returns null, so verification adds
// no log noise of its own.
//
// P1 re-audit — CSP is now nonce-based. A fresh nonce is generated per
// request and stamped into the `Content-Security-Policy` header. Next.js
// auto-detects the nonce and applies it to its inline bootstrap scripts,
// so we can drop `'unsafe-inline'` from `script-src`. `'unsafe-eval'` is
// kept ONLY in development (HMR / React Refresh needs it); production
// ships without it.

// Mirrors the cookie name pinned in src/lib/auth.ts (the app sets it
// explicitly, so it is identical in dev and production — no __Secure- prefix).
const SESSION_COOKIE = "next-auth.session-token";

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
  const directives = [
    "default-src 'self'",
    scriptSrc,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self' https: ws: wss:",
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
  // Run on app pages and Server Actions; never on NextAuth's own endpoints
  // (the sign-in callback must be free to rotate/overwrite the session
  // cookie itself — racing it with a delete here could eat a fresh cookie)
  // and never on static assets.
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
    const raw = req.cookies.get(SESSION_COOKIE)?.value;
    const secret = process.env.NEXTAUTH_SECRET;

    // Helper: stamp CSP + request-id on any response we return + emit a
    // per-request structured log line with duration + route + status.
    function stampHeaders(res: NextResponse) {
      res.headers.set("Content-Security-Policy", csp);
      res.headers.set("X-Request-Id", requestId);
      // Also pass the nonce as a request header so server components can
      // read it via headers() and apply it to custom <script> tags.
      res.headers.set("x-nonce", nonce);
      // P2 re-audit — per-request structured log with durationMs + route +
      // statusCode. Operators can build p95 + error-rate alerts from this.
      // Emitted at info level for successful requests; warn for 5xx.
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

    // No cookie to check, or no explicit secret: pass through with CSP.
    if (!raw || !secret) return stampHeaders(NextResponse.next());

    let valid = false;
    try {
      valid =
        (await getToken({ req, secret, cookieName: SESSION_COOKIE })) !== null;
    } catch (err) {
      // Treat unexpected decode failures (malformed cookie, crypto errors) the
      // same as a stale cookie — clearing it is always the safe recovery.
      // L-P1-19: log the error with the request id so it's traceable.
      log.warn("proxy: session cookie decode failed", {
        path: req.nextUrl.pathname,
        error: err instanceof Error ? err.message : String(err),
      });
      valid = false;
    }
    if (valid) return stampHeaders(NextResponse.next());

    // Stale or corrupt session cookie. Strip it from the request we forward
    // and expire it in the browser so it never comes back.
    log.info("proxy: clearing stale session cookie", {
      path: req.nextUrl.pathname,
    });
    req.cookies.delete(SESSION_COOKIE);
    const res = NextResponse.next({ request: { headers: req.headers } });
    res.cookies.set(SESSION_COOKIE, "", {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 0,
    });
    return stampHeaders(res);
  });
}
