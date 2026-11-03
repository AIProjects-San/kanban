"use client";

// ---------------------------------------------------------------------------
// PR-48/PR-49 — the Better Auth client (the only auth client since the
// migration cleanup). Components that need a session or a sign-in/out call
// the wrappers in `src/hooks/use-app-session.ts` (useAppSession /
// appSignIn / appSignOut), which drive this client.
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
