// ---------------------------------------------------------------------------
// Auth cookie inventory + helpers
// ---------------------------------------------------------------------------
// NextAuth's built-in `/api/auth/signout` handler only clears the *session*
// token. The CSRF and callback-url cookies survive, which is problematic in
// two scenarios we've already hit:
//
//   1. After a `NEXTAUTH_SECRET` rotation, the surviving CSRF cookie is signed
//      with the old secret; on the next sign-in attempt the CSRF check fails
//      and the user appears stuck on the login screen.
//   2. Cross-environment contamination (a developer who logged into the prod
//      preview, then back to localhost) leaves orphan cookies that confuse
//      the NextAuth cookie resolver.
//
// The wrapper in `app/api/auth/[...nextauth]/route.ts` calls
// `clearCookieHeaders()` on every successful POST to `/api/auth/signout` so
// the browser leaves with a clean cookie jar.
//
// `src/proxy.ts` already self-heals a stale *session* cookie on the next
// inbound request; this module covers the *other* auth cookies on the way
// out, so the two are complementary.

const IS_PROD = process.env.NODE_ENV === "production";

/**
 * Every auth-related cookie NextAuth may set, in both the dev
 * (`next-auth.*`) and prod (`__Secure-next-auth.*`) name spaces. We clear
 * both unconditionally — setting a Max-Age=0 cookie that did not exist is
 * a harmless no-op.
 */
export const AUTH_COOKIE_NAMES = [
  "next-auth.session-token",
  "next-auth.csrf-token",
  "next-auth.callback-url",
  "__Secure-next-auth.session-token",
  "__Secure-next-auth.csrf-token",
  "__Secure-next-auth.callback-url",
] as const;

/**
 * Build the Set-Cookie header values that expire every auth cookie. Use
 * these to extend a NextAuth response on signout (or any other path where
 * we want a hard reset of the auth cookie jar).
 *
 * The flags mirror the ones pinned in `src/lib/auth.ts` (httpOnly for the
 * session and CSRF cookies, sameSite=lax, path=/). Setting `Max-Age=0`
 * AND a 1970 `Expires` covers every browser flavour.
 */
export function clearCookieHeaders(): string[] {
  return AUTH_COOKIE_NAMES.map((name) => {
    const parts = [
      `${name}=`,
      "Path=/",
      "Max-Age=0",
      "Expires=Thu, 01 Jan 1970 00:00:01 GMT",
      "SameSite=Lax",
    ];
    // The session and CSRF cookies are httpOnly — include the flag so the
    // expiry matches the original attribute set and is honoured by every
    // browser. callback-url is *not* httpOnly in our config but adding the
    // flag to its expiry is harmless (the attribute only governs what the
    // browser does with a non-empty value).
    if (
      name.endsWith(".session-token") ||
      name.endsWith(".csrf-token")
    ) {
      parts.push("HttpOnly");
    }
    if (IS_PROD) parts.push("Secure");
    return parts.join("; ");
  });
}
