import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getDashboardData, getUserProfile } from "@/server-actions/data";
import { getGreeting, getTodayDateStr } from "@/lib/greeting";
import { EMPTY_DASHBOARD_DATA, type DashboardData } from "@/lib/types";
import { AppShell } from "@/components/fernly/app-shell";
import { Providers } from "@/components/providers";

export const dynamic = "force-dynamic";

export default async function Home() {
  const session = await getServerSession(authOptions);
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
