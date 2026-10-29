import { NextResponse, type NextRequest } from "next/server";
import { getToken } from "next-auth/jwt";

// ---------------------------------------------------------------------------
// Self-healing session cookie guard
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

// Mirrors the cookie name pinned in src/lib/auth.ts (the app sets it
// explicitly, so it is identical in dev and production — no __Secure- prefix).
const SESSION_COOKIE = "next-auth.session-token";

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
  const raw = req.cookies.get(SESSION_COOKIE)?.value;
  const secret = process.env.NEXTAUTH_SECRET;

  // No cookie to check, or no explicit secret: in dev without NEXTAUTH_SECRET
  // the Node runtime signs with an ephemeral per-process secret that this
  // bundle cannot verify against — pass through untouched rather than risk
  // clearing cookies that are actually valid for that secret.
  if (!raw || !secret) return NextResponse.next();

  let valid = false;
  try {
    valid =
      (await getToken({ req, secret, cookieName: SESSION_COOKIE })) !== null;
  } catch {
    // Treat unexpected decode failures (malformed cookie, crypto errors) the
    // same as a stale cookie — clearing it is always the safe recovery.
    valid = false;
  }
  if (valid) return NextResponse.next();

  // Stale or corrupt session cookie. Strip it from the request we forward
  // (RequestCookies.delete rewrites the cookie header) and expire it in the
  // browser so it never comes back.
  req.cookies.delete(SESSION_COOKIE);
  const res = NextResponse.next({ request: { headers: req.headers } });
  res.cookies.set(SESSION_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  return res;
}
