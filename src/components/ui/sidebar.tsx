"use client";

import { useState } from "react";
import {
  ChevronRight,
  LogOut,
  X,
  Leaf,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";
import { useApp } from "@/store/app-store";
import { hasPermission, type Role } from "@/lib/rbac";
import { cn } from "@/lib/utils";
import { appSignOut } from "@/hooks/use-app-session"; // PR-48 — flag-aware (v4 wrapper or Better Auth)
import { APP } from "@/config/app";
import { useAppSession } from "@/hooks/use-app-session";
import {
  NAV_GROUPS,
  SIDEBAR_PROJECT_CAP,
  type NavGroup,
  type NavLeaf,
} from "@/config/navigation";
import type { ProjectT } from "@/lib/types";

// ---------------------------------------------------------------------------
// PR-58 — Grouped, collapsible sidebar.
//
// Structure and RBAC gates come from src/config/navigation.ts (single source
// of truth shared with the ⌘K palette and the G-shortcuts). Behaviours:
//   • Smart minimal: on boot only the current view's group is expanded.
//   • Navigating into a group (click / G-shortcut / ⌘K) auto-expands it —
//     done in the store's setView so every entry point gets it.
//   • Collapsed groups stay MOUNTED but visibility:hidden (zero height via
//     the grid-rows trick): hidden from the a11y tree and unfocusable, yet
//     still present in the DOM for text-based assertions (e2e locators).
//   • Work → Projects lists live project names (capped; "+N more" links to
//     the Projects view). Clicking a name deep-links via openProject().
//   • Desktop rail mode (⌘B / panel toggle): icons-only w-16 with tooltips;
//     group headers and labels collapse away. Mobile keeps the full drawer.
// ---------------------------------------------------------------------------

export function Sidebar({ projects }: { projects: ProjectT[] }) {
  const {
    view,
    setView,
    sidebarOpen,
    setSidebarOpen,
    sidebarRail,
    toggleSidebarRail,
    collapsedGroups,
    toggleGroup,
    selectedProjectId,
    openProject,
  } = useApp();
  const { data: session } = useAppSession();
  const role = (session?.user as { role?: string } | undefined)?.role as Role | undefined;

  // RBAC — same gates as before (navigation.ts carries them now):
  // hr:view (HR Console), audit:view (Audit Log), role:manage (Users,
  // Workspace Config). A group whose children are ALL gated away for this
  // role is hidden entirely (MEMBER sees no Administration/HR sections).
  const visibleGroups = NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter(
      (item) => !item.permission || hasPermission(role, item.permission)
    ),
  })).filter((group) => group.items.length > 0);

  const rail = sidebarRail;

  return (
    <>
      {/* Mobile backdrop */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/40 lg:hidden"
          onClick={() => setSidebarOpen(false)}
          aria-hidden
        />
      )}

      <aside
        className={cn(
          "fixed lg:sticky top-0 left-0 z-40 h-screen w-64 shrink-0 bg-sidebar border-r border-sidebar-border flex flex-col transition-[transform,width] duration-200",
          rail && "lg:w-16",
          sidebarOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0"
        )}
        data-rail={rail || undefined}
      >
        {/* Brand */}
        <div className={cn("h-16 flex items-center border-b border-sidebar-border", rail ? "px-3 lg:px-2 lg:justify-center" : "px-5 justify-between")}>
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center text-primary-foreground shrink-0">
              <Leaf size={18} />
            </div>
            <span className={cn(
              "text-base font-semibold text-sidebar-foreground tracking-tight",
              rail && "lg:hidden"
            )}>
              {APP.name}
            </span>
          </div>
          <div className="flex items-center gap-0.5">
            {/* Rail toggle — desktop only (mobile keeps the full drawer) */}
            <button
              className="f-btn f-btn-ghost f-btn-icon hidden lg:flex"
              onClick={toggleSidebarRail}
              aria-label={rail ? "Expand sidebar" : "Collapse sidebar to icon rail"}
              aria-pressed={rail}
              title={rail ? "Expand sidebar (⌘B)" : "Collapse to icon rail (⌘B)"}
            >
              {rail ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
            </button>
            <button
              className="f-btn f-btn-ghost f-btn-icon lg:hidden"
              onClick={() => setSidebarOpen(false)}
              aria-label="Close sidebar"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Nav */}
        <nav className="flex-1 overflow-y-auto f-scroll px-3 py-4" aria-label="Main navigation">
          {visibleGroups.map((group, gi) => (
            <NavSection
              key={group.id}
              group={group}
              first={gi === 0}
              view={view}
              rail={rail}
              collapsed={rail ? false : collapsedGroups.includes(group.id)}
              onToggle={() => toggleGroup(group.id)}
              onNavigate={(key) => setView(key)}
              projects={projects}
              selectedProjectId={selectedProjectId}
              onOpenProject={openProject}
            />
          ))}
        </nav>

        {/* Sign out */}
        <div className={cn("p-3 border-t border-sidebar-border", rail && "lg:px-2")}>
          <button
            onClick={() => { void appSignOut(); }}
            className={cn("f-nav-item w-full", rail && "f-nav-item-rail")}
            aria-label="Sign out"
            title="Sign out"
          >
            <LogOut size={18} />
            <span className={cn("flex-1 text-left", rail && "lg:hidden")}>Sign out</span>
          </button>
        </div>
      </aside>
    </>
  );
}

/** One collapsible group: header button + animated children container. */
function NavSection({
  group,
  first,
  view,
  rail,
  collapsed,
  onToggle,
  onNavigate,
  projects,
  selectedProjectId,
  onOpenProject,
}: {
  group: NavGroup;
  first: boolean;
  view: string;
  rail: boolean;
  collapsed: boolean;
  onToggle: () => void;
  onNavigate: (key: NavLeaf["key"]) => void;
  projects: ProjectT[];
  selectedProjectId: string | null;
  onOpenProject: (id: string) => void;
}) {
  const hasActive = group.items.some((i) => i.key === view);
  const contentId = `nav-group-${group.id}`;

  return (
    <div className={cn(!first && "mt-4")}>
      {/* Group header — a disclosure button. Hidden in desktop rail mode. */}
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!collapsed}
        aria-controls={contentId}
        data-has-active={hasActive || undefined}
        className={cn("f-nav-group-header w-full", rail && "lg:hidden")}
      >
        <ChevronRight size={12} className="f-nav-group-chevron shrink-0" />
        <span className="flex-1 text-left">{group.label}</span>
      </button>

      {rail && <div className="hidden lg:block my-2 border-t border-sidebar-border" aria-hidden />}

      {/* Children stay mounted when collapsed (visibility:hidden removes
          them from the a11y tree + tab order while keeping DOM presence
          for e2e XPath locators — see the comment atop this file). */}
      <div
        id={contentId}
        role="group"
        aria-label={group.label}
        data-collapsed={collapsed || undefined}
        className="f-nav-collapse"
      >
        <div>
          {group.items.map((item) =>
            item.dynamicChildren === "projects" ? (
              <ProjectsNavItem
                key={item.key}
                item={item}
                active={view === item.key}
                rail={rail}
                onNavigate={() => onNavigate(item.key)}
                projects={projects}
                selectedProjectId={selectedProjectId}
                onOpenProject={onOpenProject}
              />
            ) : (
              <NavButton
                key={item.key}
                item={item}
                active={view === item.key}
                rail={rail}
                onClick={() => onNavigate(item.key)}
              />
            )
          )}
        </div>
      </div>
    </div>
  );
}

/** Projects leaf — navigates on click; the chevron reveals live project names. */
function ProjectsNavItem({
  item,
  active,
  rail,
  onNavigate,
  projects,
  selectedProjectId,
  onOpenProject,
}: {
  item: NavLeaf;
  active: boolean;
  rail: boolean;
  onNavigate: () => void;
  projects: ProjectT[];
  selectedProjectId: string | null;
  onOpenProject: (id: string) => void;
}) {
  const [listOpen, setListOpen] = useState(false);
  const Icon = item.icon;
  const shown = projects.slice(0, SIDEBAR_PROJECT_CAP);
  const more = projects.length - shown.length;

  return (
    <div>
      <div className="flex items-center">
        <button
          onClick={onNavigate}
          data-active={active}
          className="f-nav-item w-full flex-1 pr-1"
        >
          <Icon size={18} />
          <span className={cn("flex-1 text-left", rail && "lg:hidden")}>{item.label}</span>
          <kbd className={cn("text-[0.625rem] text-muted-foreground font-mono", rail ? "lg:hidden" : "hidden lg:inline")}>
            {item.shortcut}
          </kbd>
        </button>
        {/* Separate hit target so "navigate" and "expand list" stay distinct
            actions (same pattern as GitHub/Notion sidebars). */}
        <button
          type="button"
          onClick={() => setListOpen((o) => !o)}
          aria-expanded={listOpen}
          aria-controls="nav-projects-list"
          aria-label={listOpen ? "Hide project list" : "Show project list"}
          className={cn("f-nav-chevron-btn shrink-0", rail && "lg:hidden")}
        >
          <ChevronRight size={14} className={cn("f-nav-group-chevron", listOpen && "f-nav-group-chevron-open")} />
        </button>
      </div>

      {/* Live project names — deep-link into the Projects view. */}
      <div
        id="nav-projects-list"
        data-collapsed={!listOpen || undefined}
        className={cn("f-nav-collapse", rail && "lg:hidden")}
      >
        <div>
          {shown.map((p) => (
            <button
              key={p.id}
              onClick={() => onOpenProject(p.id)}
              data-active={active && selectedProjectId === p.id}
              className="f-nav-sub-item w-full"
              title={p.name}
            >
              <span className={cn("w-2.5 h-2.5 rounded-full shrink-0 f-avatar", `f-avatar-${p.color}`)} aria-hidden />
              <span className="flex-1 text-left truncate">{p.name}</span>
            </button>
          ))}
          {more > 0 && (
            <button
              onClick={onNavigate}
              className="f-nav-sub-item w-full"
              title="Open the Projects view"
            >
              <span className="flex-1 text-left truncate">+{more} more</span>
            </button>
          )}
          {projects.length === 0 && (
            <div className="f-nav-sub-item text-muted-foreground cursor-default">
              <span className="flex-1 text-left truncate">No projects yet</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function NavButton({
  item,
  active,
  rail,
  onClick,
}: {
  item: NavLeaf;
  active: boolean;
  rail: boolean;
  onClick: () => void;
}) {
  const Icon = item.icon;
  if (rail) {
    // Rail: icon-only with tooltip; full label still renders below lg (mobile
    // drawer keeps the expanded layout regardless of the rail preference).
    return (
      <button
        onClick={onClick}
        data-active={active}
        className="f-nav-item f-nav-item-rail w-full"
        aria-label={item.label}
        title={`${item.label} · ${item.shortcut}`}
      >
        <Icon size={18} />
        <span className="lg:hidden flex-1 text-left">{item.label}</span>
      </button>
    );
  }
  return (
    <button
      onClick={onClick}
      data-active={active}
      className="f-nav-item w-full"
    >
      <Icon size={18} />
      <span className="flex-1 text-left">{item.label}</span>
      <kbd className="hidden lg:inline text-[0.625rem] text-muted-foreground font-mono">
        {item.shortcut}
      </kbd>
    </button>
  );
}
