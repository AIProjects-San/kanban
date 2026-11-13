import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// PR-61 — row-level task-delete rights.
//
//   1. ADMIN                — any task (blanket task:delete permission).
//   2. the assigned user    — their own task, whatever their role.
//   3. the project owner    — any task in a project they own, any role.
//   4. a MANAGER of the team — the task's assignee OR the project owner
//                              reports to them (managerId subtree).
//
// Covers assertTaskDeletePermission (via deleteTask) and the dashboard
// payload's managedUserIds field that feeds the client-side mirror
// (lib/task-delete.ts — see lib/__tests__/task-delete.test.ts).
// ---------------------------------------------------------------------------

const { db, getBetterSession } = vi.hoisted(() => {
  const getBetterSession = vi.fn();
  const models = [
    "auditLog", "project", "task", "teamMember", "reminder", "notification",
    "timeEntry", "calendarEvent", "message", "user", "projectAssignment",
    "workspace", "bug", "leaveRequest",
  ];
  const methods = [
    "findMany", "findUnique", "findFirst", "create", "createMany", "update",
    "updateMany", "delete", "deleteMany", "upsert", "count", "aggregate",
  ];
  const db: Record<string, Record<string, ReturnType<typeof vi.fn>>> = {};
  for (const m of models) {
    db[m] = {};
    for (const meth of methods) db[m][meth] = vi.fn();
  }
  return { db, getBetterSession };
});

vi.mock("@/lib/auth/auth-better", () => ({ getBetterSession, revokeUserSessions: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/infra/db", () => ({ db }));

import { deleteTask, getDashboardData } from "@/server-actions/data";
import type { ActionResult } from "@/lib/action-result";

const ADMIN = { userId: "u-admin", name: "Ada", email: "ada@fernly.dev", role: "ADMIN" as string };
const MANAGER = { userId: "u-max", name: "Max", email: "max@fernly.dev", role: "MANAGER" as string };
const MEMBER = { userId: "u-mia", name: "Mia", email: "mia@fernly.dev", role: "MEMBER" as string };
const HR = { userId: "u-hana", name: "Hana", email: "hana@fernly.dev", role: "HR" as string };

function signIn(user: { userId: string; name: string; email: string; role: string } | null) {
  getBetterSession.mockResolvedValue(
    user ? { userId: user.userId, name: user.name, email: user.email, role: user.role } : null,
  );
}

function expectErr(r: ActionResult<unknown>, matcher?: RegExp) {
  expect(r.ok).toBe(false);
  if (!r.ok && matcher) expect(r.error).toMatch(matcher);
}

/** A task assigned to m-assignee in project p-1 (owned by u-admin by default). */
const TASK = {
  id: "t-1", title: "T", description: "", status: "TODO", priority: "HIGH",
  tag: "QA", dueDate: null, order: 0, assigneeId: "m-assignee", projectId: "p-1",
  createdAt: new Date(), updatedAt: new Date(),
};

beforeEach(() => {
  vi.clearAllMocks();
  signIn(ADMIN);
  db.auditLog.create.mockResolvedValue({});
  db.task.count.mockResolvedValue(0);
  db.teamMember.update.mockResolvedValue({});
  // Default project lookup: p-1 is owned by the admin.
  db.project.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
    where.id === "p-1" ? { id: "p-1", ownerUserId: "u-admin", name: "P1" } : null,
  );
  // getMyTeamMemberId — resolve by userId; the email fallback resolves by
  // email (same mock fn, dispatch on the where clause).
  db.teamMember.findUnique.mockImplementation(
    async ({ where }: { where: { userId?: string; email?: string; id?: string; deletedAt?: null } }) => {
      if (where.userId === "u-mia") return { id: "m-mia" };
      if (where.email === "mia@fernly.dev") return { id: "m-mia" };
      if (where.id === "m-assignee") return { id: "m-assignee", userId: "u-report", name: "Rex", email: "rex@x.co" };
      return null;
    },
  );
  // Hierarchy — u-max manages u-report (getSubtreeUserIds BFS).
  db.user.findMany.mockImplementation(
    async ({ where }: { where: { managerId?: string } }) =>
      where.managerId === "u-max" ? [{ id: "u-report" }] : [],
  );
});

describe("deleteTask (PR-61 row-level rights)", () => {
  it("ADMIN may delete any task", async () => {
    db.task.findUnique.mockResolvedValue(TASK);
    db.task.delete.mockResolvedValue(TASK);
    const r = await deleteTask("t-1");
    expect(r.ok).toBe(true);
    expect(db.task.delete).toHaveBeenCalledWith({ where: { id: "t-1" } });
  });

  it("the assigned user may delete their own task (MEMBER role)", async () => {
    signIn(MEMBER); // u-mia's member row is m-mia — NOT the assignee here
    db.teamMember.findUnique.mockImplementation(
      async ({ where }: { where: { userId?: string; email?: string; id?: string } }) => {
        if (where.userId === "u-mia" || where.email === "mia@fernly.dev") return { id: "m-assignee" };
        if (where.id === "m-assignee") return { id: "m-assignee", userId: "u-report" };
        return null;
      },
    );
    db.task.findUnique.mockResolvedValue(TASK);
    const r = await deleteTask("t-1");
    expect(r.ok).toBe(true);
    expect(db.task.delete).toHaveBeenCalled();
  });

  it("a MEMBER who is neither assignee nor project owner is rejected", async () => {
    signIn(MEMBER); // member row m-mia ≠ m-assignee; project owned by u-admin
    db.task.findUnique.mockResolvedValue(TASK);
    expectErr(await deleteTask("t-1"), /assigned user, the project owner/i);
    expect(db.task.delete).not.toHaveBeenCalled();
  });

  it("the project owner may delete tasks in their project (MEMBER role)", async () => {
    signIn(MEMBER);
    db.project.findUnique.mockResolvedValue({ id: "p-1", ownerUserId: "u-mia", name: "P1" });
    db.task.findUnique.mockResolvedValue(TASK);
    const r = await deleteTask("t-1");
    expect(r.ok).toBe(true);
    expect(db.task.delete).toHaveBeenCalled();
  });

  it("a MANAGER may delete a task whose assignee reports to them", async () => {
    signIn(MANAGER); // assignee's user u-report is in u-max's subtree
    db.task.findUnique.mockResolvedValue(TASK);
    const r = await deleteTask("t-1");
    expect(r.ok).toBe(true);
    expect(db.task.delete).toHaveBeenCalled();
  });

  it("a MANAGER may delete a task whose project owner reports to them", async () => {
    signIn(MANAGER);
    db.project.findUnique.mockResolvedValue({ id: "p-1", ownerUserId: "u-report", name: "P1" });
    // Assignee NOT in the subtree (someone else's report).
    db.teamMember.findUnique.mockImplementation(
      async ({ where }: { where: { userId?: string; email?: string; id?: string } }) =>
        where.id === "m-assignee" ? { id: "m-assignee", userId: "u-elsewhere" } : null,
    );
    db.task.findUnique.mockResolvedValue(TASK);
    const r = await deleteTask("t-1");
    expect(r.ok).toBe(true);
    expect(db.task.delete).toHaveBeenCalled();
  });

  it("a MANAGER outside the reporting chain is rejected", async () => {
    signIn(MANAGER);
    db.user.findMany.mockResolvedValue([]); // nobody reports to u-max
    db.task.findUnique.mockResolvedValue(TASK);
    expectErr(await deleteTask("t-1"), /assigned user, the project owner/i);
    expect(db.task.delete).not.toHaveBeenCalled();
  });

  it("HR cannot delete a task they are not assigned to (no task powers)", async () => {
    signIn(HR);
    db.task.findUnique.mockResolvedValue(TASK);
    expectErr(await deleteTask("t-1"), /assigned user, the project owner/i);
  });

  it("an unassigned, projectless task is ADMIN-only (a MANAGER has no subject)", async () => {
    signIn(MANAGER);
    db.task.findUnique.mockResolvedValue({ ...TASK, assigneeId: null, projectId: null });
    expectErr(await deleteTask("t-1"), /assigned user, the project owner/i);
  });

  it("anonymous callers are rejected before any lookup", async () => {
    signIn(null);
    db.task.findUnique.mockResolvedValue(TASK);
    expectErr(await deleteTask("t-1"), /signed in/i);
    expect(db.task.delete).not.toHaveBeenCalled();
  });
});

describe("getDashboardData managedUserIds (PR-61)", () => {
  function seedEmptyWorkspace() {
    db.project.findMany.mockResolvedValue([]);
    db.task.findMany.mockResolvedValue([]);
    db.teamMember.findMany.mockResolvedValue([]);
    db.reminder.findMany.mockResolvedValue([]);
    db.notification.findMany.mockResolvedValue([]);
    db.timeEntry.findMany.mockResolvedValue([]);
    db.calendarEvent.findMany.mockResolvedValue([]);
    db.message.findMany.mockResolvedValue([]);
    db.projectAssignment.findMany.mockResolvedValue([]);
    db.leaveRequest.findMany.mockResolvedValue([]);
  }

  it("MANAGER receives their reporting subtree (self + reports)", async () => {
    signIn(MANAGER);
    seedEmptyWorkspace();
    const data = await getDashboardData();
    expect(data.managedUserIds).toEqual(
      expect.arrayContaining(["u-max", "u-report"]),
    );
  });

  it("ADMIN and MEMBER receive an empty subtree (no hierarchy needed)", async () => {
    signIn(ADMIN);
    seedEmptyWorkspace();
    expect((await getDashboardData()).managedUserIds).toEqual([]);

    signIn(MEMBER);
    seedEmptyWorkspace();
    expect((await getDashboardData()).managedUserIds).toEqual([]);
  });
});
