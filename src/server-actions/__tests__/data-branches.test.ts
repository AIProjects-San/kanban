import { describe, it, expect, vi, beforeEach } from "vitest";

// Branch-matrix coverage for data.ts — targets the `!== undefined && changed`
// conditional chains in updateTask / updateUser / updateMember and the
// no-op / validation branches not exercised by the main suites.

const { db, getServerSession } = vi.hoisted(() => {
  const getServerSession = vi.fn();
  const models = [
    "auditLog", "project", "task", "teamMember", "reminder", "notification",
    "timeEntry", "calendarEvent", "message", "user", "userSettings",
    "projectAssignment", "workspace", "role", "permission", "rolePermission",
    "taskStatusConfig", "projectStatusConfig", "eventTypeConfig",
    "taskTagConfig", "priorityConfig", "departmentConfig",
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
  // Interactive transactions: execute the callback against the same mock so
  // tx.<model>.<method>() is recorded on the shared spies.
  (db as Record<string, unknown>).$transaction = vi.fn(
    async (fn: (tx: unknown) => Promise<unknown>) =>
      typeof fn === "function" ? fn(db) : Promise.resolve(fn),
  );
  return { db, getServerSession };
});

vi.mock("next-auth", () => ({ getServerSession }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/db", () => ({ db }));

import {
  updateTask,
  updateUser,
  updateMember,
  updateProject,
  deleteProject,
  deleteMember,
  deleteEvent,
  deleteMessage,
  unassignUserFromProject,
  getDashboardData,
} from "@/server-actions/data";
import type { ActionResult, ActionErrorCode } from "@/lib/action-result";

/** Assert an action failed, optionally matching the message regex or error code. */
function expectErr<T>(r: ActionResult<T>, matcher?: RegExp | ActionErrorCode): void {
  expect(r.ok).toBe(false);
  if (!r.ok && matcher) {
    if (matcher instanceof RegExp) expect(r.error).toMatch(matcher);
    else expect(r.code).toBe(matcher);
  }
}

/** Assert an action succeeded; returns the data payload. */
function expectOk<T>(r: ActionResult<T>): T {
  expect(r.ok).toBe(true);
  return r.ok ? r.data : (undefined as unknown as T);
}


const ADMIN = { userId: "u-admin", name: "Ada", email: "ada@fernly.dev", role: "ADMIN" as const };
const MANAGER = { userId: "u-mgr", name: "Max", email: "max@fernly.dev", role: "MANAGER" as const };

function signIn(user: typeof ADMIN | typeof MANAGER | null) {
  getServerSession.mockResolvedValue(
    user ? { user: { id: user.userId, name: user.name, email: user.email, role: user.role } } : null,
  );
}

const now = new Date("2026-01-15T10:00:00Z");

beforeEach(() => {
  vi.clearAllMocks();
  signIn(ADMIN);
  db.auditLog.create.mockResolvedValue({});
  db.teamMember.findUnique.mockResolvedValue(null);
});

describe("updateTask change-detection matrix", () => {
  const existing = {
    id: "t-1", title: "Old", description: "d", status: "TODO", priority: "LOW", tag: "QA",
    dueDate: null, projectId: "p-1", assigneeId: "m-mia", order: 0, createdAt: now, updatedAt: now,
  };

  function setup() {
    db.task.findUnique.mockResolvedValue(existing);
    db.task.update.mockResolvedValue(existing);
    db.task.findMany.mockResolvedValue([]); // recalcMemberStats
    db.teamMember.update.mockResolvedValue({});
  }

  it("detects every scalar field change", async () => {
    setup();
    await updateTask("t-1", {
      title: "New", description: "new d", status: "DONE", priority: "HIGH", tag: "BACKEND",
    });
    const detail = db.auditLog.create.mock.calls[0][0].data.detail as string;
    for (const field of ["title", "status", "priority", "tag", "description"]) {
      expect(detail).toContain(field);
    }
  });

  it("detects assignee changes and recalculates both members", async () => {
    setup();
    await updateTask("t-1", { assigneeId: "m-oli" });
    const updatedIds = db.teamMember.update.mock.calls.map((c) => c[0].where.id);
    expect(updatedIds).toEqual(expect.arrayContaining(["m-mia", "m-oli"]));
    expect(db.auditLog.create.mock.calls[0][0].data.detail).toContain("assignee");
  });

  it("detects null → date and date → null due-date transitions", async () => {
    setup();
    await updateTask("t-1", { dueDate: now.toISOString() });
    expect(db.auditLog.create.mock.calls[0][0].data.detail).toContain("due date");

    vi.clearAllMocks();
    setup();
    db.task.findUnique.mockResolvedValue({ ...existing, dueDate: now });
    await updateTask("t-1", { dueDate: null });
    expect(db.auditLog.create.mock.calls[0][0].data.detail).toContain("due date");
  });

  it("detects project changes", async () => {
    setup();
    await updateTask("t-1", { projectId: "p-2" });
    expect(db.auditLog.create.mock.calls[0][0].data.detail).toContain("project");
  });

  it("reports a plain save when nothing changed", async () => {
    setup();
    await updateTask("t-1", { title: "Old" });
    const detail = db.auditLog.create.mock.calls[0][0].data.detail as string;
    expect(detail).toMatch(/Saved task/);
    expect(detail).not.toContain(",");
  });

  it("skips due-date audit when the value is identical", async () => {
    setup();
    db.task.findUnique.mockResolvedValue({ ...existing, dueDate: now });
    await updateTask("t-1", { dueDate: now.toISOString() });
    const detail = db.auditLog.create.mock.calls[0][0].data.detail as string;
    expect(detail).not.toContain("due date");
  });
});

describe("updateUser optional-field branches", () => {
  const target = {
    id: "u-oli", name: "Oli", email: "oli@fernly.dev", role: "MEMBER",
    timezone: "UTC", bio: "", avatarColor: "forest",
  };

  function setup() {
    db.user.findUnique.mockResolvedValue(target);
    db.user.update.mockResolvedValue({});
    db.teamMember.updateMany.mockResolvedValue({});
  }

  it("rejects an invalid email update", async () => {
    setup();
    expectErr(await updateUser("u-oli", { email: "nope" }), /valid email/i);
  });

  it("rejects a short password reset", async () => {
    setup();
    expectErr(await updateUser("u-oli", { resetPassword: "short" }), /at least 8/i);
  });

  it("applies timezone/bio updates without touching email or role", async () => {
    setup();
    await updateUser("u-oli", { timezone: "Asia/Tokyo", bio: "hi" });
    const data = db.user.update.mock.calls[0][0].data;
    expect(data.timezone).toBe("Asia/Tokyo");
    expect(data.bio).toBe("hi");
    expect(data.email).toBeUndefined();
    expect(data.passwordHash).toBeUndefined();
    // No team-member sync when name/email/avatar are unchanged.
    expect(db.teamMember.updateMany).not.toHaveBeenCalled();
  });

  it("audits email changes", async () => {
    setup();
    await updateUser("u-oli", { email: "new@fernly.dev" });
    expect(db.auditLog.create.mock.calls[0][0].data.detail).toContain("email");
  });

  it("leaves an empty resetPassword as a no-op", async () => {
    setup();
    await updateUser("u-oli", { resetPassword: "" });
    const data = db.user.update.mock.calls[0][0].data;
    expect(data.passwordHash).toBeUndefined();
  });
});

describe("updateMember change-detection", () => {
  it("detects department and name changes", async () => {
    db.teamMember.findUnique.mockResolvedValue({ id: "m-2", name: "Nina", role: "Dev", department: "DESIGN", email: "n@x.co", online: false });
    db.teamMember.update.mockResolvedValue({});
    await updateMember("m-2", { name: "Nina B", department: "ENGINEERING" });
    const detail = db.auditLog.create.mock.calls[0][0].data.detail as string;
    expect(detail).toContain("name");
    expect(detail).toContain("department");
  });
});

describe("delete flows tolerate missing pre-images", () => {
  it("deleteProject with no existing row skips the audit but still soft-deletes (L-P0-14)", async () => {
    db.project.findUnique.mockResolvedValue(null);
    db.project.update.mockResolvedValue({});
    await deleteProject("ghost");
    // L-P0-14: soft-delete via update, not hard delete
    expect(db.project.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "ghost" }, data: expect.objectContaining({ deletedAt: expect.any(Date) }) }),
    );
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });

  it("deleteMember with no existing row skips the audit", async () => {
    db.teamMember.findUnique.mockResolvedValue(null);
    db.teamMember.delete.mockResolvedValue({});
    await deleteMember("ghost");
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });

  it("deleteEvent with no existing row skips the audit", async () => {
    db.calendarEvent.findUnique.mockResolvedValue(null);
    db.calendarEvent.delete.mockResolvedValue({});
    await deleteEvent("ghost");
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });

  it("deleteMessage with no existing row deletes without auditing", async () => {
    db.message.findUnique.mockResolvedValue(null);
    db.message.delete.mockResolvedValue({});
    expectOk(await deleteMessage("ghost"));
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });
});

describe("unassignUserFromProject without audit", () => {
  it("still deletes when the user or project cannot be found", async () => {
    db.user.findUnique.mockResolvedValue(null);
    db.project.findUnique.mockResolvedValue(null);
    db.projectAssignment.deleteMany.mockResolvedValue(0);
    await unassignUserFromProject("ghost", "ghost");
    expect(db.projectAssignment.deleteMany).toHaveBeenCalled();
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });
});

describe("updateProject partial-change branch", () => {
  it("does not audit untouched fields", async () => {
    const existing = { id: "p-1", name: "Apollo", description: "", status: "RUNNING", priority: "HIGH", dueDate: null, color: "forest", ownerName: "Ada", progress: 10, createdAt: now, updatedAt: now };
    db.project.findUnique.mockResolvedValue(existing);
    db.project.update.mockResolvedValue(existing);
    await updateProject("p-1", { description: "updated" });
    const detail = db.auditLog.create.mock.calls[0][0].data.detail as string;
    expect(detail).toContain("description");
    expect(detail).not.toContain("name");
  });
});

describe("getDashboardData MANAGER scoping", () => {
  it("applies the same scoping to MANAGER as to MEMBER", async () => {
    signIn(MANAGER);
    db.project.findMany.mockImplementation(({ where }: { where?: { ownerUserId?: string; id?: { in: string[] } } }) => {
      if (where?.ownerUserId) return Promise.resolve([{ id: "p-1" }]);
      return Promise.resolve([]);
    });
    db.task.findMany.mockImplementation(({ where }: { where?: { assignee?: unknown } }) => {
      if (where?.assignee) return Promise.resolve([]);
      return Promise.resolve([]);
    });
    db.projectAssignment.findMany.mockResolvedValue([{ projectId: "p-1", userId: "u-max" }]);
    db.teamMember.findMany.mockResolvedValue([]);
    db.reminder.findMany.mockResolvedValue([]);
    db.notification.findMany.mockResolvedValue([]);
    db.timeEntry.findMany.mockResolvedValue([]);
    db.calendarEvent.findMany.mockResolvedValue([]);
    db.message.findMany.mockResolvedValue([]);

    const data = await getDashboardData();
    expect(data.scope).toMatchObject({ isMember: false, projectIds: ["p-1"] });
    // Managers are scoped too: the main project query filters by id.
    const projectCall = db.project.findMany.mock.calls.at(-1)![0];
    expect(projectCall.where).toBeDefined();
  });

  it("returns only yourself in the member list when you have no projects", async () => {
    signIn(MANAGER);
    db.project.findMany.mockResolvedValue([]);
    db.task.findMany.mockResolvedValue([]);
    db.projectAssignment.findMany.mockResolvedValue([]);
    db.teamMember.findMany.mockResolvedValue([]);
    db.reminder.findMany.mockResolvedValue([]);
    db.notification.findMany.mockResolvedValue([]);
    db.timeEntry.findMany.mockResolvedValue([]);
    db.calendarEvent.findMany.mockResolvedValue([]);
    db.message.findMany.mockResolvedValue([]);

    await getDashboardData();
    const memberCall = db.teamMember.findMany.mock.calls.at(-1)![0];
    // "Only yourself" is resolved via the stable user-id link, never a name.
    // L-P0-14: also includes the soft-delete filter.
    expect(memberCall.where).toEqual({ userId: MANAGER.userId, deletedAt: null });
  });
});
