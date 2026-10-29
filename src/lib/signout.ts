"use client";

// ---------------------------------------------------------------------------
// Client-side sign-out entrypoint
// ---------------------------------------------------------------------------
// All UI logout buttons funnel through this helper so the behaviour is
// consistent: hit the wrapped `/api/auth/signout` endpoint (which expires
// *all* auth cookies — see `app/api/auth/[...nextauth]/route.ts`), then
// navigate to the login page.
//
// Race-condition note (the CLIENT_FETCH_ERROR bug):
// -----------------------------------------------
// NextAuth's client `signOut()` has two modes:
//
//   • `redirect: true`  → after the POST resolves it does
//     `window.location.href = data.url` itself and returns. No further
//     fetches.
//
//   • `redirect: false` → after the POST resolves it calls
//     `await __NEXTAUTH._getSession({ event: "storage" })`, which fires
//     `GET /api/auth/session` to refresh the local session cache, and
//     *then* resolves.
//
// If we use `redirect: false` and immediately `window.location.replace("/")`
// ourselves, the hard navigation aborts the in-flight `/api/auth/session`
// fetch. The aborted fetch throws an `AbortError` inside NextAuth's
// `fetchData` helper, which catches it and logs `CLIENT_FETCH_ERROR` to
// the console — exactly the noise the user saw on every logout.
//
// Using `redirect: true` lets NextAuth perform the navigation itself and
// skips the `_getSession` call entirely, so there's no in-flight fetch to
// abort. We still pass through to `window.location.replace("/")` as a
// fallback if the POST throws (network error / server hiccup) so the user
// is never stranded on an authenticated page.
// ---------------------------------------------------------------------------

import { signOut } from "next-auth/react";

export async function fernlySignOut(): Promise<void> {
  try {
    // `redirect: true` makes NextAuth do `window.location.href = data.url`
    // itself (data.url is the absolute callbackUrl the server returns).
    // This avoids the `_getSession` fetch that `redirect: false` would
    // trigger and that our own navigation would race-AbortError.
    await signOut({ callbackUrl: "/", redirect: true });
    // signOut already navigated; the fallback below is a no-op for the
    // success path (same URL, replace semantics) but stays as a belt-
    // and-braces in case the browser hasn't torn the SPA down yet.
  } catch {
    // Network error / server hiccup — fall through to the hard navigation
    // so the user is never stranded on an authenticated page. The proxy
    // will re-validate any stale session cookie on the next request.
  }
  if (typeof window !== "undefined") {
    window.location.replace("/");
  }
}
