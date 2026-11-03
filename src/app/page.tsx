import { getServerSession } from "next-auth";
import type { Session } from "next-auth";
import { authOptions } from "@/lib/auth";
import { isBetterAuthStack } from "@/lib/auth-stack";
import { getDashboardData, getUserProfile } from "@/server-actions/data";
import { getGreeting, getTodayDateStr } from "@/lib/greeting";
import { EMPTY_DASHBOARD_DATA, type DashboardData } from "@/lib/types";
import { AppShell } from "@/components/ui/app-shell";
import { Providers } from "@/components/providers";

export const dynamic = "force-dynamic";

// PR-48 — resolves the session on whichever auth stack the deployment runs
// (next-auth v4 JWT by default; Better Auth DB sessions when
// NEXT_PUBLIC_AUTH_STACK=better). Normalizes both to the Session shape the
// Providers/AppShell contract expects. The dynamic import keeps Better Auth
// out of the v4-mode page bundle.
async function resolveSession(): Promise<Session | null> {
  if (isBetterAuthStack()) {
    const { getBetterSession } = await import("@/lib/auth-better");
    const s = await getBetterSession();
    if (!s) return null;
    return {
      user: { id: s.userId, name: s.name, email: s.email, role: s.role },
    } as unknown as Session;
  }
  return getServerSession(authOptions);
}

export default async function Home() {
  const session = await resolveSession();
  let data: DashboardData = { ...EMPTY_DASHBOARD_DATA };
  let user: Awaited<ReturnType<typeof getUserProfile>> = null;

  if (session?.user?.id) {
    [data, user] = await Promise.all([
      // The loader derives role/name from the server-side session internally —
      // client-supplied values are never trusted for scoping.
      getDashboardData(),
      getUserProfile(session.user.id),
    ]);
  }

  // Compute the greeting and "today" date on the server using the user's
  // timezone so the server-rendered HTML matches the client during hydration.
  const greeting = getGreeting(user?.timezone);
  const todayDate = getTodayDateStr(user?.timezone);

  return (
    <Providers session={session}>
      <AppShell data={data} user={user} greeting={greeting} todayDate={todayDate} />
    </Providers>
  );
}
