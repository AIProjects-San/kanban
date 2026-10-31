// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// ---------------------------------------------------------------------------
// TeamView — duplicate-React-key regression test
//
// Reproduces the console error:
//   "Encountered two children with the same key, `Unknown`. Keys should be
//    unique so that components maintain their identity across updates."
//
// Root cause: the ProfileDrawer's "Recent activity" project-breakdown list
// used `key={p.name}`. When a team member had time entries against two
// different projects that were missing from the `projects` prop (deleted
// project, stale projectId, etc.), both entries collapsed to
// `name: "Unknown"` and produced a duplicate React key.
//
// Fix: surface the unique `projectId` on each breakdown entry and use it as
// the React key. The map is built from `Map<projectId, hours>` so the
// projectId is always unique per row, regardless of whether the project
// name resolves.
// ---------------------------------------------------------------------------

// Stub the EntityHistorySection so we don't drag in server-action calls.
vi.mock("@/components/ui/entity-history-section", () => ({
  EntityHistorySection: () => <div data-testid="history" />,
}));

// Stub the server-action imports the message path uses (we don't exercise
// it here, but the import graph requires them to resolve).
vi.mock("@/server-actions/data", () => ({
  sendMessage: vi.fn(),
  getUserByEmail: vi.fn(),
}));

import { TeamView } from "@/components/views/team-view";
import type { TeamMemberT, TaskT, ProjectT, TimeEntryT } from "@/lib/types";

const baseMember: TeamMemberT = {
  id: "m-1",
  name: "Test Member",
  role: "Engineer",
  department: "ENGINEERING",
  email: "test@fernly.app",
  avatarColor: "forest",
  online: true,
  openTasks: 0,
  completedTasks: 0,
  workload: 0,
  userId: "u-1",
};

const baseTask: TaskT = {
  id: "t-0",
  title: "stub",
  description: "",
  status: "DONE",
  priority: "MEDIUM",
  tag: "FRONTEND",
  dueDate: null,
  order: 0,
  projectId: "p-0",
  assigneeId: "m-1",
  createdAt: new Date().toISOString(),
};

function makeEntries(): TimeEntryT[] {
  // Two time entries against two DIFFERENT projectIds that are NOT in the
  // projects prop — both will render as "Unknown" in the breakdown.
  const today = new Date().toISOString();
  return [
    { id: "te-1", projectId: "ghost-1", memberId: "m-1", date: today, hours: 2, description: "" },
    { id: "te-2", projectId: "ghost-2", memberId: "m-1", date: today, hours: 3, description: "" },
  ];
}

describe("TeamView / ProfileDrawer: project breakdown keys", () => {
  it("renders two 'Unknown' project rows without a duplicate-key warning", async () => {
    // Capture console.error so the test fails if React emits the
    // "two children with the same key" warning.
    const errors: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => {
      const msg = args.map(String).join(" ");
      if (/same key|Encountered two children/i.test(msg)) {
        errors.push(msg);
      }
      // Don't call origError to keep the test output clean.
    };

    const projects: ProjectT[] = []; // empty → both entries render as "Unknown"
    const members: TeamMemberT[] = [baseMember];
    const tasks: TaskT[] = [baseTask];
    const timeEntries = makeEntries();

    try {
      const { container } = render(
        <TeamView
          members={members}
          tasks={tasks}
          projects={projects}
          timeEntries={timeEntries}
          currentUser={{ name: "Admin", role: "ADMIN", avatarColor: "forest" }}
        />,
      );
      // Open the profile drawer by clicking the "Profile" button on the
      // first member card.
      const profileBtn = screen.getAllByRole("button", { name: /profile/i })[0];
      fireEvent.click(profileBtn);

      // The drawer renders asynchronously; wait for the "Recent activity"
      // header to appear so we know the breakdown list is mounted.
      await waitFor(() => {
        expect(screen.getByText("Recent activity")).toBeInTheDocument();
      });

      // The two "Unknown" rows should both render (no deduplication).
      const unknownRows = screen.getAllByText("Unknown");
      expect(unknownRows.length).toBeGreaterThanOrEqual(2);

      // And no duplicate-key warning should have fired.
      expect(errors).toHaveLength(0);

      // Sanity: the drawer actually rendered (so we know the assertion ran
      // against the right DOM).
      expect(container.textContent).toContain("Recent activity");
    } finally {
      console.error = origError;
    }
  });
});
