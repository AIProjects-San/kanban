"use client";

// ---------------------------------------------------------------------------
// Client-side sign-out entrypoint
// ---------------------------------------------------------------------------
// All UI logout buttons funnel through this helper so the behaviour is
// consistent: clear the local NextAuth client cache, hit the wrapped
// `/api/auth/signout` endpoint (which expires *all* auth cookies — see
// `app/api/auth/[...nextauth]/route.ts`), then navigate to the login page.
//
// Previously each callsite inlined `signOut({ callbackUrl: "/", redirect:
// false }).then(() => window.location.replace(window.location.pathname))`,
// which (a) sent the user back to whatever view they were on instead of the
// login screen and (b) didn't guarantee a full document reload — leaving
// stale in-memory state from the previous session alive in the SPA.
// ---------------------------------------------------------------------------

import { signOut } from "next-auth/react";

export async function fernlySignOut(): Promise<void> {
  // `signOut({ redirect: false })` returns a Promise that resolves once the
  // POST /api/auth/signout round-trip completes — by then our route wrapper
  // has already appended the cookie-expiry headers, so the browser cookie
  // jar is clean before we navigate.
  try {
    await signOut({ callbackUrl: "/", redirect: false });
  } catch {
    // Network errors / server hiccups still shouldn't strand the user on an
    // authenticated page — fall through to the hard navigation, which will
    // re-run the proxy and (with cookies gone) land on the login screen.
  }
  // Hard navigation to the root so the SPA tears down fully and the server
  // re-renders from a clean slate (no leftover Zustand state, no cached
  // session). Using `replace` keeps the logout out of the history stack.
  if (typeof window !== "undefined") {
    window.location.replace("/");
  }
}
