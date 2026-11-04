// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// ---------------------------------------------------------------------------
// PR-59 — Project detail modal.
//
// Pins the user-approved contract: clicking a project opens a READ-oriented
// detail view (info + members + audit trail) for every role.
//   1. Info renders for everyone; "Edit details" (project:edit) layers the
//      existing ProjectModal on top — the detail modal stays open underneath.
//   2. Members: owner (ownership implies access) + explicit assignments.
//      role:manage gets an add-picker + per-row remove; MEMBER sees neither.
//   3. History: the EntityHistorySection timeline, expanded by default.
//   4. A stale id (project deleted elsewhere) renders a not-found note.
// ---------------------------------------------------------------------------

const { useSession } = vi.hoisted(() => ({ useSession: vi.fn() }));
const {
  getProjectAssignments,
  assignUserToProject,
  unassignUserFromProject,
  getAuditLogsForEntity,
  mockRouterRefresh,
} = vi.hoisted(() => ({
  getProjectAssignments: vi.fn(),
  assignUserToProject: vi.fn(),
  unassignUserFromProject: vi.fn(),
  getAuditLogsForEntity: vi.fn(),
  mockRouterRefresh: vi.fn(),
}));

vi.mock("@/lib/auth-client-better", () => ({
  authClient: { useSession },
}));

vi.mock("@/server-actions/data", () => ({
  getProjectAssignments,
  assignUserToProject,
  unassignUserFromProject,
  getAuditLogsForEntity,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mockRouterRefresh }),
}));

// Stub the Modal (portal/focus-trap) but pass through title + children —
// same pattern as member-modal.test.tsx.
vi.mock("@/components/ui/modal", () => ({
  Modal: ({
    children,
    open,
    title,
  }: {
    children: React.ReactNode;
    open: boolean;
    title?: string;
  }) =>
    open ? (
      <div data-testid="modal">
        {title && <h2>{title}</h2>}
        {children}
      </div>
    ) : null,
}));

import { ProjectDetailModal } from "@/components/ui/project-detail-modal";
import { useApp } from "@/store/app-store";
import type { ProjectT, TeamMemberT } from "@/lib/types";

const PROJECT: ProjectT = {
  id: "p1",
  name: "Apollo Redesign",
  description: "Redesign the Apollo dashboard end to end.",
  status: "RUNNING",
  priority: "HIGH",
  dueDate: "2026-12-31T00:00:00.000Z",
  progress: 40,
  color: "ocean",
  ownerName: "Mira Hale",
  ownerUserId: "u1",
  createdAt: "2026-01-01T00:00:00.000Z",
};

const MEMBERS: TeamMemberT[] = [
  { id: "m1", name: "Mira Hale", role: "ADMIN", department: "DESIGN", email: "mira@fernly.app", avatarColor: "plum", online: true, openTasks: 2, completedTasks: 8, workload: 60, userId: "u1" },
  { id: "m2", name: "Theo Vance", role: "MEMBER", department: "ENGINEERING", email: "theo@fernly.app", avatarColor: "forest", online: false, openTasks: 3, completedTasks: 5, workload: 45, userId: "u2" },
  { id: "m3", name: "Rafael Costa", role: "MEMBER", department: "MARKETING", email: "rafael@fernly.app", avatarColor: "ember", online: false, openTasks: 1, completedTasks: 2, workload: 20, userId: "u3" },
];

const TASKS = [
  { projectId: "p1", status: "DONE" },
  { projectId: "p1", status: "TODO" },
  { projectId: "other", status: "DONE" },
];

const ASSIGNMENTS = [
  {
    id: "a1",
    projectId: "p1",
    userId: "u2",
    role: "MEMBER",
    user: { id: "u2", name: "Theo Vance", email: "theo@fernly.app", role: "MEMBER", avatarColor: "forest" },
  },
];

const AUDIT_ENTRY = {
  id: "log1",
  actorId: "u1",
  actorName: "Mira Hale",
  actorRole: "ADMIN",
  action: "project.updated",
  entityType: "PROJECT",
  entityId: "p1",
  entityLabel: "Apollo Redesign",
  detail: "Updated status on project “Apollo Redesign”",
  createdAt: "2026-11-01T00:00:00.000Z",
};

function openFor(projectId: string | null) {
  useApp.setState({ projectDetailId: projectId, projectModalOpen: false, projectModalEditId: null });
}

function renderModal() {
  return render(
    <ProjectDetailModal projects={projectId === "missing" ? [] : [PROJECT]} members={MEMBERS} tasks={TASKS} />
  );
}

let projectId: string;

beforeEach(() => {
  projectId = "p1";
  useSession.mockReturnValue({
    data: { user: { id: "u-admin", role: "ADMIN" } },
    isPending: false,
    error: null,
  });
  getProjectAssignments.mockReset().mockResolvedValue({ ok: true, data: ASSIGNMENTS });
  getAuditLogsForEntity.mockReset().mockResolvedValue({ ok: true, data: [AUDIT_ENTRY] });
  assignUserToProject.mockReset().mockResolvedValue({ ok: true, data: undefined });
  unassignUserFromProject.mockReset().mockResolvedValue({ ok: true, data: undefined });
  mockRouterRefresh.mockClear();
  openFor("p1");
});

describe("ProjectDetailModal: info section (every role)", () => {
  it("renders the project's fields read-only, including task progress", async () => {
    renderModal();
    expect(screen.getByText("Apollo Redesign")).toBeTruthy(); // modal title
    expect(screen.getByText("Redesign the Apollo dashboard end to end.")).toBeTruthy();
    expect(screen.getByText("Running")).toBeTruthy(); // status badge label
    expect(screen.getByText("HIGH")).toBeTruthy(); // priority tag
    expect(screen.getByText("40% complete")).toBeTruthy();
    expect(screen.getByText("1/2 tasks done")).toBeTruthy();
    expect(screen.getByText(/Due 31 Dec 2026/)).toBeTruthy();
  });

  it("MEMBER sees no edit button, no member picker and no remove buttons", async () => {
    useSession.mockReturnValue({
      data: { user: { id: "u-member", role: "MEMBER" } },
      isPending: false,
      error: null,
    });
    renderModal();
    await waitFor(() => {
      expect(screen.getByText("Theo Vance")).toBeTruthy(); // members loaded
    });
    expect(screen.queryByRole("button", { name: /edit details/i })).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryAllByTitle(/Remove .* from this project/)).toHaveLength(0);
    // …but the member roster itself is visible (read-only). The owner name may
    // also show up as an audit actor once history loads — hence getAllByText.
    expect(screen.getAllByText("Mira Hale").length).toBeGreaterThan(0);
  });

  it("edit button (project:edit) layers the ProjectModal on top without closing the detail", () => {
    renderModal();
    fireEvent.click(screen.getByRole("button", { name: /edit details/i }));
    const s = useApp.getState();
    expect(s.projectModalOpen).toBe(true);
    expect(s.projectModalEditId).toBe("p1");
    // The detail modal stays open underneath (stacked modals).
    expect(s.projectDetailId).toBe("p1");
  });
});

describe("ProjectDetailModal: members section", () => {
  it("lists the owner (badged) plus assigned members — owner merged even without an assignment row", async () => {
    renderModal();
    await waitFor(() => {
      expect(screen.getByText("Theo Vance")).toBeTruthy();
    });
    // Owner row synthesized from the roster (u1 has no assignment row).
    // (Name may also appear as an audit actor — getAllByText.)
    expect(screen.getAllByText("Mira Hale").length).toBeGreaterThan(0);
    expect(screen.getByText("Owner")).toBeTruthy();
    // Assignment emails are visible for context.
    expect(screen.getByText(/theo@fernly\.app/)).toBeTruthy();
    expect(screen.getByText("2 people")).toBeTruthy();
  });

  it("ADMIN add-picker only offers unassigned, non-owner members; Add calls assignUserToProject", async () => {
    renderModal();
    await waitFor(() => {
      expect(screen.getByText("Theo Vance")).toBeTruthy();
    });
    const select = screen.getByRole("combobox", { name: /choose a team member/i });
    // Mira (owner) and Theo (assigned) must NOT be candidates; Rafael is.
    const options = Array.from(select.querySelectorAll("option")).map((o) => o.textContent);
    expect(options).toEqual(["Choose member…", "Rafael Costa"]);
    fireEvent.change(select, { target: { value: "m3" } });
    fireEvent.click(screen.getByRole("button", { name: /^add$/i }));
    await waitFor(() => {
      expect(assignUserToProject).toHaveBeenCalledWith("u3", "p1", "MEMBER");
    });
    // Optimistic row appears without waiting for a refetch — his email is
    // unique to the member row (the picker option only ever shows the name).
    await waitFor(() => {
      expect(screen.getByText(/rafael@fernly\.app/)).toBeTruthy();
    });
    // With every roster member now assigned, the picker collapses away.
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(mockRouterRefresh).toHaveBeenCalled();
  });

  it("remove button calls unassignUserFromProject for that member", async () => {
    renderModal();
    await waitFor(() => {
      expect(screen.getByText("Theo Vance")).toBeTruthy();
    });
    fireEvent.click(screen.getByTitle("Remove Theo Vance from this project"));
    await waitFor(() => {
      expect(unassignUserFromProject).toHaveBeenCalledWith("u2", "p1");
    });
    expect(mockRouterRefresh).toHaveBeenCalled();
  });

  it("the owner row has no remove button (access comes from ownership, not an assignment)", async () => {
    renderModal();
    await waitFor(() => {
      expect(screen.getAllByText("Mira Hale").length).toBeGreaterThan(0);
    });
    expect(screen.queryByTitle("Remove Mira Hale from this project")).toBeNull();
  });
});

describe("ProjectDetailModal: history + stale ids", () => {
  it("shows the audit trail expanded by default (no click needed)", async () => {
    renderModal();
    await waitFor(() => {
      expect(screen.getByText("History & Audit")).toBeTruthy();
    });
    await waitFor(() => {
      // The mocked entry's detail line renders without expanding the section.
      expect(screen.getByText(/Updated status on project/)).toBeTruthy();
      expect(screen.getByText("project.updated")).toBeTruthy();
    });
  });

  it("a stale id (project deleted elsewhere) renders a not-found note", () => {
    projectId = "missing";
    openFor("missing");
    renderModal();
    expect(screen.getByText(/Project not found/)).toBeTruthy();
  });
});
