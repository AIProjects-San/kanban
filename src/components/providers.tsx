"use client";

import { SessionProvider } from "next-auth/react";
import type { Session } from "next-auth";
// L-P1-19 — installs `window[ERROR_BRIDGE_KEY]` so client error boundaries
// (src/app/error.tsx, global-error.tsx) can report to the server-side error
// reporter. Side-effect import: keep it before any view can crash.
import "@/lib/client-error-bridge";

export function Providers({
  children,
  session,
}: {
  children: React.ReactNode;
  session: Session | null;
}) {
  return <SessionProvider session={session}>{children}</SessionProvider>;
}
