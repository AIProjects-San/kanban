"use client";

import { IS_BETTER_AUTH } from "@/lib/auth-stack";
import { SessionProvider } from "next-auth/react";
import type { Session } from "next-auth";
// L-P1-19 — installs `window[ERROR_BRIDGE_KEY]` so client error boundaries
// (src/app/error.tsx, global-error.tsx) can report to the server-side error
// reporter. Side-effect import: keep it before any view can crash.
import "@/lib/client-error-bridge";

// PR-48 — on the better stack no provider is needed: authClient.useSession()
// is nanostores-based and self-fetches (or reads the 5-minute cookie cache
// through get-session). The v4 path keeps SessionProvider with the
// server-fetched session for instant hydration.
export function Providers({
  children,
  session,
}: {
  children: React.ReactNode;
  session: Session | null;
}) {
  if (IS_BETTER_AUTH) return <>{children}</>;
  return <SessionProvider session={session}>{children}</SessionProvider>;
}
