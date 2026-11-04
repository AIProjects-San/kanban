"use client";

import { create } from "zustand";
import { STORAGE_KEYS } from "@/config/app";
import { NAV_GROUPS, groupIdOfView } from "@/config/navigation";

export type ViewKey =
  | "dashboard"
  | "tasks"
  | "projects"
  | "calendar"
  | "analytics"
  | "team"
  | "settings"
  | "help"
  | "audit"
  | "users"
  | "workspace-settings"
  | "bugs"
  | "leave"
  | "hr";

export type AccentTheme = "forest" | "ocean" | "plum" | "ember";

interface AppState {
  // Navigation
  view: ViewKey;
  setView: (v: ViewKey) => void;

  // Sidebar (mobile slide-over)
  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;

  // Sidebar layout — icon-only rail (desktop). Persisted per browser like the
  // theme so a reload keeps the user's chosen density.
  sidebarRail: boolean;
  toggleSidebarRail: () => void;

  // Collapsible nav groups (PR-58). "Smart minimal": on boot every group is
  // collapsed except the one holding the current view; navigating into a
  // group (sidebar click, G-shortcut, ⌘K) auto-expands it. Deliberately NOT
  // persisted — it follows the user's navigation instead.
  collapsedGroups: string[];
  toggleGroup: (groupId: string) => void;

  // PR-64 — effective permissions for the signed-in user's role (static
  // floor ∪ DB ceiling), as computed by the SERVER. Seeded from the SSR
  // dashboard payload and refreshed by the getMyPermissions poll, so an
  // admin's role-permission save reflects for already-logged-in users
  // without a re-login. null = not loaded yet → usePermissions falls back
  // to the static matrix (unit tests, pre-hydration renders).
  effectivePermissions: string[] | null;
  setEffectivePermissions: (permissions: string[]) => void;

  // Command palette
  cmdkOpen: boolean;
  setCmdkOpen: (open: boolean) => void;

  // Notifications drawer
  notifOpen: boolean;
  setNotifOpen: (open: boolean) => void;

  // Inbox drawer
  inboxOpen: boolean;
  setInboxOpen: (open: boolean) => void;
  inboxThreadId: string | null; // when set, show a specific thread
  openInboxThread: (threadId: string) => void;
  closeInboxThread: () => void;

  // Task modal
  taskModalOpen: boolean;
  taskModalEditId: string | null;
  taskModalDefaultStatus: string;
  openTaskModal: (editId?: string | null, defaultStatus?: string) => void;
  closeTaskModal: () => void;

  // Project modal
  projectModalOpen: boolean;
  projectModalEditId: string | null;
  openProjectModal: (editId?: string | null) => void;
  closeProjectModal: () => void;

  // Project detail modal (PR-59) — clicking a project card opens a
  // read-oriented detail view (info + assigned members + audit trail) for
  // EVERY role. Editing stays in the ProjectModal, layered on top.
  projectDetailId: string | null;
  openProjectDetail: (projectId: string) => void;
  closeProjectDetail: () => void;

  // Member modal
  memberModalOpen: boolean;
  openMemberModal: () => void;
  closeMemberModal: () => void;

  // User modal (create/edit user — full CRUD)
  userModalOpen: boolean;
  userModalEditId: string | null;
  openUserModal: (editId?: string | null) => void;
  closeUserModal: () => void;

  // Project assignment modal (assign a user to projects)
  assignmentModalUserId: string | null;
  openAssignmentModal: (userId: string) => void;
  closeAssignmentModal: () => void;

  // Shortcuts modal
  shortcutsOpen: boolean;
  setShortcutsOpen: (open: boolean) => void;

  // Toast refresh trigger — bump to invalidate React Query
  refreshTick: number;
  bumpRefresh: () => void;

  // Theme
  accent: AccentTheme;
  setAccent: (a: AccentTheme) => void;
  dark: boolean;
  setDark: (d: boolean) => void;
}

function loadInitial() {
  if (typeof window === "undefined") {
    return {
      accent: "forest" as AccentTheme,
      dark: false,
      rail: false,
    };
  }
  const savedAccent = localStorage.getItem(STORAGE_KEYS.accent) as AccentTheme | null;
  const savedDark = localStorage.getItem(STORAGE_KEYS.dark) === "1";
  const savedRail = localStorage.getItem(STORAGE_KEYS.rail) === "1";
  // Apply immediately so first paint is correct
  if (savedAccent) document.documentElement.setAttribute("data-accent", savedAccent);
  if (savedDark) document.documentElement.classList.add("dark");
  return { accent: savedAccent ?? "forest", dark: savedDark, rail: savedRail };
}

const initial = loadInitial();

// Smart-minimal boot state: everything collapsed except the current view's
// group (default view is dashboard → "overview" is expanded). This doubles
// as the accordion invariant: `collapsedGroups` holds every group id except
// the single open one (or all of them, when the user collapses the last
// open group).
const initialCollapsedGroups = NAV_GROUPS.map((g) => g.id).filter(
  (id) => id !== groupIdOfView("dashboard")
);

/** Accordion helper: every group except `openId` ends up collapsed. */
function accordionCollapsed(openId: string): string[] {
  return NAV_GROUPS.map((g) => g.id).filter((id) => id !== openId);
}

export const useApp = create<AppState>((set) => ({
  view: "dashboard",
  // Navigating auto-expands the target view's group so the active item
  // stays visible — and, per the accordion rule, closes every other group
  // ("previous should be collapsed after user selected one of the options").
  setView: (view) =>
    set(() => ({
      view,
      sidebarOpen: false,
      collapsedGroups: accordionCollapsed(groupIdOfView(view)),
    })),

  sidebarOpen: false,
  setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),

  sidebarRail: initial.rail,
  toggleSidebarRail: () =>
    set((s) => {
      const sidebarRail = !s.sidebarRail;
      if (typeof document !== "undefined") {
        localStorage.setItem(STORAGE_KEYS.rail, sidebarRail ? "1" : "0");
      }
      return { sidebarRail };
    }),

  collapsedGroups: initialCollapsedGroups,
  // Accordion (user request: "only one sidebar menu should be expanded at
  // once"): opening a collapsed group closes every other group; collapsing
  // the open group just collapses it (zero-open is a valid state).
  toggleGroup: (groupId) =>
    set((s) => ({
      collapsedGroups: s.collapsedGroups.includes(groupId)
        ? accordionCollapsed(groupId)
        : [...s.collapsedGroups, groupId],
    })),

  effectivePermissions: null,
  setEffectivePermissions: (permissions) => set({ effectivePermissions: permissions }),

  cmdkOpen: false,
  setCmdkOpen: (cmdkOpen) => set({ cmdkOpen }),

  notifOpen: false,
  setNotifOpen: (notifOpen) => set({ notifOpen }),

  inboxOpen: false,
  setInboxOpen: (inboxOpen) => set({ inboxOpen, inboxThreadId: null }),
  inboxThreadId: null,
  openInboxThread: (threadId) => set({ inboxOpen: true, inboxThreadId: threadId }),
  closeInboxThread: () => set({ inboxThreadId: null }),

  taskModalOpen: false,
  taskModalEditId: null,
  taskModalDefaultStatus: "TODO",
  openTaskModal: (editId = null, defaultStatus = "TODO") =>
    set({ taskModalOpen: true, taskModalEditId: editId, taskModalDefaultStatus: defaultStatus }),
  closeTaskModal: () =>
    set({ taskModalOpen: false, taskModalEditId: null }),

  projectModalOpen: false,
  projectModalEditId: null,
  openProjectModal: (editId = null) => set({ projectModalOpen: true, projectModalEditId: editId }),
  closeProjectModal: () => set({ projectModalOpen: false, projectModalEditId: null }),

  projectDetailId: null,
  openProjectDetail: (projectId) => set({ projectDetailId: projectId }),
  closeProjectDetail: () => set({ projectDetailId: null }),

  memberModalOpen: false,
  openMemberModal: () => set({ memberModalOpen: true }),
  closeMemberModal: () => set({ memberModalOpen: false }),

  userModalOpen: false,
  userModalEditId: null,
  openUserModal: (editId = null) => set({ userModalOpen: true, userModalEditId: editId }),
  closeUserModal: () => set({ userModalOpen: false, userModalEditId: null }),

  assignmentModalUserId: null,
  openAssignmentModal: (userId) => set({ assignmentModalUserId: userId }),
  closeAssignmentModal: () => set({ assignmentModalUserId: null }),

  shortcutsOpen: false,
  setShortcutsOpen: (shortcutsOpen) => set({ shortcutsOpen }),

  refreshTick: 0,
  bumpRefresh: () => set((s) => ({ refreshTick: s.refreshTick + 1 })),

  accent: initial.accent,
  setAccent: (accent) => {
    set({ accent });
    if (typeof document !== "undefined") {
      document.documentElement.setAttribute("data-accent", accent);
      localStorage.setItem(STORAGE_KEYS.accent, accent);
    }
  },
  dark: initial.dark,
  setDark: (dark) => {
    set({ dark });
    if (typeof document !== "undefined") {
      document.documentElement.classList.toggle("dark", dark);
      localStorage.setItem(STORAGE_KEYS.dark, dark ? "1" : "0");
    }
  },
}));
