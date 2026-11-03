"use client";

// ---------------------------------------------------------------------------
// PR-48 — flag-aware client auth surface (auth migration Phase 1).
//
// Every client consumer that previously imported next-auth/react directly
// (useSession / signIn / signOut / SessionProvider) funnels through the
// helpers in this file. While NEXT_PUBLIC_AUTH_STACK=nextauth they are
// pass-throughs to the v4 stack; on "better" they drive the Better Auth
// client. The switch is build-time constant, so each wrapper picks its
// implementation once at module load — no per-render branching.
//
// Shape contract (what components consume): a next-auth-shaped session —
// `{ user: { id, name, email, role } } | null` plus `status`. The Better
// Auth path normalizes its `{ user, session }` payload into that shape so
// not one component changes.
// ---------------------------------------------------------------------------

import { IS_BETTER_AUTH } from "@/lib/auth-stack";
import { useSession as useNextAuthSession } from "next-auth/react";
import { authClient } from "@/lib/auth-client-better";
import type { Session } from "next-auth";

// --- session hook -----------------------------------------------------------

function useNextAuthSessionNormalized() {
  const { data, status } = useNextAuthSession();
  return { data: (data as Session | null) ?? null, status };
}

function useBetterSessionNormalized() {
  const { data, isPending, error } = authClient.useSession();
  const session = data as
    | { user: { id: string; name?: string; email?: string; role?: string } }
    | null
    | undefined;
  return {
    data:
      session?.user?.id
        ? ({
            user: {
              id: session.user.id,
              name: session.user.name ?? "",
              email: session.user.email ?? "",
              role: session.user.role ?? "MEMBER",
            },
          } as unknown as Session)
        : null,
    status: error ? "unauthenticated" : isPending ? "loading" : "authenticated",
  };
}

/**
 * next-auth-shaped session for either stack:
 *   { data: { user: { id, name, email, role } } | null, status }
 */
/* eslint-disable react-hooks/rules-of-hooks --
 * IS_BETTER_AUTH is a BUILD-TIME constant (NEXT_PUBLIC_AUTH_STACK is
 * inlined by the compiler), so exactly one hook implementation ever runs
 * and the call order is identical on every render of a given build. */
export function useAppSession() {
  return IS_BETTER_AUTH
    ? useBetterSessionNormalized()
    : useNextAuthSessionNormalized();
}
/* eslint-enable react-hooks/rules-of-hooks */

// --- sign-in ----------------------------------------------------------------

/**
 * Credentials sign-in on whichever stack is active. Mirrors the v4
 * `signIn("credentials", { redirect: false })` contract: resolves with
 * `{ ok, error }` — the caller owns navigation (window.location.replace on
 * success, toast on error).
 */
export async function appSignIn(
  email: string,
  password: string,
): Promise<{ ok: boolean; error?: string }> {
  if (IS_BETTER_AUTH) {
    const { error } = await authClient.signIn.email({ email, password });
    return {
      ok: !error,
      error: error ? "Invalid email or password." : undefined,
    };
  }
  const { signIn } = await import("next-auth/react");
  const res = await signIn("credentials", {
    email,
    password,
    redirect: false,
    callbackUrl: "/",
  });
  return { ok: !res?.error, error: res?.error ?? undefined };
}

// --- sign-out ---------------------------------------------------------------

/**
 * Sign out on whichever stack is active, then hard-navigate to the login
 * screen. The v4 branch keeps the race-hardened wrapper (lib/signout.ts);
 * the Better Auth branch is a plain POST + replace — the v4 keepalive races
 * it works around are next-auth/react client internals and do not exist in
 * the Better Auth client (§6 port map).
 */
export async function appSignOut(): Promise<void> {
  if (IS_BETTER_AUTH) {
    try {
      await authClient.signOut();
    } catch {
      // Network error / server hiccup — fall through to the hard navigation
      // so the user is never stranded on an authenticated page.
    }
    if (typeof window !== "undefined") {
      window.location.replace("/");
    }
    return;
  }
  const { appSignOut: v4SignOut } = await import("@/lib/signout");
  await v4SignOut();
}
