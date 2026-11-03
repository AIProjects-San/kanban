import { NextResponse, type NextRequest } from "next/server";
import { captureError } from "@/lib/observability";
import { createClientErrorLimiter } from "@/lib/rate-limit-redis";

// ---------------------------------------------------------------------------
// Client error ingestion endpoint (completes L-P1-19).
//
// `src/lib/client-error-bridge.ts` (browser) POSTs client-side errors here;
// this route is the server-side half that hands them to the configured
// error reporter with the current request id. The bridge lives in an API
// route because `src/app/error.tsx` cannot import observability directly
// (node:async_hooks must never enter the browser bundle).
//
// Hardening:
//   • POST only; anything else is a bare 405.
//   • Payload capped at 8 KB — a looping client can't flood the logs.
//   • Fields truncated + coerced to strings; no HTML reflection, so the
//     response is a constant and can never echo attacker input.
//   • No-store: reports are not cacheable.
// ---------------------------------------------------------------------------

const MAX_BODY_BYTES = 8 * 1024;

// PR-13 (production-readiness audit) — per-IP throttle so the unauthenticated
// bridge can't be flooded by a scripted client (see createClientErrorLimiter).
// Same fail-open semantics as the login limiter: a Redis outage degrades to
// unthrottled ingestion, never a broken app.
const clientErrorLimiter = createClientErrorLimiter();

/** Extract the client IP exactly like auth.ts does: prefer X-Real-IP (set by
 * nginx/caddy), else the LAST XFF hop (nearest trusted proxy). */
function clientIp(req: NextRequest): string {
  const realIp = req.headers.get("x-real-ip")?.trim();
  if (realIp) return realIp;
  const xff = req.headers.get("x-forwarded-for");
  const last = xff ? xff.split(",").pop()?.trim() : "";
  return last || "unknown";
}

function asString(value: unknown, max = 2000): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return value.length > max ? value.slice(0, max) : value;
}

/**
 * P1 (production-readiness re-audit) — origin check. The endpoint is
 * same-origin only: a malicious third-party site can't flood the operator's
 * error tracker with garbage events. When `APP_URL` (or the `BETTER_AUTH_URL`
 * fallback) is set, the request's `Origin` (or `Referer` fallback) must match
 * it. When neither is configured, the request's own `Host` header is the
 * reference instead (see the QA-9 note inside) — production MUST still set
 * APP_URL so the check is pinned to a canonical host.
 */
function isSameOrigin(req: NextRequest): boolean {
  const origin = req.headers.get("origin");
  const referer = req.headers.get("referer");
  const allowed = process.env.APP_URL || process.env.BETTER_AUTH_URL;
  if (!allowed) {
    // No allowed origin configured. QA-9: browsers send `Origin` on EVERY
    // fetch POST (same-origin included), so the old `return !origin`
    // rejected 100% of real browser reports with 403 whenever APP_URL /
    // BETTER_AUTH_URL were unset (exactly the sandbox / unconfigured-deploy
    // case — errors were silently never reported). Without a configured
    // origin, "same-origin" is instead judged against the request's own
    // host: a browser cannot make a cross-site POST whose Origin host
    // equals the target Host, so this keeps third-party floods out while
    // letting legitimate reports through. Origin-less probes (curl) pass.
    if (!origin) return true;
    try {
      return new URL(origin).host === req.headers.get("host");
    } catch {
      return false;
    }
  }
  let allowedHost: string;
  try {
    allowedHost = new URL(allowed).host;
  } catch {
    return !origin;
  }
  if (origin) {
    try {
      return new URL(origin).host === allowedHost;
    } catch {
      return false;
    }
  }
  if (referer) {
    try {
      return new URL(referer).host === allowedHost;
    } catch {
      return false;
    }
  }
  // No Origin, no Referer — same-origin browser POST (fetch() with
  // `keepalive` and a relative URL omits Origin). Accept.
  return true;
}

export async function POST(req: NextRequest) {
  // Origin check first — reject cross-site POSTs before any parsing.
  if (!isSameOrigin(req)) {
    return new NextResponse(null, { status: 403, headers: { "Cache-Control": "no-store" } });
  }
  // PR-13 — per-IP budget before any parsing/storage. Over-budget requests
  // get a bare 429 (constant empty body, like every other response here).
  const state = await clientErrorLimiter.check(`ip:${clientIp(req)}`);
  if (state.blocked) {
    return new NextResponse(null, {
      status: 429,
      headers: { "Cache-Control": "no-store", "Retry-After": String(state.retryAfterSec) },
    });
  }
  await clientErrorLimiter.hit(`ip:${clientIp(req)}`);
  const raw = await req.text().catch(() => "");
  if (!raw || raw.length > MAX_BODY_BYTES) {
    return new NextResponse(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return new NextResponse(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  }

  const body = (parsed ?? {}) as Record<string, unknown>;
  const message = asString(body.message);
  if (!message) {
    return new NextResponse(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  }

  const err = new Error(`[client] ${message}`);
  const stack = asString(body.stack);
  if (stack) err.stack = stack;

  captureError(err, {
    source: asString(body.source, 200) ?? "client-bridge",
    ...(asString(body.digest, 200) ? { digest: asString(body.digest, 200)! } : {}),
    ...(asString(body.url, 500) ? { url: asString(body.url, 500)! } : {}),
  });

  // Constant response — never echo request data back.
  return new NextResponse(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}

export async function GET() {
  return new NextResponse(null, { status: 405, headers: { Allow: "POST", "Cache-Control": "no-store" } });
}
