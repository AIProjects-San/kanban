"use client";

// ---------------------------------------------------------------------------
// PR-48/PR-49 — the client auth surface (Better Auth, the only stack).
//
// Every client consumer that once imported next-auth/react directly
// (useSession / signIn / signOut / SessionProvider) funnels through the
// helpers in this file. They drive the Better Auth client
// (src/lib/auth-client-better.ts).
//
// Shape contract (what components consume):
//   { data: { user: { id, name, email, role } } | null, status }
// — the next-auth-shaped session the UI was built against, normalised from
// Better Auth's { user, session } payload so not one component changes.
// ---------------------------------------------------------------------------

import { authClient } from "@/lib/auth-client-better";

export type AppSessionStatus = "loading" | "authenticated" | "unauthenticated";

export interface AppSession {
  user: { id: string; name: string; email: string; role: string };
}

// --- session hook -----------------------------------------------------------

/**
 * Session hook: { data, status } in the shape the UI components expect.
 */
export function useAppSession(): {
  data: AppSession | null;
  status: AppSessionStatus;
} {
  const { data, isPending, error } = authClient.useSession();
  const session = data as
    | { user: { id: string; name?: string; email?: string; role?: string } }
    | null
    | undefined;
  return {
    data:
      session?.user?.id
        ? {
            user: {
              id: session.user.id,
              name: session.user.name ?? "",
              email: session.user.email ?? "",
              role: session.user.role ?? "MEMBER",
            },
          }
        : null,
    status: error ? "unauthenticated" : isPending ? "loading" : "authenticated",
  };
}

// --- sign-in ----------------------------------------------------------------

/**
 * Credentials sign-in. Mirrors the old v4 `signIn("credentials",
 * { redirect: false })` contract: resolves with `{ ok, error }` — the
 * caller owns navigation (window.location.replace on success, toast on
 * error).
 */
export async function appSignIn(
  email: string,
  password: string,
): Promise<{ ok: boolean; error?: string }> {
  const { error } = await authClient.signIn.email({ email, password });
  return {
    ok: !error,
    error: error ? "Invalid email or password." : undefined,
  };
}

// --- sign-out ---------------------------------------------------------------

/**
 * Sign out, then hard-navigate to the login screen. A plain POST + replace
 * — the v4 keepalive races the old wrapper worked around were next-auth
 * client internals and do not exist in the Better Auth client (§6 port
 * map).
 */
export async function appSignOut(): Promise<void> {
  try {
    await authClient.signOut();
  } catch {
    // Network error / server hiccup — fall through to the hard navigation
    // so the user is never stranded on an authenticated page.
  }
  if (typeof window !== "undefined") {
    window.location.replace("/");
  }
}
