"use client";

// ---------------------------------------------------------------------------
// PR-48 — Better Auth client (auth migration Phase 1).
//
// The next-auth/react client stays in place for the v4 stack; components
// that need a session or a sign-in/out call go through the flag-aware
// wrappers (`useAppSession`, `appSignIn`, `appSignOut`) instead of picking
// a client directly.
// ---------------------------------------------------------------------------

import { createAuthClient } from "better-auth/react";

// basePath must match the server mount (src/lib/auth-better.ts). The base
// URL is same-origin by default — the fetches are relative, so preview
// proxies and production hosts both work without configuration.
export const authClient = createAuthClient({
  basePath: "/api/auth-better",
});

export type BetterSession = {
  user: {
    id: string;
    name: string;
    email: string;
    role: string;
  };
};
