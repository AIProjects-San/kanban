import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";

// ---------------------------------------------------------------------------
// PR-58 — Grouped, collapsible sidebar (revised: no inline project list).
//
// Pins the contract agreed in the PR-58 plan:
//   1. Six groups for ADMIN; HR + Administration fully hidden for MEMBER
//      (a group with zero permitted children renders nothing — e2e
//      hr-leave.feature asserts MEMBER never sees the "HR" label).
//   2. Smart-minimal boot: only the current view's group is expanded.
//   3. Group headers are disclosure buttons (aria-expanded/aria-controls);
//      collapsed children stay MOUNTED but data-collapsed (hidden via CSS
//      only — e2e XPath locators still find them).
//   4. Navigating into a group auto-expands it (store setView behaviour).
//   4b. PR-62 accordion: only ONE group is ever expanded — opening a group
//      (or navigating into another group's view) collapses the previously
//      open one (user request).
//   5. Projects is a PLAIN leaf: no inline project list or chevron in the
//      sidebar; clicking it opens the Projects view, which lists every
//      project the server scoped to the signed-in user (getScopedProjectIds).
//   6. Rail mode (⌘B / toggle): icons-only with aria-labels, persisted to
//      localStorage.
// ---------------------------------------------------------------------------

// Stub the Better Auth client's useSession — the sidebar resolves the role
// through it (same pattern as command-palette.test.tsx).
const { useSession } = vi.hoisted(() => ({ useSession: vi.fn() }));
vi.mock("@/lib/auth/auth-client-better", () => ({
  authClient: { useSession },
}));

// appSignOut must never reach the network in tests.
vi.mock("@/hooks/use-app-session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/use-app-session")>()),
  appSignOut: vi.fn(),
}));

import { Sidebar } from "@/components/ui/sidebar";
import { useApp } from "@/store/app-store";
import { NAV_GROUPS, groupIdOfView } from "@/config/navigation";
import { STORAGE_KEYS } from "@/config/app";

// PR-65 — the rail toggle persists via updateUserSettings; never hit the
// network (or pull the real Prisma module graph) in tests.
vi.mock("@/server-actions/data", () => ({
  updateUserSettings: vi.fn().mockResolvedValue({ ok: true, data: undefined }),
}));

/** Smart-minimal boot state for the given active view. */
function bootCollapsedFor(view: string): string[] {
  return NAV_GROUPS.map((g) => g.id).filter((id) => id !== groupIdOfView(view as never));
}

function resetStore(view = "dashboard") {
  useApp.setState({
    view: view as never,
    sidebarOpen: false,
    sidebarRail: false,
    collapsedGroups: bootCollapsedFor(view),
    cmdkOpen: false,
    // PR-64 — fresh permission state per test (null = static fallback).
    effectivePermissions: null,
  });
  localStorage.clear();
}

function headerOf(label: string): HTMLElement {
  // Group headers are the only buttons whose visible text is exactly the
  // group label (leaf buttons carry icons/labels too, so scope by class).
  const el = screen
    .getAllByRole("button")
    .find((b) => b.textContent === label && b.className.includes("f-nav-group-header"));
  if (!el) throw new Error(`group header "${label}" not rendered`);
  return el;
}

beforeEach(() => {
  useSession.mockReturnValue({
    data: { user: { id: "u-admin", role: "ADMIN" } },
    isPending: false,
    error: null,
  });
  resetStore();
});

describe("Sidebar: grouping + RBAC", () => {
  it("renders the six groups for ADMIN", () => {
    render(<Sidebar />);
    for (const label of ["Overview", "Work", "People", "HR", "Administration", "General"]) {
      expect(headerOf(label)).toBeTruthy();
    }
  });

  it("renders every leaf somewhere for ADMIN", () => {
    render(<Sidebar />);
    for (const leaf of ["Dashboard", "Analytics", "Projects", "Tasks", "Bugs", "Team", "Calendar", "Leave", "My Interviews", "My Payslips", "My Attendance", "HR Console", "Users", "Workspace Config", "Audit Log", "Settings", "Help"]) {
      expect(screen.getAllByText(leaf).length).toBeGreaterThan(0);
    }
  });

  it("hides the HR and Administration groups entirely for MEMBER", () => {
    useSession.mockReturnValue({
      data: { user: { id: "u-member", role: "MEMBER" } },
      isPending: false,
      error: null,
    });
    render(<Sidebar />);
    // The critical e2e contract: the literal string "HR" never appears for
    // MEMBER (hr-leave.feature: "the sidebar should not contain HR").
    expect(screen.queryByText("HR")).toBeNull();
    expect(screen.queryByText("HR Console")).toBeNull();
    expect(screen.queryByText("Administration")).toBeNull();
    expect(screen.queryByText("Users")).toBeNull();
    expect(screen.queryByText("Workspace Config")).toBeNull();
    expect(screen.queryByText("Audit Log")).toBeNull();
    // …but self-service Leave stays visible (docs/HR_MODULE_PLAN.md).
    expect(screen.getAllByText("Leave").length).toBeGreaterThan(0);
    // …and so does payslip self-service (persona-audit P0-1 / D-02): every
    // role sees their OWN payslips. The full Payroll leaf must stay hidden.
    expect(screen.getAllByText("My Payslips").length).toBeGreaterThan(0);
    expect(screen.queryByText("Payroll")).toBeNull();
    // …and interviewer self-service (persona-audit P0-5 / D-04): a MEMBER
    // assigned as an interviewer reaches their own stages + scorecard from
    // the People group — while the Hiring board leaf itself stays hidden
    // (no hiring:view; candidate PII must not reach every member).
    expect(screen.getAllByText("My Interviews").length).toBeGreaterThan(0);
    expect(screen.queryByText("Hiring")).toBeNull();
  });

  it("shows Administration with only Audit Log for MANAGER", () => {
    useSession.mockReturnValue({
      data: { user: { id: "u-mgr", role: "MANAGER" } },
      isPending: false,
      error: null,
    });
    render(<Sidebar />);
    expect(screen.getAllByText("Audit Log").length).toBeGreaterThan(0);
    expect(screen.queryByText("Users")).toBeNull();
    expect(screen.queryByText("Workspace Config")).toBeNull();
  });
});

describe("Sidebar: collapsible groups (smart minimal)", () => {
  it("boot: only the current view's group is expanded", () => {
    render(<Sidebar />);
    expect(headerOf("Overview").getAttribute("aria-expanded")).toBe("true");
    for (const label of ["Work", "People", "Administration", "General"]) {
      expect(headerOf(label).getAttribute("aria-expanded")).toBe("false");
    }
  });

  it("clicking a header toggles aria-expanded and its container's data-collapsed", () => {
    render(<Sidebar />);
    const work = headerOf("Work");
    expect(work.getAttribute("aria-controls")).toBe("nav-group-work");
    const container = document.getElementById("nav-group-work");
    expect(container?.getAttribute("data-collapsed")).toBe("true");
    fireEvent.click(work);
    expect(work.getAttribute("aria-expanded")).toBe("true");
    expect(document.getElementById("nav-group-work")?.getAttribute("data-collapsed")).toBeNull();
    fireEvent.click(work);
    expect(work.getAttribute("aria-expanded")).toBe("false");
  });

  it("collapsed children stay mounted (e2e XPath contract) but marked hidden", () => {
    render(<Sidebar />);
    // Work is collapsed at boot, yet its leaves exist in the DOM.
    const tasks = screen.getAllByText("Tasks");
    expect(tasks.length).toBeGreaterThan(0);
    expect(document.getElementById("nav-group-work")?.getAttribute("data-collapsed")).toBe("true");
  });

  it("navigating via the store auto-expands the target's group (G-shortcut / ⌘K path)", () => {
    render(<Sidebar />);
    // Direct store mutation mirrors the G-shortcut / ⌘K entry points — wrap
    // in act so React flushes the re-render before assertions.
    act(() => {
      useApp.getState().setView("bugs");
    });
    expect(headerOf("Work").getAttribute("aria-expanded")).toBe("true");
    expect(useApp.getState().view).toBe("bugs");
  });

  it("PR-62 accordion: opening a second group collapses the first", () => {
    render(<Sidebar />);
    // Boot: Overview open. Open Work — Overview must close.
    fireEvent.click(headerOf("Work"));
    expect(headerOf("Work").getAttribute("aria-expanded")).toBe("true");
    expect(headerOf("Overview").getAttribute("aria-expanded")).toBe("false");
    // Open People — Work must close in turn.
    fireEvent.click(headerOf("People"));
    expect(headerOf("People").getAttribute("aria-expanded")).toBe("true");
    expect(headerOf("Work").getAttribute("aria-expanded")).toBe("false");
    expect(headerOf("Overview").getAttribute("aria-expanded")).toBe("false");
  });

  it("PR-62 accordion: navigating into another group's view collapses the previous one", () => {
    render(<Sidebar />);
    // Overview is open (dashboard). Navigate to the Team view (People
    // group) via the store — the G-shortcut / ⌘K path.
    act(() => {
      useApp.getState().setView("team");
    });
    expect(headerOf("People").getAttribute("aria-expanded")).toBe("true");
    expect(headerOf("Overview").getAttribute("aria-expanded")).toBe("false");
    expect(headerOf("Work").getAttribute("aria-expanded")).toBe("false");
  });

  it("PR-62 accordion: collapsing the open group leaves zero groups open", () => {
    render(<Sidebar />);
    fireEvent.click(headerOf("Overview"));
    // Every group collapsed — a valid accordion state (nothing forces one
    // group to stay open).
    for (const label of ["Overview", "Work", "People", "Administration", "General"]) {
      expect(headerOf(label).getAttribute("aria-expanded")).toBe("false");
    }
  });
});

describe("Sidebar: PR-64 live RBAC (effective permissions)", () => {
  it("a DB-granted permission reveals the gated group for a logged-in MEMBER", () => {
    useSession.mockReturnValue({
      data: { user: { id: "u-member", role: "MEMBER" } },
      isPending: false,
      error: null,
    });
    resetStore();
    // The admin granted MEMBER hr:view in the role editor; the
    // getMyPermissions poll delivered the effective set to the store.
    act(() => {
      useApp.getState().setEffectivePermissions([
        "task:edit:own", "hr:view", "leave:request",
      ]);
    });
    render(<Sidebar />);
    // HR Console (hr:view) is now reachable…
    expect(screen.getAllByText("HR").length).toBeGreaterThan(0);
    expect(screen.getAllByText("HR Console").length).toBeGreaterThan(0);
    // …while a permission still missing keeps its gate (audit:view).
    expect(screen.queryByText("Audit Log")).toBeNull();
  });

  it("removing a DB grant hides the gated item again (no re-login)", () => {
    useSession.mockReturnValue({
      data: { user: { id: "u-member", role: "MEMBER" } },
      isPending: false,
      error: null,
    });
    resetStore();
    act(() => {
      useApp.getState().setEffectivePermissions([
        "task:edit:own", "hr:view", "audit:view",
      ]);
    });
    const { unmount } = render(<Sidebar />);
    expect(screen.getAllByText("Audit Log").length).toBeGreaterThan(0);
    unmount();

    // The admin revokes audit:view; the next poll shrinks the set.
    resetStore();
    act(() => {
      useApp.getState().setEffectivePermissions(["task:edit:own", "hr:view"]);
    });
    render(<Sidebar />);
    expect(screen.queryByText("Audit Log")).toBeNull();
  });
});

describe("Sidebar: Projects leaf (no inline project list)", () => {
  it("renders no project submenu — the leaf navigates to the Projects view", () => {
    render(<Sidebar />);
    // Expand the Work group first (boot state collapses it).
    fireEvent.click(headerOf("Work"));
    // No disclosure chevron and no sub-list container in the sidebar —
    // project names only ever appear inside the Projects view itself.
    expect(screen.queryByRole("button", { name: "Show project list" })).toBeNull();
    expect(document.getElementById("nav-projects-list")).toBeNull();
    // The leaf itself navigates; the view then lists every project the
    // server scoped to the signed-in user (getScopedProjectIds).
    const leaf = screen.getAllByText("Projects").find(
      (el) => el.closest("button")?.className.includes("f-nav-item")
    );
    expect(leaf).toBeTruthy();
    fireEvent.click(leaf!.closest("button")!);
    expect(useApp.getState().view).toBe("projects");
    // …and the Work group auto-expanded for the journey.
    expect(headerOf("Work").getAttribute("aria-expanded")).toBe("true");
  });
});

describe("Sidebar: icon rail (⌘B)", () => {
  it("toggle button flips rail mode, narrows the aside, and persists to localStorage", () => {
    render(<Sidebar />);
    const toggle = screen.getByRole("button", { name: "Collapse sidebar to icon rail" });
    fireEvent.click(toggle);
    const s = useApp.getState();
    expect(s.sidebarRail).toBe(true);
    // PR-65 — the rail now lives in the per-user theme blob (tagged with the
    // owning user), not a shared flat key.
    const blob = JSON.parse(localStorage.getItem(STORAGE_KEYS.theme) ?? "{}");
    expect(blob.rail).toBe(true);
    const aside = document.querySelector("aside");
    expect(aside?.className).toContain("lg:w-16");
    // Toggle back — label flips with the state.
    fireEvent.click(screen.getByRole("button", { name: "Expand sidebar" }));
    expect(useApp.getState().sidebarRail).toBe(false);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.theme) ?? "{}").rail).toBe(false);
  });

  it("rail leaves expose accessible names (icons-only never loses labels)", () => {
    render(<Sidebar />);
    act(() => {
      useApp.getState().toggleSidebarRail();
    });
    // Re-render is reactive (zustand) — the same mounted tree updates.
    const tasks = screen.getAllByRole("button").find(
      (b) => b.getAttribute("aria-label") === "Tasks"
    );
    expect(tasks).toBeTruthy();
    expect(tasks?.getAttribute("title")).toContain("G T");
  });
});
