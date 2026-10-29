// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import type { DragEndEvent } from "@dnd-kit/core";

// Capture whether router.refresh() is called by the onDragEnd handler.
// This is the L-P0-1 regression: the audit found zero router.refresh() calls
// anywhere in the codebase, so a Kanban drag would leave the board with stale
// props and snap back. After the fix the handler must call router.refresh().

const { mockRouterRefresh, mockMoveTask, capturedOnDragEnd } = vi.hoisted(() => ({
  mockRouterRefresh: vi.fn(),
  mockMoveTask: vi.fn(),
  capturedOnDragEnd: { current: null as ((e: DragEndEvent) => void) | null },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mockRouterRefresh }),
}));

vi.mock("@/server-actions/data", () => ({
  moveTask: mockMoveTask,
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// Wrap DndContext to capture the onDragEnd prop so we can invoke it directly
// (a full pointer-drag simulation needs Playwright — tracked as L-P1-23).
vi.mock("@dnd-kit/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dnd-kit/core")>();
  return {
    ...actual,
    DndContext: (props: React.ComponentProps<typeof actual.DndContext>) => {
      capturedOnDragEnd.current = props.onDragEnd as (e: DragEndEvent) => void;
      return <actual.DndContext {...props} />;
    },
  };
});

import { TasksView } from "@/components/views/tasks-view";
import type { TaskT, ProjectT, TeamMemberT } from "@/lib/types";

const baseTask: TaskT = {
  id: "t-1",
  title: "Test task",
  description: "",
  status: "TODO",
  priority: "MEDIUM",
  tag: "FRONTEND",
  dueDate: null,
  order: 0,
  projectId: "p-1",
  assigneeId: null,
  assignee: null,
  project: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

const baseProject: ProjectT = {
  id: "p-1",
  name: "Project 1",
  description: "",
  status: "RUNNING",
  priority: "MEDIUM",
  dueDate: null,
  progress: 0,
  color: "forest",
  ownerName: "",
  ownerUserId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

const baseMembers: TeamMemberT[] = [];

describe("TasksView — L-P0-1 mutation refresh wiring", () => {
  beforeEach(() => {
    mockRouterRefresh.mockClear();
    mockMoveTask.mockClear();
    capturedOnDragEnd.current = null;
  });

  afterEach(async () => {
    await waitFor(() => true);
  });

  it("renders without crashing when useRefresh (useRouter) is wired in", () => {
    render(
      <TasksView
        tasks={[baseTask]}
        projects={[baseProject]}
        members={baseMembers}
        currentUser={{ name: "tester", role: "ADMIN" }}
      />,
    );
    expect(screen.getByText("Test task")).toBeTruthy();
  });

  it("calls router.refresh() after a successful moveTask (P0-1 regression)", async () => {
    // The full @dnd-kit pointer drag simulation requires a real browser
    // (Playwright — tracked as L-P1-23). But we CAN assert the contract
    // directly: extract the TasksView's onDragEnd handler by spying on
    // DndContext, then invoke it with a synthetic DragEndEvent. This
    // verifies the L-P0-1 wiring (moveTask -> router.refresh) end-to-end
    // without depending on dnd-kit's pointer sensor.
    mockMoveTask.mockResolvedValue({ ok: true });

    render(
      <TasksView
        tasks={[baseTask]}
        projects={[baseProject]}
        members={baseMembers}
        currentUser={{ name: "tester", role: "ADMIN" }}
      />,
    );

    expect(capturedOnDragEnd.current).not.toBeNull();

    // Simulate a drag: active=t-1, over=DONE (a column key).
    const fakeEvent = {
      active: { id: "t-1" },
      over: { id: "DONE" },
    } as unknown as DragEndEvent;

    await capturedOnDragEnd.current!(fakeEvent);

    // moveTask must have been called with the task id, target status, and an order.
    expect(mockMoveTask).toHaveBeenCalledWith("t-1", "DONE", expect.any(Number));

    // The fix: router.refresh() must be called after the successful move.
    expect(mockRouterRefresh).toHaveBeenCalledTimes(1);
  });

  it("does NOT call router.refresh() on moveTask failure (rollback path)", async () => {
    mockMoveTask.mockResolvedValue({ ok: false, error: "Forbidden" });

    render(
      <TasksView
        tasks={[baseTask]}
        projects={[baseProject]}
        members={baseMembers}
        currentUser={{ name: "tester", role: "ADMIN" }}
      />,
    );

    const fakeEvent = {
      active: { id: "t-1" },
      over: { id: "DONE" },
    } as unknown as DragEndEvent;

    await capturedOnDragEnd.current!(fakeEvent);

    expect(mockMoveTask).toHaveBeenCalled();
    // On failure, the handler should NOT call router.refresh().
    expect(mockRouterRefresh).not.toHaveBeenCalled();
  });
});
