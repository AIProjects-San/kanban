// ---------------------------------------------------------------------------
// Trusted-proxy client-IP extraction — the single shared convention for the
// auth stack (sign-in throttling, audit rows, Better Auth's own IP config).
//
// Prefer `x-real-ip` (set unconditionally by our nginx/caddy edge), fall
// back to the LAST `x-forwarded-for` hop (the closest trusted proxy — the
// hop OUR proxy appended, not a client-supplied first hop). Taking the
// FIRST hop instead would let a client spoof its IP and evade the per-IP
// throttle.
//
// History: this helper used to live in `lib/auth-request-context.ts` next
// to an AsyncLocalStorage bridge that existed solely to give NextAuth v4's
// signOut event access to the request (PR-34). The v4 stack is gone
// (PR-49 cleanup) and Better Auth's hooks receive the request directly,
// so only this extraction helper remains.
// ---------------------------------------------------------------------------

/**
 * Extract the client IP using the trusted-proxy convention.
 *
 * @param header a lookup function so both fetch `Headers` and plain objects
 *   can use the same logic.
 */
export function extractClientIp(header: (name: string) => string | null | undefined): string {
  const realIp = (header("x-real-ip") ?? "").trim();
  if (realIp) return realIp;
  const xff = header("x-forwarded-for") ?? "";
  const last = xff ? xff.split(",").pop()?.trim() : "";
  if (last) return last;
  return "unknown";
}
