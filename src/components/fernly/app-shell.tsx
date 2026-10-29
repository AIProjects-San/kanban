"use client";

import { useEffect } from "react";
import { useSession } from "next-auth/react";
import { useApp, type AccentTheme } from "@/store/app-store";
import { useRefresh } from "@/hooks/use-refresh";
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";
import { Sidebar } from "@/components/fernly/sidebar";
import { Topbar } from "@/components/fernly/topbar";
import { CommandPalette } from "@/components/fernly/command-palette";
import { InboxDrawer } from "@/components/fernly/inbox-drawer";
import { TaskModal } from "@/components/fernly/task-modal";
import { ProjectModal } from "@/components/fernly/project-modal";
import { MemberModal } from "@/components/fernly/member-modal";
import { UserModal } from "@/components/fernly/user-modal";
import { AssignmentModal } from "@/components/fernly/assignment-modal";
import { DashboardView } from "@/components/views/dashboard-view";
import { TasksView } from "@/components/views/tasks-view";
import { CalendarView } from "@/components/views/calendar-view";
import { AnalyticsView } from "@/components/views/analytics-view";
import { TeamView } from "@/components/views/team-view";
import { SettingsView } from "@/components/views/settings-view";
import { HelpView } from "@/components/views/help-view";
import { AuditView } from "@/components/views/audit-view";
import { UsersView } from "@/components/views/users-view";
import { ProjectsView } from "@/components/views/projects-view";
import { WorkspaceSettingsView } from "@/components/views/workspace-settings-view";
import { LoginScreen } from "@/components/auth/login-screen";
import { markAllNotificationsRead } from "@/server-actions/data";
import type {
  ProjectT, TaskT, TeamMemberT, CalendarEventT, NotificationT, ReminderT, TimeEntryT, MessageT,
} from "@/lib/types";

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
  const { data: session, status } = useSession();
  const { view, refreshTick, setAccent, setDark } = useApp();
  const refresh = useRefresh();
  useKeyboardShortcuts();

  // Apply user settings from DB on mount — overrides localStorage defaults
  // so theme/dark mode follow the user across machines.
  useEffect(() => {
    if (user?.settings) {
      // The DB column is a free-form string; narrow it back to the
      // known AccentTheme union. Unknown values fall back to "forest"
      // (the default) rather than crashing the store.
      const accent = user.settings.accent as AccentTheme;
      setAccent(accent);
      setDark(user.settings.dark);
    }
  }, [user?.settings, user?.settings?.accent, user?.settings?.dark, setAccent, setDark]);

  // Loading state
  if (status === "loading") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="w-8 h-8 rounded-full border-2 border-primary border-t-transparent animate-spin" />
      </div>
    );
  }

  // Not authenticated → show login
  if (status === "unauthenticated" || !session || !user) {
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
              ["settings", "users", "audit", "workspace-settings", "help"].includes(view)
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
            {view === "analytics" && (
              <AnalyticsView
                tasks={data.tasks}
                timeEntries={data.timeEntries}
                members={data.members}
                projects={data.projects}
              />
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
          </div>
        </main>
      </div>

      <CommandPalette />
      <InboxDrawer messages={data.messages} members={data.members} currentUser={userProfile} />
      <TaskModal tasks={data.tasks} projects={data.projects} members={data.members} />
      <ProjectModal members={data.members} projects={data.projects} />
      <MemberModal />
      <UserModal />
      <AssignmentModal projects={data.projects} />
    </div>
  );
}
