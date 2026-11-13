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
  CalendarClock,
  Briefcase,
  UserPlus,
  Landmark,
  Wallet,
  CalendarCheck,
} from "lucide-react";
import type { Permission } from "@/lib/rbac";

// The view registry — the single source of the SPA's view keys. ViewKey is
// derived from this tuple, so a key missing here (or typo'd in NAV_GROUPS)
// fails to compile. The store re-exports the type; nothing imports upward.
export const VIEW_KEYS = [
  "dashboard",
  "tasks",
  "projects",
  "calendar",
  "analytics",
  "team",
  "settings",
  "help",
  "audit",
  "users",
  "workspace-settings",
  "bugs",
  "leave",
  "hr",
  "hiring",
  "payroll",
  "my-payslips",
  "my-interviews",
  "my-attendance",
] as const;

export type ViewKey = (typeof VIEW_KEYS)[number];

/** Views rendered full-width (wide console tables); everything else is
 * centered at max-w-7xl. Derived here so adding a wide view is a registry
 * edit, not a render-condition edit buried in app-shell. */
export const WIDE_VIEWS: readonly ViewKey[] = [
  "settings",
  "users",
  "audit",
  "workspace-settings",
  "help",
  "bugs",
  "leave",
  "hr",
  "hiring",
  "payroll",
];

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
      // Interviewer self-service (persona-audit P0-5 / D-04) — every role
      // sees their OWN assigned interview stages + fills their own scorecard
      // (own data, like Leave/My Payslips — deliberately NOT permission-gated;
      // getMyInterviews scopes to the caller's rows in the WHERE clause).
      // Lives under People so MEMBER never needs the HR group. The Hiring
      // board itself stays hiring:view (ADMIN/HR/MANAGER) — candidate PII
      // (D-12 direction) must not reach every member.
      { key: "my-interviews", label: "My Interviews", icon: CalendarClock, shortcut: "G J", shortcutKey: "j" },
      // Payslip self-service (persona-audit P0-1 / D-02) — every role sees
      // their OWN payslips from LOCKED runs; deliberately NOT permission-
      // gated (own data, like Leave). The full Payroll console stays
      // payroll:manage — "My Payslips" must never match a "Payroll"
      // substring assertion in e2e (sidebar contracts).
      { key: "my-payslips", label: "My Payslips", icon: Wallet, shortcut: "G N", shortcutKey: "n" },
      // Attendance self-service read (F1.3) — every role sees their OWN
      // marked days; deliberately NOT permission-gated (own data, like
      // Leave/My Payslips — getMyAttendance scopes to the caller in the
      // WHERE clause). No self-marking (decision §9.1): the view is
      // read-only and points corrections at HR. Marking lives in the HR
      // console's Attendance tab (attendance:manage).
      { key: "my-attendance", label: "My Attendance", icon: CalendarCheck, shortcut: "G K", shortcutKey: "k" },
    ],
  },
  {
    id: "hr",
    label: "HR",
    items: [
      // HR console (queue / types & policies) needs hr:view (Admin, Manager, HR).
      { key: "hr", label: "HR Console", paletteLabel: "HR", icon: Briefcase, shortcut: "G R", shortcutKey: "r", permission: "hr:view" },
      // Recruitment pipeline (docs/RECRUITMENT_MODULE_PLAN.md) — hiring:view
      // (Admin, HR, Manager-as-interviewer). Inside the HR group so MEMBER
      // never sees the group at all (e2e contract).
      { key: "hiring", label: "Hiring", paletteLabel: "Hiring pipeline", icon: UserPlus, shortcut: "G I", shortcutKey: "i", permission: "hiring:view" },
      // Payroll (R7) — salary data is ADMIN+HR only (payroll:manage); the
      // leaf is hidden entirely for MANAGER/MEMBER so payslip numbers never
      // render for them.
      { key: "payroll", label: "Payroll", icon: Landmark, shortcut: "G Y", shortcutKey: "y", permission: "payroll:manage" },
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
