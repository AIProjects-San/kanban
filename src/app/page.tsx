import { getBetterSession } from "@/lib/auth/auth-better";
import { getDashboardData, getUserProfile } from "@/server-actions/data";
import { getGreeting, getTodayDateStr } from "@/lib/shared/greeting";
import { EMPTY_DASHBOARD_DATA, type DashboardData } from "@/lib/types";
import { AppShell } from "@/components/ui/app-shell";
import { Providers } from "@/components/providers";

export const dynamic = "force-dynamic";

// PR-49 — resolves the session on the Better Auth stack (the only stack
// since the migration cleanup): the opaque fernly.session_token cookie is
// looked up against the Session table via getBetterSession().
export default async function Home() {
  const session = await getBetterSession();
  let data: DashboardData = { ...EMPTY_DASHBOARD_DATA };
  let user: Awaited<ReturnType<typeof getUserProfile>> = null;

  if (session?.userId) {
    [data, user] = await Promise.all([
      // The loader derives role/name from the server-side session internally —
      // client-supplied values are never trusted for scoping.
      getDashboardData(),
      getUserProfile(session.userId),
    ]);
  }

  // Compute the greeting and "today" date on the server using the user's
  // timezone so the server-rendered HTML matches the client during hydration.
  const greeting = getGreeting(user?.timezone);
  const todayDate = getTodayDateStr(user?.timezone);

  return (
    <Providers>
      <AppShell data={data} user={user} greeting={greeting} todayDate={todayDate} />
    </Providers>
  );
}
