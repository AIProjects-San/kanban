import { describe, it, expect } from "vitest";

// PR-61 — the client-side mirror of the task-delete rule. Pure function:
// the matrix here mirrors server-actions/__tests__/task-delete.test.ts.

import { canDeleteTask, type TaskDeleteContext } from "@/lib/task-delete";
import type { ProjectT, TeamMemberT } from "@/lib/types";

const ADMIN = { id: "u-admin", role: "ADMIN" };
const MANAGER = { id: "u-max", role: "MANAGER" };
const MEMBER = { id: "u-mia", role: "MEMBER" };

const MEMBERS: TeamMemberT[] = [
  { id: "m-mia", name: "Mia", role: "MEMBER", department: "ENGINEERING", email: "mia@x.co", avatarColor: "forest", online: true, openTasks: 0, completedTasks: 0, workload: 0, userId: "u-mia" },
  { id: "m-assignee", name: "Rex", role: "MEMBER", department: "ENGINEERING", email: "rex@x.co", avatarColor: "ember", online: false, openTasks: 1, completedTasks: 2, workload: 20, userId: "u-report" },
];

const PROJECTS: ProjectT[] = [
  {
    id: "p-1", name: "P1", description: "", status: "RUNNING", priority: "HIGH",
    dueDate: null, progress: 0, color: "forest", ownerName: "Ada",
    ownerUserId: "u-admin", createdAt: "2026-01-01T00:00:00.000Z",
  },
];

const BASE_CTX: TaskDeleteContext = {
  members: MEMBERS,
  projects: PROJECTS,
  myTeamMemberId: "m-mia",
  managedUserIds: ["u-max", "u-report"],
};

const TASK = { assigneeId: "m-assignee", projectId: "p-1" };

describe("canDeleteTask (PR-61 client mirror)", () => {
  it("the effective task:delete permission shows Delete for any task (ADMIN role or DB grant)", () => {
    expect(canDeleteTask(ADMIN, TASK, BASE_CTX)).toBe(true);
    expect(canDeleteTask(ADMIN, { assigneeId: null, projectId: null }, BASE_CTX)).toBe(true);
    // A DB-granted MEMBER (the ceiling) must see it too — the static-role
    // check alone used to hide the button from them.
    expect(canDeleteTask({ id: "u-member", role: "MEMBER" }, TASK, { ...BASE_CTX, canTaskDelete: true })).toBe(true);
  });

  it("the assigned user sees Delete for their own task", () => {
    // u-mia's member row IS the assignee in this ctx variant.
    expect(
      canDeleteTask(MEMBER, TASK, { ...BASE_CTX, myTeamMemberId: "m-assignee" }),
    ).toBe(true);
  });

  it("a MEMBER who is neither assignee nor project owner does not see Delete", () => {
    expect(canDeleteTask(MEMBER, TASK, BASE_CTX)).toBe(false);
  });

  it("the project owner sees Delete for tasks in their project", () => {
    const ownProject: ProjectT[] = [{ ...PROJECTS[0], ownerUserId: "u-mia" }];
    expect(canDeleteTask(MEMBER, TASK, { ...BASE_CTX, projects: ownProject })).toBe(true);
  });

  it("a MANAGER sees Delete when the assignee is in their subtree", () => {
    // m-assignee → user u-report, which is in managedUserIds.
    expect(canDeleteTask(MANAGER, TASK, BASE_CTX)).toBe(true);
  });

  it("a MANAGER sees Delete when the project owner is in their subtree", () => {
    const reportsProject: ProjectT[] = [{ ...PROJECTS[0], ownerUserId: "u-report" }];
    // Assignee maps to a user OUTSIDE the subtree.
    const membersElsewhere: TeamMemberT[] = MEMBERS.map((m) =>
      m.id === "m-assignee" ? { ...m, userId: "u-elsewhere" } : m,
    );
    expect(
      canDeleteTask(MANAGER, TASK, { ...BASE_CTX, projects: reportsProject, members: membersElsewhere }),
    ).toBe(true);
  });

  it("a MANAGER outside the chain does not see Delete", () => {
    expect(canDeleteTask(MANAGER, TASK, { ...BASE_CTX, managedUserIds: ["u-max"] })).toBe(false);
  });

  it("no session / no subtree data → no Delete", () => {
    expect(canDeleteTask(null, TASK, BASE_CTX)).toBe(false);
    expect(canDeleteTask(undefined, TASK, BASE_CTX)).toBe(false);
    // MANAGER without managedUserIds shipped (defensive — shouldn't happen).
    expect(canDeleteTask(MANAGER, TASK, { ...BASE_CTX, managedUserIds: undefined })).toBe(false);
  });
});
