import {
  LayoutDashboard,
  CheckSquare,
  FolderKanban,
  Calendar,
  BarChart3,
  Users,
  Settings,
  HelpCircle,
  History,
  UserCog,
  Settings2,
  Bug,
  CalendarDays,
  Briefcase,
} from "lucide-react";
// Type-only import — erased at runtime, so the store may import this module
// (for group bookkeeping) without creating a require cycle.
import type { ViewKey } from "@/store/app-store";
import type { Permission } from "@/lib/rbac";

// ---------------------------------------------------------------------------
// PR-58 — Grouped navigation, single source of truth.
//
// Before this module the nav list existed in THREE hand-synced copies
// (sidebar.tsx, command-palette.tsx, use-keyboard-shortcuts.ts) and had
// already drifted once (see the command-palette drift regression tests).
// Everything that enumerates views — the grouped sidebar, the ⌘K palette and
// the G-prefix shortcuts — now derives from NAV_GROUPS below.
//
// Taxonomy (user-approved):
//   Overview       — Dashboard, Analytics
//   Work           — Projects, Tasks, Bugs
//   People         — Team, Calendar, Leave
//   HR             — HR Console (whole group hidden without hr:view; NOTE:
//                    the group label must never be visible to MEMBER —
//                    e2e hr-leave.feature asserts "sidebar should not
//                    contain HR", which is why Leave lives in People)
//   Administration — Users, Workspace Config, Audit Log (all gated)
//   General        — Settings, Help
// ---------------------------------------------------------------------------

export type NavIcon = React.ComponentType<{ size?: number; className?: string }>;

export interface NavLeaf {
  key: ViewKey;
  label: string;
  /** Label used by the ⌘K palette entry (defaults to `label`). */
  paletteLabel?: string;
  icon: NavIcon;
  /** Full hint rendered in a <kbd>, e.g. "G D". */
  shortcut: string;
  /** Single letter typed after G — drives useKeyboardShortcuts. */
  shortcutKey: string;
  /** RBAC gate; the leaf is hidden when the role lacks it. */
  permission?: Permission;
}

export interface NavGroup {
  /** Stable id — used for collapse state + aria-controls wiring. */
  id: string;
  label: string;
  items: NavLeaf[];
}

export const NAV_GROUPS: NavGroup[] = [
  {
    id: "overview",
    label: "Overview",
    items: [
      { key: "dashboard", label: "Dashboard", icon: LayoutDashboard, shortcut: "G D", shortcutKey: "d" },
      { key: "analytics", label: "Analytics", icon: BarChart3, shortcut: "G A", shortcutKey: "a" },
    ],
  },
  {
    id: "work",
    label: "Work",
    items: [
      // Plain leaf — the Projects view lists every project the server
      // scoped to the signed-in user (getScopedProjectIds), so the sidebar
      // deliberately carries no inline project list.
      { key: "projects", label: "Projects", icon: FolderKanban, shortcut: "G P", shortcutKey: "p" },
      { key: "tasks", label: "Tasks", icon: CheckSquare, shortcut: "G T", shortcutKey: "t" },
      { key: "bugs", label: "Bugs", icon: Bug, shortcut: "G B", shortcutKey: "b" },
    ],
  },
  {
    id: "people",
    label: "People",
    items: [
      { key: "team", label: "Team", icon: Users, shortcut: "G M", shortcutKey: "m" },
      { key: "calendar", label: "Calendar", icon: Calendar, shortcut: "G C", shortcutKey: "c" },
      // Leave is self-service for every role (docs/HR_MODULE_PLAN.md) — and
      // lives under People so the "HR" label never reaches MEMBER.
      { key: "leave", label: "Leave", icon: CalendarDays, shortcut: "G V", shortcutKey: "v" },
    ],
  },
  {
    id: "hr",
    label: "HR",
    items: [
      // HR console (queue / types & policies) needs hr:view (Admin, Manager, HR).
      { key: "hr", label: "HR Console", paletteLabel: "HR", icon: Briefcase, shortcut: "G R", shortcutKey: "r", permission: "hr:view" },
    ],
  },
  {
    id: "administration",
    label: "Administration",
    items: [
      // Users management + Workspace Config are admin-only (role:manage);
      // Audit Log is visible to roles with audit:view (Admin, Manager).
      { key: "users", label: "Users", icon: UserCog, shortcut: "G U", shortcutKey: "u", permission: "role:manage" },
      { key: "workspace-settings", label: "Workspace Config", icon: Settings2, shortcut: "G W", shortcutKey: "w", permission: "role:manage" },
      { key: "audit", label: "Audit Log", icon: History, shortcut: "G L", shortcutKey: "l", permission: "audit:view" },
    ],
  },
  {
    id: "general",
    label: "General",
    items: [
      { key: "settings", label: "Settings", icon: Settings, shortcut: "G S", shortcutKey: "s" },
      { key: "help", label: "Help", paletteLabel: "Help & Shortcuts", icon: HelpCircle, shortcut: "G H", shortcutKey: "h" },
    ],
  },
];

/** Flat leaf list in group order (palette + shortcut map derive from this). */
export function navLeaves(): NavLeaf[] {
  return NAV_GROUPS.flatMap((g) => g.items);
}

/** Group id that owns a view — powers auto-expand on navigation. */
export function groupIdOfView(view: ViewKey): string {
  const group = NAV_GROUPS.find((g) => g.items.some((i) => i.key === view));
  // Every ViewKey is present in NAV_GROUPS; the fallback keeps a future
  // unmapped view from crashing the store (it simply won't expand a group).
  return group?.id ?? "";
}
