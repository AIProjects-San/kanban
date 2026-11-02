import NextAuth from "next-auth";
import { authOptions } from "@/lib/auth";
import { clearCookieHeaders } from "@/lib/auth-cookies";

// ---------------------------------------------------------------------------
// Wrap NextAuth so a successful sign-out also expires the CSRF and
// callback-url cookies — NextAuth only clears the session-token itself, and
// a stale CSRF cookie signed with a previous NEXTAUTH_SECRET can wedge the
// next sign-in attempt (we already self-heal the session cookie in
// `src/proxy.ts`, but the CSRF cookie is harder to validate there because
// the token is hashed, not encrypted).
//
// Strategy: pass every request through NextAuth unchanged, then if the
// matched route was `POST /api/auth/signout` *append* a Set-Cookie expiry
// header for every auth cookie. We append rather than overwrite so we never
// lose anything NextAuth itself set on the way out (e.g. the session-token
// deletion, which carries the same flags as the original).
//
// Note: Next 16 made route-handler params a `Promise<…>`; NextAuth v4
// expects the older synchronous shape, so we `await` the params and pass
// the resolved object through.
// ---------------------------------------------------------------------------

const authHandler = NextAuth(authOptions);

type Ctx = { params: Promise<{ nextauth: string[] }> };

async function handle(req: Request, ctx: Ctx): Promise<Response> {
  const params = await ctx.params;
  const res = await authHandler(req, { params });

  const segments = params.nextauth ?? [];
  const path = segments.join("/");
  // The client `signOut()` helper POSTs to `/api/auth/signout`. We don't
  // gate on `req.method === "POST"` because NextAuth also answers a GET
  // confirmation form on the same path, and a logout-by-GET should clean
  // up just as thoroughly.
  if (path !== "signout") return res;

  const headers = new Headers(res.headers);
  for (const value of clearCookieHeaders()) {
    headers.append("Set-Cookie", value);
  }
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

export { handle as GET, handle as POST };
