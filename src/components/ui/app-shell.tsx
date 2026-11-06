"use client";

import { useEffect } from "react";
import dynamic from "next/dynamic";
import { useApp, type AccentTheme } from "@/store/app-store";
import { useRefresh } from "@/hooks/use-refresh";
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";
import { Sidebar } from "@/components/ui/sidebar";
import { Topbar } from "@/components/ui/topbar";
import { CommandPalette } from "@/components/ui/command-palette";
import { InboxDrawer } from "@/components/ui/inbox-drawer";
import { TaskModal } from "@/components/ui/task-modal";
import { ProjectModal } from "@/components/ui/project-modal";
import { ProjectDetailModal } from "@/components/ui/project-detail-modal";
import { MemberModal } from "@/components/ui/member-modal";
import { UserModal } from "@/components/ui/user-modal";
import { AssignmentModal } from "@/components/ui/assignment-modal";
import { DashboardView } from "@/components/views/dashboard-view";
import { TasksView } from "@/components/views/tasks-view";
import { ProjectsView } from "@/components/views/projects-view";
import { TeamView } from "@/components/views/team-view";
import { SettingsView } from "@/components/views/settings-view";
import { LoginScreen } from "@/components/auth/login-screen";
import { markAllNotificationsRead, getMyPermissions } from "@/server-actions/data";
import type {
  ProjectT, TaskT, TeamMemberT, CalendarEventT, NotificationT, ReminderT, TimeEntryT, MessageT,
} from "@/lib/types";
import { useAppSession } from "@/hooks/use-app-session";

// ---------------------------------------------------------------------------
// L-P1-17 — Code splitting. Heavy and rarely-opened views are lazy-loaded
// via next/dynamic so they don't ship in the initial JS bundle. The biggest
// win is AnalyticsView (Recharts is ~100KB gzipped). Each gets its own chunk
// that only loads when the user opens that view.
// ---------------------------------------------------------------------------

const CalendarView = dynamic(() => import("@/components/views/calendar-view").then(m => ({ default: m.CalendarView })), {
  ssr: false,
  loading: () => <div className="p-6 text-sm text-muted-foreground">Loading calendar…</div>,
});

const AnalyticsView = dynamic(() => import("@/components/views/analytics-view").then(m => ({ default: m.AnalyticsView })), {
  ssr: false,
  loading: () => <div className="p-6 text-sm text-muted-foreground">Loading analytics…</div>,
});

const HelpView = dynamic(() => import("@/components/views/help-view").then(m => ({ default: m.HelpView })), {
  ssr: false,
  loading: () => <div className="p-6 text-sm text-muted-foreground">Loading help…</div>,
});

const AuditView = dynamic(() => import("@/components/views/audit-view").then(m => ({ default: m.AuditView })), {
  ssr: false,
  loading: () => <div className="p-6 text-sm text-muted-foreground">Loading audit log…</div>,
});

const UsersView = dynamic(() => import("@/components/views/users-view").then(m => ({ default: m.UsersView })), {
  ssr: false,
  loading: () => <div className="p-6 text-sm text-muted-foreground">Loading users…</div>,
});

const WorkspaceSettingsView = dynamic(() => import("@/components/views/workspace-settings-view").then(m => ({ default: m.WorkspaceSettingsView })), {
  ssr: false,
  loading: () => <div className="p-6 text-sm text-muted-foreground">Loading workspace settings…</div>,
});

const BugsView = dynamic(() => import("@/components/views/bugs-view").then(m => ({ default: m.BugsView })), {
  ssr: false,
  loading: () => <div className="p-6 text-sm text-muted-foreground">Loading bugs…</div>,
});

const LeaveView = dynamic(() => import("@/components/views/leave-view").then(m => ({ default: m.LeaveView })), {
  ssr: false,
  loading: () => <div className="p-6 text-sm text-muted-foreground">Loading leave…</div>,
});

const HRView = dynamic(() => import("@/components/views/hr-view").then(m => ({ default: m.HRView })), {
  ssr: false,
  loading: () => <div className="p-6 text-sm text-muted-foreground">Loading HR console…</div>,
});

const HiringView = dynamic(() => import("@/components/views/hiring-view").then(m => ({ default: m.HiringView })), {
  ssr: false,
  loading: () => <div className="p-6 text-sm text-muted-foreground">Loading hiring pipeline…</div>,
});

const PayrollView = dynamic(() => import("@/components/views/payroll-view").then(m => ({ default: m.PayrollView })), {
  ssr: false,
  loading: () => <div className="p-6 text-sm text-muted-foreground">Loading payroll…</div>,
});

const MyPayslipsView = dynamic(() => import("@/components/views/my-payslips-view").then(m => ({ default: m.MyPayslipsView })), {
  ssr: false,
  loading: () => <div className="p-6 text-sm text-muted-foreground">Loading your payslips…</div>,
});

const MyInterviewsView = dynamic(() => import("@/components/views/my-interviews-view").then(m => ({ default: m.MyInterviewsView })), {
  ssr: false,
  loading: () => <div className="p-6 text-sm text-muted-foreground">Loading your interviews…</div>,
});

const MyAttendanceView = dynamic(() => import("@/components/views/my-attendance-view").then(m => ({ default: m.MyAttendanceView })), {
  ssr: false,
  loading: () => <div className="p-6 text-sm text-muted-foreground">Loading your attendance…</div>,
});

interface AppShellProps {
  data: {
    projects: ProjectT[];
    tasks: TaskT[];
    members: TeamMemberT[];
    reminders: ReminderT[];
    notifications: NotificationT[];
    timeEntries: TimeEntryT[];
    events: CalendarEventT[];
    messages: MessageT[];
    stats: {
      total: number; ended: number; running: number; pending: number; paused: number;
      weeklyCompletion: number; projectEndedPct: number;
    };
    scope?: { isMember: boolean; projectIds: string[] | null };
    /** PR-61 — MANAGER reporting subtree (user ids); empty for other roles. */
    managedUserIds?: string[];
    /** PR-64 — effective permissions (static ∪ DB ceiling) for the SSR user. */
    effectivePermissions?: string[];
  };
  user: {
    id: string;
    email: string;
    name: string;
    role: string;
    timezone: string;
    bio: string;
    avatarColor: string;
    settings?: {
      accent: string;
      dark: boolean;
      sidebarRail?: boolean | null;
      notifEmail: boolean;
      notifPush: boolean;
      notifMentions: boolean;
      notifDueToday: boolean;
      notifWeekly: boolean;
      notifProduct: boolean;
    } | null;
  } | null;
  greeting: string;
  todayDate: string;
}

export function AppShell({ data, user, greeting, todayDate }: AppShellProps) {
  const { data: session, status } = useAppSession();
  const { view, refreshTick, setEffectivePermissions, applyUserAppearance } = useApp();
  const refresh = useRefresh();
  useKeyboardShortcuts();

  // PR-65 — appearance is PER-USER. The DB row (UserSettings) is the source
  // of truth; the localStorage cache only avoids a theme flash for the SAME
  // user reloading. On every mount we apply the signed-in user's DB values
  // (defaults when the row is missing — never another user's cached theme)
  // and rebind the cache to this user. This is what stops one account's
  // appearance change from applying to every other account on the browser.
  useEffect(() => {
    if (!user) return;
    applyUserAppearance({
      userId: user.id,
      accent: (user.settings?.accent as AccentTheme) ?? "forest",
      dark: user.settings?.dark ?? false,
      rail: user.settings?.sidebarRail ?? false,
    });
  }, [user, applyUserAppearance]);

  // PR-64 — live RBAC refresh. Seed the client permission store from the
  // SSR payload (correct first paint), then poll so an admin's role-
  // permission save reflects for ALREADY-LOGGED-IN users within seconds:
  // bumpConfigCache() makes the server side fresh the moment Save is
  // clicked; this closes the client loop. Skips ticks while the tab is
  // hidden and re-checks on focus.
  useEffect(() => {
    setEffectivePermissions(data.effectivePermissions ?? []);
  }, [data.effectivePermissions, setEffectivePermissions]);

  useEffect(() => {
    // No point polling the login screen (the action 401s anyway) — after a
    // sign-in the page reloads and remounts the shell.
    if (!user) return;
    let cancelled = false;
    const tick = async () => {
      if (document.hidden) return;
      const res = await getMyPermissions();
      if (!cancelled && res.ok) setEffectivePermissions(res.data);
    };
    void tick(); // immediate first check (session may differ from SSR user)
    const interval = setInterval(() => { void tick(); }, 10_000);
    const onVisible = () => { if (!document.hidden) void tick(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [setEffectivePermissions, user]);

  // Not authenticated → show login.
  //
  // SSR parity (post PR-49 flip): gate on the SERVER-resolved session first.
  // page.tsx resolves the session via getBetterSession() at request time and
  // passes user === null for anonymous requests, so the login screen (with
  // the email input) lands in the server-rendered HTML instead of a spinner
  // that waits for the client session store to settle — which had regressed
  // SSR-only rendering during the Better Auth flip (prod-smoke caught it).
  // The client session takes over once it settles: a server-known user
  // renders the shell immediately, and a mid-session flip to
  // "unauthenticated" still returns to the login screen.
  if (
    !user ||
    status === "unauthenticated" ||
    (status !== "loading" && !session)
  ) {
    return <LoginScreen />;
  }

  const userProfile = {
    id: user.id,
    name: user.name,
    email: user.email,
    avatarColor: user.avatarColor,
    role: user.role,
  };

  return (
    <div className="min-h-screen flex bg-background">
      {/* PR-58 — grouped collapsible sidebar (no inline project list; the
          Projects view itself lists the user's scoped projects). */}
      <Sidebar />
      <div className="flex-1 flex flex-col min-w-0">
        <Topbar
          notifs={data.notifications}
          messages={data.messages}
          user={userProfile}
          onMarkAllRead={async () => {
            await markAllNotificationsRead();
            // L-P0-1 fix: refresh server-component props so the new read state
            // is fetched. useRefresh also bumps the Zustand tick so the topbar
            // remounts with the fresh notifs array.
            refresh();
          }}
        />
        <main className="flex-1 overflow-y-auto f-scroll">
          <div
            key={`${view}-${refreshTick}`}
            className={`f-view-enter p-4 lg:p-6 ${
              ["settings", "users", "audit", "workspace-settings", "help", "bugs", "leave", "hr"].includes(view)
                ? "w-full"
                : "max-w-7xl mx-auto"
            }`}
          >
            {view === "dashboard" && (
              <DashboardView
                projects={data.projects}
                members={data.members}
                reminders={data.reminders}
                tasks={data.tasks}
                notifs={data.notifications}
                stats={data.stats}
                user={userProfile}
                greeting={greeting}
                todayDate={todayDate}
              />
            )}
            {view === "tasks" && (
              <TasksView
                tasks={data.tasks}
                projects={data.projects}
                members={data.members}
                currentUser={user ? { name: user.name, role: user.role } : null}
              />
            )}
            {view === "projects" && (
              <ProjectsView
                projects={data.projects}
                tasks={data.tasks}
              />
            )}
            {view === "calendar" && <CalendarView events={data.events} />}
            {/* PR-63 — the view fetches its own role-scoped data
                (getAnalyticsData): MEMBER self, MANAGER team+filter,
                ADMIN own-first + Everyone/manager-team/individual filter. */}
            {view === "analytics" && (
              <AnalyticsView user={{ id: user.id, name: user.name, role: user.role }} />
            )}
            {view === "team" && <TeamView members={data.members} tasks={data.tasks} projects={data.projects} timeEntries={data.timeEntries} currentUser={userProfile} />}
            {view === "settings" && <SettingsView user={user} />}
            {view === "help" && <HelpView />}
            {view === "audit" && <AuditView currentUser={user} />}
            {view === "users" && (
              <UsersView
                currentUser={user}
                projects={data.projects}
              />
            )}
            {view === "workspace-settings" && (
              <WorkspaceSettingsView currentUser={user} />
            )}
            {view === "bugs" && (
              <BugsView currentUser={user} projects={data.projects} tasks={data.tasks} />
            )}
            {view === "leave" && <LeaveView currentUser={user} />}
            {view === "hr" && <HRView currentUser={user} />}
            {view === "hiring" && <HiringView currentUser={user} />}
            {view === "payroll" && <PayrollView currentUser={user} />}
            {view === "my-payslips" && <MyPayslipsView currentUser={user} />}
            {view === "my-interviews" && <MyInterviewsView currentUser={user} />}
            {view === "my-attendance" && <MyAttendanceView currentUser={user} />}
          </div>
        </main>
      </div>

      <CommandPalette />
      <InboxDrawer messages={data.messages} members={data.members} currentUser={userProfile} />
      {/* PR-61 — members + managedUserIds feed the row-level task-delete
          rule (lib/task-delete.ts): assignee / project owner / manager-of-
          team see the Delete button; everyone else doesn't. */}
      <TaskModal tasks={data.tasks} projects={data.projects} members={data.members} managedUserIds={data.managedUserIds} />
      {/* PR-59 — read-oriented project detail (info + members + history).
          Mounted BEFORE ProjectModal so the edit form layers on top of it. */}
      <ProjectDetailModal projects={data.projects} members={data.members} tasks={data.tasks} />
      <ProjectModal members={data.members} projects={data.projects} />
      <MemberModal />
      <UserModal />
      <AssignmentModal projects={data.projects} />
    </div>
  );
}
