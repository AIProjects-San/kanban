import { auth } from "@/lib/auth-better";

// ---------------------------------------------------------------------------
// PR-48 — Better Auth parallel stack mount (auth migration Phase 1).
//
// /api/auth-better/* serves the Better Auth 1.7 handler while NextAuth v4
// keeps serving /api/auth/* — production traffic is untouched until the
// NEXT_PUBLIC_AUTH_STACK cutover (Phase 3). The v4 route wrapper concerns
// (CSRF/callback cookie expiry, the ALS IP/UA bridge) do not apply here:
// sign-out expires the Better Auth session cookie itself, and the hooks get
// the request object directly (spike F6).
//
// The proxy (src/proxy.ts) deliberately does NOT intercept /api/auth-better
// — its matcher already excludes /api/auth, and the auth endpoints must
// rotate their own cookies without middleware racing them.
// ---------------------------------------------------------------------------

export const { GET, POST } = {
  GET: (req: Request) => auth.handler(req),
  POST: (req: Request) => auth.handler(req),
};
