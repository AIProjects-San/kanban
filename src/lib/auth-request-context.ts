// SERVER-ONLY auth request context (PR-34, production-readiness round 2 —
// roadmap §6.6: "sign-out audit rows lack IP/UA").
//
// NextAuth v4's `signOut` event receives only `{ token }` — no request
// object — so the audit row it writes cannot include the source IP or user
// agent, unlike every other auth event (`auth.signed_in` records both for
// post-incident forensics). The strategic fix is the Auth.js v5 migration
// (roadmap §6.1); the tactical fix is this bridge:
//
//   • The route handler (app/api/auth/[...nextauth]/route.ts) wraps the
//     NextAuth handler in `runWithAuthRequestContext({ ip, userAgent })`.
//   • AsyncLocalStorage keeps the context bound to the request's async
//     chain — no races between concurrent sign-outs, no module-level
//     "latest request" slot that a parallel request could overwrite.
//   • events.signOut reads `getAuthRequestContext()` when writing the audit
//     row; undefined (tests, non-HTTP callers) simply omits the fields,
//     preserving the pre-PR-34 shape.
//
// `extractClientIp` centralizes the trusted-proxy IP logic that authorize()
// already implements (x-real-ip first, then the LAST x-forwarded-for hop —
// the hop added by OUR proxy, not the client-supplied first hop). Both
// call sites now share one implementation.

import { AsyncLocalStorage } from "node:async_hooks";

export interface AuthRequestContext {
  ip: string;
  userAgent: string;
}

const authRequestStorage = new AsyncLocalStorage<AuthRequestContext>();

/** Run `fn` with an auth request context bound to the current async chain. */
export function runWithAuthRequestContext<T>(
  ctx: AuthRequestContext,
  fn: () => T | PromiseLike<T>,
): Promise<T> {
  // Promise.resolve flattens sync, Promise, and PromiseLike callbacks
  // (NextAuth event handlers are typed Awaitable<T>).
  return Promise.resolve(authRequestStorage.run(ctx, fn));
}

/** The context of the request currently being handled (undefined outside one). */
export function getAuthRequestContext(): AuthRequestContext | undefined {
  return authRequestStorage.getStore();
}

/**
 * Extract the client IP using the trusted-proxy convention shared with
 * authorize(): prefer `x-real-ip` (set by our nginx/caddy edge), fall back
 * to the LAST `x-forwarded-for` hop (the closest trusted proxy). Taking the
 * FIRST hop instead would let a client spoof its IP and evade the per-IP
 * throttle — see the P1 edge-case audit note in lib/auth.ts.
 *
 * @param header a lookup function so both fetch `Headers` and plain objects
 *   (NextAuth's authorize() `req.headers`) can use the same logic.
 */
export function extractClientIp(header: (name: string) => string | null | undefined): string {
  const realIp = (header("x-real-ip") ?? "").trim();
  if (realIp) return realIp;
  const xff = header("x-forwarded-for") ?? "";
  const last = xff ? xff.split(",").pop()?.trim() : "";
  if (last) return last;
  return "unknown";
}
