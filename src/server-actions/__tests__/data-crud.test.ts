import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks (same topology as data.test.ts — duplicated intentionally so each
// suite stays self-contained; see data.test.ts for the rationale comments).
// ---------------------------------------------------------------------------

const { db, getServerSession } = vi.hoisted(() => {
  const getServerSession = vi.fn();
  const models = [
    "auditLog", "project", "task", "teamMember", "reminder", "notification",
    "timeEntry", "calendarEvent", "message", "user", "userSettings",
    "projectAssignment", "workspace", "role", "permission", "rolePermission",
    "taskStatusConfig", "projectStatusConfig", "eventTypeConfig",
    "taskTagConfig", "priorityConfig", "departmentConfig",
    // P1 (edge-case audit) — changePassword now invalidates pending reset
    // tokens via $transaction, so the test mock needs this model.
    "passwordResetToken",
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
  getDashboardData,
  createTask,
  updateTask,
  moveTask,
  deleteTask,
  createProject,
  updateProject,
  deleteProject,
  createMember,
  updateMember,
  deleteMember,
  createEvent,
  deleteEvent,
  markNotificationRead,
  markAllNotificationsRead,
  toggleReminder,
  createReminder,
  updateProfile,
  getUserSettings,
  sendMessage,
  getUserByEmail,
  getAllUsers,
  updateUser,
  deleteUser,
  assignUserToProject,
  unassignUserFromProject,
  getUserProjectAssignments,
  getProjectAssignments,
  getAuditLogsForEntity,
  getMyProjects,
  getProjectMembers,
  changePassword,
  updateWorkspaceSettings,
  createConfigItem,
  updateConfigItem,
  deleteConfigItem,
  updateRole,
  createRole,
  deleteRole,
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
const MEMBER = { userId: "u-mia", name: "Mia", email: "mia@fernly.dev", role: "MEMBER" as const };

function signIn(user: typeof ADMIN | typeof MEMBER | null) {
  getServerSession.mockResolvedValue(
    user ? { user: { id: user.userId, name: user.name, email: user.email, role: user.role } } : null,
  );
}

const now = new Date("2026-01-15T10:00:00Z");
const later = new Date("2026-01-16T10:00:00Z");

beforeEach(() => {
  vi.clearAllMocks();
  signIn(ADMIN);
  db.auditLog.create.mockResolvedValue({});
  db.task.aggregate.mockResolvedValue({ _max: { order: 3 } });
  db.teamMember.findUnique.mockResolvedValue(null);
});

// ---------------------------------------------------------------------------
// getDashboardData — full mapping + stats
// ---------------------------------------------------------------------------

describe("getDashboardData mapping & stats", () => {
  function seedFullWorkspace() {
    db.project.findMany.mockImplementation(({ where }: { where?: { ownerUserId?: string; id?: { in: string[] } } }) => {
      const owned = [{ id: "p-owned", name: "Owned", ownerUserId: "u-mia" }];
      // First call = scoping pre-query (by owner user id); last call = main query.
      if (where?.ownerUserId) return Promise.resolve(owned.map((p) => ({ id: p.id })));
      const visible = where?.id?.in ?? [];
      return Promise.resolve(
        [
          {
            id: "p-1", name: "Apollo", description: "", status: "RUNNING", priority: "HIGH",
            progress: 50, color: "forest", ownerName: "Mia",
            dueDate: now, createdAt: now, updatedAt: now,
          },
          {
            id: "p-2", name: "Borealis", description: "", status: "ENDED", priority: "LOW",
            progress: 100, color: "ocean", ownerName: "Ada",
            dueDate: null, createdAt: now, updatedAt: now,
          },
        ].filter((p) => visible.length === 0 || visible.includes(p.id)),
      );
    });
    db.task.findMany.mockImplementation(({ where }: { where?: { assignee?: unknown } }) => {
      if (where?.assignee) {
        // Scoping pre-query: distinct projectIds for tasks assigned to Mia.
        return Promise.resolve([{ projectId: "p-1" }]);
      }
      return Promise.resolve([
        {
          id: "t-1", title: "A", description: "", status: "DONE", priority: "HIGH", tag: "QA",
          dueDate: now, projectId: "p-1", assigneeId: "m-mia", order: 0,
          // updatedAt must fall inside the rolling 7-day completion window.
          createdAt: now, updatedAt: new Date(),
          project: { id: "p-1", name: "Apollo", description: "", status: "RUNNING", priority: "HIGH", progress: 50, color: "forest", ownerName: "Mia", dueDate: now, createdAt: now, updatedAt: now },
          assignee: { id: "m-mia", name: "Mia", email: "mia@fernly.dev", role: "Dev", department: "ENGINEERING", avatarColor: "forest", online: true, openTasks: 1, completedTasks: 2, workload: 20, createdAt: now, updatedAt: now },
        },
        {
          id: "t-2", title: "B", description: "", status: "TODO", priority: "LOW", tag: "BACKEND",
          dueDate: null, projectId: null, assigneeId: null, order: 1,
          createdAt: now, updatedAt: now, project: null, assignee: null,
        },
      ]);
    });
    db.projectAssignment.findMany.mockResolvedValue([
      { projectId: "p-1", userId: "u-mia" },
    ]);
    db.teamMember.findMany.mockResolvedValue([
      { id: "m-mia", name: "Mia", email: "mia@fernly.dev", role: "Dev", department: "ENGINEERING", avatarColor: "forest", online: true, openTasks: 1, completedTasks: 2, workload: 20, createdAt: now, updatedAt: now },
    ]);
    db.reminder.findMany.mockResolvedValue([
      { id: "r-1", title: "Ship it", dueDate: now, completed: false, createdAt: now },
    ]);
    db.notification.findMany.mockResolvedValue([
      { id: "n-1", title: "Hello", body: "World", read: false, createdAt: now },
    ]);
    db.timeEntry.findMany.mockResolvedValue([
      { id: "te-1", projectId: "p-1", memberId: "m-mia", date: now, hours: 2.5, description: "", createdAt: now },
    ]);
    db.calendarEvent.findMany.mockResolvedValue([
      { id: "e-1", title: "Standup", description: "", date: now, time: "09:00", durationMin: 15, type: "MEETING", location: "", createdAt: now },
    ]);
    db.message.findMany.mockResolvedValue([
      { id: "msg-1", direction: "IN", threadId: "th-1", memberId: "m-mia", senderUserId: "u-oli", recipientUserId: "u-mia", senderName: "Oli", senderAvatarColor: "ocean", senderRole: "Dev", recipientName: "Mia", subject: "Hi", body: "Yo", read: false, createdAt: now, readBy: [] },
    ]);
  }

  it("maps Prisma rows into serialisable JSON-safe shapes", async () => {
    signIn(MEMBER);
    seedFullWorkspace();
    const data = await getDashboardData();

    // Dates are ISO strings, not Date objects.
    expect(typeof data.projects[0].createdAt).toBe("string");
    expect(data.tasks[0].dueDate).toBe(now.toISOString());
    expect(data.tasks[1].project).toBeNull();
    expect(data.tasks[1].assignee).toBeNull();
    expect(data.reminders[0].dueDate).toBe(now.toISOString());
    expect(data.timeEntries[0].hours).toBe(2.5);
    expect(data.events[0].durationMin).toBe(15);
    expect(data.messages[0].recipientUserId).toBe("u-mia");
  });

  it("computes project status counts from the visible projects", async () => {
    signIn(MEMBER);
    seedFullWorkspace();
    const data = await getDashboardData();
    // Both projects are visible to Mia (p-1 via tasks + assignment; p-2 is not
    // in the scoped set, so only p-1 counts if scoping worked). The scoped
    // project list = owned(p-owned) ∪ assigned(p-1) ∪ explicit(p-1) — the
    // seeded main query filters to those ids, so p-2 is excluded.
    expect(data.stats.total).toBe(1);
    expect(data.stats.running).toBe(1);
    expect(data.stats.ended).toBe(0);
    expect(data.stats.projectEndedPct).toBe(0);
  });

  it("computes weeklyCompletion as done/total of visible tasks", async () => {
    signIn(MEMBER);
    seedFullWorkspace();
    const data = await getDashboardData();
    // 2 visible tasks, 1 DONE → 50%.
    expect(data.stats.weeklyCompletion).toBe(50);
  });

  it("P2-21: weeklyCompletion excludes DONE tasks older than 7 days (weekAgo is actually used)", async () => {
    // The original bug: weekAgo was computed and never used, so a task marked
    // DONE six months ago was counted as "completed this week". The fix uses
    // `t.status === "DONE" && t.updatedAt >= weekAgo`.
    signIn(MEMBER);
    seedFullWorkspace();
    const stale = new Date();
    stale.setDate(stale.getDate() - 30); // 30 days ago — outside the 7-day window
    // Override the task mock: 2 DONE tasks, but one is stale.
    db.task.findMany.mockImplementation(({ where }: { where?: { assignee?: unknown } }) => {
      if (where?.assignee) return Promise.resolve([{ projectId: "p-1" }]);
      return Promise.resolve([
        {
          id: "t-fresh", title: "Fresh", description: "", status: "DONE", priority: "HIGH", tag: "QA",
          dueDate: now, projectId: "p-1", assigneeId: "m-mia", order: 0,
          createdAt: now, updatedAt: new Date(), // today
          project: { id: "p-1", name: "Apollo", description: "", status: "RUNNING", priority: "HIGH", progress: 50, color: "forest", ownerName: "Mia", dueDate: now, createdAt: now, updatedAt: now },
          assignee: { id: "m-mia", name: "Mia", email: "mia@fernly.dev", role: "Dev", department: "ENGINEERING", avatarColor: "forest", online: true, openTasks: 1, completedTasks: 2, workload: 20, createdAt: now, updatedAt: now },
        },
        {
          id: "t-stale", title: "Stale", description: "", status: "DONE", priority: "LOW", tag: "BACKEND",
          dueDate: null, projectId: "p-1", assigneeId: "m-mia", order: 1,
          createdAt: now, updatedAt: stale, // 30 days ago — must NOT count
          project: { id: "p-1", name: "Apollo", description: "", status: "RUNNING", priority: "HIGH", progress: 50, color: "forest", ownerName: "Mia", dueDate: now, createdAt: now, updatedAt: now },
          assignee: { id: "m-mia", name: "Mia", email: "mia@fernly.dev", role: "Dev", department: "ENGINEERING", avatarColor: "forest", online: true, openTasks: 1, completedTasks: 2, workload: 20, createdAt: now, updatedAt: now },
        },
      ]);
    });
    const data = await getDashboardData();
    // 2 DONE tasks total, but only 1 was updated within the last 7 days → 50%.
    // If weekAgo were ignored (the original bug), this would be 100%.
    expect(data.stats.weeklyCompletion).toBe(50);
  });

  it("P2-21: weeklyCompletion is 0 when every DONE task is older than 7 days", async () => {
    signIn(MEMBER);
    seedFullWorkspace();
    const stale = new Date();
    stale.setDate(stale.getDate() - 10); // 10 days ago
    db.task.findMany.mockImplementation(({ where }: { where?: { assignee?: unknown } }) => {
      if (where?.assignee) return Promise.resolve([{ projectId: "p-1" }]);
      return Promise.resolve([
        {
          id: "t-old", title: "Old", description: "", status: "DONE", priority: "HIGH", tag: "QA",
          dueDate: now, projectId: "p-1", assigneeId: "m-mia", order: 0,
          createdAt: now, updatedAt: stale,
          project: { id: "p-1", name: "Apollo", description: "", status: "RUNNING", priority: "HIGH", progress: 50, color: "forest", ownerName: "Mia", dueDate: now, createdAt: now, updatedAt: now },
          assignee: { id: "m-mia", name: "Mia", email: "mia@fernly.dev", role: "Dev", department: "ENGINEERING", avatarColor: "forest", online: true, openTasks: 1, completedTasks: 2, workload: 20, createdAt: now, updatedAt: now },
        },
        {
          id: "t-todo", title: "Todo", description: "", status: "TODO", priority: "LOW", tag: "BACKEND",
          dueDate: null, projectId: "p-1", assigneeId: "m-mia", order: 1,
          createdAt: now, updatedAt: now,
          project: { id: "p-1", name: "Apollo", description: "", status: "RUNNING", priority: "HIGH", progress: 50, color: "forest", ownerName: "Mia", dueDate: now, createdAt: now, updatedAt: now },
          assignee: { id: "m-mia", name: "Mia", email: "mia@fernly.dev", role: "Dev", department: "ENGINEERING", avatarColor: "forest", online: true, openTasks: 1, completedTasks: 2, workload: 20, createdAt: now, updatedAt: now },
        },
      ]);
    });
    const data = await getDashboardData();
    // 1 DONE task, but it's stale → 0% completed this week.
    expect(data.stats.weeklyCompletion).toBe(0);
  });

  it("never lets audit-write failures break the main query path", async () => {
    signIn(MEMBER);
    seedFullWorkspace();
    const data = await getDashboardData();
    expect(data.projects).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Audit resilience — logAudit failures must never break operations
// ---------------------------------------------------------------------------

describe("audit logging resilience", () => {
  it("createReminder still succeeds when the audit write fails", async () => {
    db.auditLog.create.mockRejectedValue(new Error("audit table missing"));
    db.reminder.create.mockResolvedValue({ id: "r-9", title: "T", dueDate: now, completed: false, createdAt: now });
    expectOk(await createReminder({ title: "T", dueDate: now.toISOString() }));
    expect(db.reminder.create).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Task lifecycle
// ---------------------------------------------------------------------------

describe("task lifecycle", () => {
  const existing = {
    id: "t-1", title: "Old", description: "d", status: "TODO", priority: "LOW", tag: "QA",
    dueDate: null, projectId: "p-1", assigneeId: "m-mia", order: 0, createdAt: now, updatedAt: now,
  };

  it("createTask assigns order = max+1 and recalculates member stats", async () => {
    db.task.create.mockResolvedValue({ ...existing, project: { name: "Apollo" } });
    db.teamMember.update.mockResolvedValue({});
    await createTask({ title: "New", assigneeId: "m-mia", status: "TODO" });
    expect(db.task.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ order: 4, status: "TODO", priority: "MEDIUM", tag: "FRONTEND" }),
      }),
    );
    // recalcMemberStats ran for the assignee
    expect(db.teamMember.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "m-mia" } }),
    );
  });

  it("recalcMemberStats computes open/completed/workload (cap 6 open = 100%)", async () => {
    const tasks = Array.from({ length: 7 }, (_, i) => ({ id: `t-${i}`, status: "TODO", assigneeId: "m-mia" }))
      .concat([{ id: "t-done", status: "DONE", assigneeId: "m-mia" }]);
    db.task.findUnique.mockResolvedValue(existing);
    db.task.findMany.mockResolvedValue(tasks);
    db.task.update.mockResolvedValue(existing);
    db.teamMember.update.mockResolvedValue({});
    // L-P0-16: workspace row missing → fallback capacity of 6
    db.workspace.findUnique.mockResolvedValue(null);

    await updateTask("t-1", { title: "New title" });

    const updateCall = db.teamMember.update.mock.calls.find(
      (c) => c[0].where.id === "m-mia",
    );
    expect(updateCall?.[0].data).toEqual({ openTasks: 7, completedTasks: 1, workload: 100 });
  });

  it("recalcMemberStats honours Workspace.workloadFullCapacity (L-P0-16)", async () => {
    // Workspace capacity set to 10 — 5 open tasks = 50% workload, not the
    // hardcoded-6 default of 83%. Verifies the admin-editable setting is wired.
    const tasks = Array.from({ length: 5 }, (_, i) => ({ id: `t-${i}`, status: "TODO", assigneeId: "m-mia" }))
      .concat([{ id: "t-done", status: "DONE", assigneeId: "m-mia" }]);
    db.task.findUnique.mockResolvedValue(existing);
    db.task.findMany.mockResolvedValue(tasks);
    db.task.update.mockResolvedValue(existing);
    db.teamMember.update.mockResolvedValue({});
    db.workspace.findUnique.mockResolvedValue({ workloadFullCapacity: 10 });

    await updateTask("t-1", { title: "New title" });

    const updateCall = db.teamMember.update.mock.calls.find(
      (c) => c[0].where.id === "m-mia",
    );
    expect(updateCall?.[0].data).toEqual({ openTasks: 5, completedTasks: 1, workload: 50 });
    expect(db.workspace.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "default" } }),
    );
  });

  it("updateTask reports changed fields in the audit detail", async () => {
    db.task.findUnique.mockResolvedValue(existing);
    db.task.update.mockResolvedValue({ ...existing, title: "New" });
    db.teamMember.update.mockResolvedValue({});
    await updateTask("t-1", { title: "New", status: "DONE" });
    const audit = db.auditLog.create.mock.calls[0][0];
    expect(audit.data.action).toBe("task.updated");
    expect(audit.data.detail).toMatch(/title/);
    expect(audit.data.detail).toMatch(/status/);
  });

  it("moveTask logs a task.moved audit entry when the status changes", async () => {
    db.task.findUnique.mockResolvedValue(existing);
    db.task.update.mockResolvedValue(existing);
    db.teamMember.update.mockResolvedValue({});
    await moveTask("t-1", "DONE", 2);
    expect(db.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "task.moved", entityType: "TASK" }),
      }),
    );
  });

  it("moveTask skips the audit entry when the status is unchanged", async () => {
    db.task.findUnique.mockResolvedValue(existing);
    db.task.update.mockResolvedValue(existing);
    db.teamMember.update.mockResolvedValue({});
    await moveTask("t-1", "TODO", 5);
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });

  it("deleteTask removes the task and recalculates the assignee stats", async () => {
    db.task.findUnique.mockResolvedValue(existing);
    db.task.delete.mockResolvedValue(existing);
    db.teamMember.update.mockResolvedValue({});
    await deleteTask("t-1");
    expect(db.task.delete).toHaveBeenCalledWith({ where: { id: "t-1" } });
    expect(db.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "task.deleted", entityLabel: "Old" }),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Project lifecycle
// ---------------------------------------------------------------------------

describe("project lifecycle", () => {
  const existing = { id: "p-1", name: "Apollo", description: "", status: "RUNNING", priority: "HIGH", dueDate: now, color: "forest", ownerName: "Ada", progress: 10, createdAt: now, updatedAt: now };

  it("createProject applies defaults", async () => {
    db.project.create.mockResolvedValue(existing);
    await createProject({ name: "Apollo" });
    expect(db.project.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "RUNNING", priority: "MEDIUM", color: "forest", ownerName: "" }),
      }),
    );
  });

  it("updateProject audits the changed fields", async () => {
    db.project.findUnique.mockResolvedValue(existing);
    db.project.update.mockResolvedValue(existing);
    await updateProject("p-1", { name: "Apollo II", progress: 80 });
    const audit = db.auditLog.create.mock.calls[0][0];
    expect(audit.data.detail).toMatch(/name/);
    expect(audit.data.detail).toMatch(/progress/);
  });

  it("updateProject handles null dueDate transitions", async () => {
    db.project.findUnique.mockResolvedValue({ ...existing, dueDate: null });
    db.project.update.mockResolvedValue(existing);
    await updateProject("p-1", { dueDate: later.toISOString() });
    const audit = db.auditLog.create.mock.calls[0][0];
    expect(audit.data.detail).toMatch(/due date/);
  });

  it("deleteProject audits the removal", async () => {
    db.project.findUnique.mockResolvedValue(existing);
    db.project.delete.mockResolvedValue(existing);
    await deleteProject("p-1");
    expect(db.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "project.deleted", entityLabel: "Apollo" }),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Team member + calendar lifecycle
// ---------------------------------------------------------------------------

describe("member lifecycle", () => {
  it("createMember applies avatar/online defaults and audits", async () => {
    db.teamMember.create.mockResolvedValue({ id: "m-2", name: "Nina", role: "Dev" });
    await createMember({ name: "Nina", role: "Dev", department: "DESIGN", email: "nina@fernly.dev" });
    expect(db.teamMember.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ avatarColor: "forest", online: false }),
      }),
    );
    expect(db.auditLog.create).toHaveBeenCalled();
  });

  it("updateMember diffs against the existing row", async () => {
    db.teamMember.findUnique.mockResolvedValue({ id: "m-2", name: "Nina", role: "Dev", department: "DESIGN", email: "n@x.co", online: false });
    db.teamMember.update.mockResolvedValue({});
    await updateMember("m-2", { role: "Senior Dev", online: true });
    const audit = db.auditLog.create.mock.calls[0][0];
    expect(audit.data.detail).toMatch(/job title/);
    expect(audit.data.detail).toMatch(/availability/);
  });

  it("deleteMember audits the removal", async () => {
    db.teamMember.findUnique.mockResolvedValue({ id: "m-2", name: "Nina", role: "Dev" });
    db.teamMember.delete.mockResolvedValue({});
    await deleteMember("m-2");
    expect(db.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "member.removed" }),
      }),
    );
  });
});

describe("calendar lifecycle", () => {
  it("createEvent applies defaults and formats the day in the audit detail", async () => {
    db.calendarEvent.create.mockResolvedValue({ id: "e-1", title: "Review", date: now, time: "09:00" });
    await createEvent({ title: "Review", date: now.toISOString() });
    expect(db.calendarEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ time: "09:00", durationMin: 60, type: "MEETING" }),
      }),
    );
    const audit = db.auditLog.create.mock.calls[0][0];
    expect(audit.data.detail).toMatch(/15 Jan/i);
  });

  it("deleteEvent audits the removal", async () => {
    db.calendarEvent.findUnique.mockResolvedValue({ id: "e-1", title: "Review" });
    db.calendarEvent.delete.mockResolvedValue({});
    await deleteEvent("e-1");
    expect(db.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "event.deleted", entityLabel: "Review" }),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Reminders & notifications
// ---------------------------------------------------------------------------

describe("reminders & notifications", () => {
  it("toggleReminder audits completion state changes in both directions", async () => {
    db.reminder.findUnique.mockResolvedValue({ id: "r-1", title: "Ship", completed: false });
    db.reminder.update.mockResolvedValue({});
    await toggleReminder("r-1", true);
    expect(db.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: "reminder.completed" }) }),
    );

    vi.clearAllMocks();
    db.reminder.findUnique.mockResolvedValue({ id: "r-1", title: "Ship", completed: true });
    db.reminder.update.mockResolvedValue({});
    await toggleReminder("r-1", false);
    expect(db.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: "reminder.reopened" }) }),
    );
  });

  it("toggleReminder skips auditing when nothing changed", async () => {
    db.reminder.findUnique.mockResolvedValue({ id: "r-1", title: "Ship", completed: false });
    db.reminder.update.mockResolvedValue({});
    await toggleReminder("r-1", false);
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });

  it("createReminder creates and audits", async () => {
    db.reminder.create.mockResolvedValue({ id: "r-2", title: "Call", dueDate: now });
    await createReminder({ title: "Call", dueDate: now.toISOString() });
    expect(db.reminder.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ title: "Call" }) }),
    );
    expect(db.auditLog.create).toHaveBeenCalled();
  });

  it("markNotificationRead updates your own notification once signed in", async () => {
    signIn(MEMBER);
    db.notification.findUnique.mockResolvedValue({ id: "n-1", recipientUserId: MEMBER.userId, read: false });
    db.notification.update.mockResolvedValue({});
    expectOk(await markNotificationRead("n-1", true));
    expect(db.notification.update).toHaveBeenCalledWith({ where: { id: "n-1" }, data: { read: true } });
  });

  it("markNotificationRead refuses to flip another user's private notification", async () => {
    signIn(MEMBER);
    db.notification.findUnique.mockResolvedValue({ id: "n-1", recipientUserId: "u-oli", read: false });
    expectErr(await markNotificationRead("n-1", true), /own notifications/i);
    expect(db.notification.update).not.toHaveBeenCalled();
  });

  it("markNotificationRead lets only role:manage flip workspace-wide broadcasts", async () => {
    // MEMBER: denied — flipping a broadcast would clear it for everyone.
    signIn(MEMBER);
    db.notification.findUnique.mockResolvedValue({ id: "n-1", recipientUserId: null, read: false });
    expectErr(await markNotificationRead("n-1", true), /admin/i);
    expect(db.notification.update).not.toHaveBeenCalled();
    // ADMIN: allowed (curation).
    signIn(ADMIN);
    db.notification.findUnique.mockResolvedValue({ id: "n-1", recipientUserId: null, read: false });
    expectOk(await markNotificationRead("n-1", true));
    expect(db.notification.update).toHaveBeenCalledWith({ where: { id: "n-1" }, data: { read: true } });
  });

  it("markAllNotificationsRead flips only the caller's own unread rows", async () => {
    signIn(MEMBER);
    db.notification.updateMany.mockResolvedValue({ count: 3 });
    expectOk(await markAllNotificationsRead());
    expect(db.notification.updateMany).toHaveBeenCalledWith({
      where: { recipientUserId: MEMBER.userId, read: false },
      data: { read: true },
    });
  });
});

// ---------------------------------------------------------------------------
// Profiles, settings & messaging
// ---------------------------------------------------------------------------

describe("profile & settings", () => {
  it("updateProfile diffs and audits own-profile changes", async () => {
    signIn(MEMBER);
    db.user.findUnique.mockResolvedValue({ id: MEMBER.userId, name: "Mia", role: "MEMBER", timezone: "UTC", bio: "", avatarColor: "forest" });
    db.user.update.mockResolvedValue({});
    db.teamMember.updateMany.mockResolvedValue({ count: 1 });
    await updateProfile(MEMBER.userId, {
      name: "Mia", timezone: "Pacific/Auckland", bio: "new bio", avatarColor: "ocean",
    });
    const audit = db.auditLog.create.mock.calls[0][0];
    expect(audit.data.detail).toMatch(/timezone/);
    expect(audit.data.detail).toMatch(/bio/);
    expect(audit.data.detail).toMatch(/avatar color/);
  });

  // Deep-dive review F-01 (CRITICAL) — regression tests. updateProfile used
  // to spread the raw client payload into db.user.update, so a client could
  // set `role: "ADMIN"` on its own account and self-promote.
  it("updateProfile NEVER writes User.role — a client-sent role is stripped (F-01)", async () => {
    signIn(MEMBER);
    db.user.findUnique.mockResolvedValue({ id: MEMBER.userId, name: "Mia", role: "MEMBER", timezone: "UTC", bio: "", avatarColor: "forest" });
    db.user.update.mockResolvedValue({});
    db.teamMember.updateMany.mockResolvedValue({ count: 1 });
    await updateProfile(MEMBER.userId, {
      name: "Mia", timezone: "UTC", bio: "", avatarColor: "forest",
      // forged extra field — must be ignored by the schema + never reach Prisma
      role: "ADMIN",
    } as never);
    const data = db.user.update.mock.calls[0][0].data;
    expect(data.role).toBeUndefined();
    expect(data).not.toHaveProperty("role");
  });

  it("updateProfile rejects payloads that fail the profile schema (F-11)", async () => {
    signIn(MEMBER);
    const res = await updateProfile(MEMBER.userId, {
      name: "", timezone: "UTC", bio: "", avatarColor: "forest",
    });
    expect(res.ok).toBe(false);
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it("updateProfile syncs the new name/avatar to the linked roster row", async () => {
    signIn(MEMBER);
    db.user.findUnique.mockResolvedValue({ id: MEMBER.userId, name: "Mia", role: "MEMBER", timezone: "UTC", bio: "", avatarColor: "forest" });
    db.user.update.mockResolvedValue({});
    db.teamMember.updateMany.mockResolvedValue({ count: 1 });
    await updateProfile(MEMBER.userId, {
      name: "Mia Renamed", timezone: "UTC", bio: "", avatarColor: "ocean",
    });
    expect(db.teamMember.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: MEMBER.userId },
        data: expect.objectContaining({ name: "Mia Renamed", avatarColor: "ocean" }),
      }),
    );
  });

  it("getUserSettings returns DB values when present", async () => {
    db.userSettings.findUnique.mockResolvedValue({
      accent: "ocean", dark: true, notifEmail: false, notifPush: true,
      notifMentions: false, notifDueToday: true, notifWeekly: true, notifProduct: false,
    });
    const s = await getUserSettings(MEMBER.userId);
    expect(s).toMatchObject({ accent: "ocean", dark: true, notifEmail: false, notifWeekly: true });
  });

  it("getUserSettings returns defaults when the user has no settings row", async () => {
    db.userSettings.findUnique.mockResolvedValue(null);
    const s = await getUserSettings(MEMBER.userId);
    expect(s).toMatchObject({ accent: "forest", dark: false, notifEmail: true });
  });

  it("getUserSettings rejects anonymous callers", async () => {
    signIn(null);
    await expect(getUserSettings(MEMBER.userId)).rejects.toThrow(/signed in/i);
  });

  it("sendMessage reuses the provided threadId and generates one when absent (L-P0-2)", async () => {
    signIn(MEMBER);
    db.message.create.mockResolvedValue({});
    const explicit = expectOk(await sendMessage({
      direction: "OUT", threadId: "th-42", senderName: "Mia",
      recipientName: "Oli", subject: "Re: hi", body: "yo",
    }));
    expect(explicit).toBe("th-42");
    expect(db.message.create).toHaveBeenCalledWith(
      expect.objectContaining({
        // L-P0-2: direction is now always "OUT" at write time (derived per
        // viewer at read time); read is false because the recipient hasn't
        // seen it yet (the sender's own copy is implicitly read at read time).
        data: expect.objectContaining({ threadId: "th-42", direction: "OUT", read: false, senderUserId: MEMBER.userId }),
      }),
    );

    const generated = expectOk(await sendMessage({
      direction: "IN", senderName: "Oli", recipientName: "Mia", subject: "Hi", body: "yo",
    }));
    expect(generated).toBeTruthy();
    expect(generated).not.toBe("th-42");
  });

  // Deep-dive review F-08 — the sender's display identity must be derived
  // from the session, never from the client payload.
  it("sendMessage derives sender identity from the session, not the payload (F-08)", async () => {
    signIn(MEMBER);
    db.message.create.mockResolvedValue({});
    db.teamMember.findUnique.mockResolvedValue({ name: "Mia Roster", role: "Designer", avatarColor: "plum" });
    await sendMessage({
      senderName: "Imposter Name",
      senderRole: "CEO",
      senderAvatarColor: "ember",
      recipientName: "Oli",
      subject: "s",
      body: "b",
    });
    const data = db.message.create.mock.calls[0][0].data;
    expect(data.senderName).toBe("Mia Roster");
    expect(data.senderRole).toBe("Designer");
    expect(data.senderAvatarColor).toBe("plum");
  });

  it("sendMessage resolves the recipient name from the DB when recipientUserId is set (F-08)", async () => {
    signIn(MEMBER);
    db.message.create.mockResolvedValue({});
    db.user.findUnique.mockResolvedValue({ name: "Real Recipient" });
    await sendMessage({
      recipientUserId: "u-oli",
      recipientName: "Forged Recipient",
      subject: "s",
      body: "b",
    });
    const data = db.message.create.mock.calls[0][0].data;
    expect(data.recipientName).toBe("Real Recipient");
  });

  it("getUserByEmail returns the recipient lookup result", async () => {
    db.user.findUnique.mockResolvedValue({ id: "u-oli", name: "Oli", email: "oli@fernly.dev", avatarColor: "ocean" });
    const u = expectOk(await getUserByEmail("oli@fernly.dev"));
    expect(u).toMatchObject({ id: "u-oli" });
    db.user.findUnique.mockResolvedValue(null);
    expect(expectOk(await getUserByEmail("ghost@fernly.dev"))).toBeNull();
  });

  it("getUserByEmail normalises the email to lowercase", async () => {
    db.user.findUnique.mockResolvedValue(null);
    await getUserByEmail("MiXeD@Case.dev");
    expect(db.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { email: "mixed@case.dev", deletedAt: null } }),
    );
  });
});

// ---------------------------------------------------------------------------
// User management (admin)
// ---------------------------------------------------------------------------

describe("user management", () => {
  it("getAllUsers maps project counts", async () => {
    db.user.findMany.mockResolvedValue([
      {
        id: "u-oli", email: "oli@fernly.dev", name: "Oli", role: "MEMBER",
        avatarColor: "ocean", createdAt: now, _count: { projectAssignments: 4 },
      },
    ]);
    const users = expectOk(await getAllUsers());
    expect(users[0].projectCount).toBe(4);
    expect(users[0].createdAt).toBe(now.toISOString());
  });

  it("updateUser syncs name/email/avatar to the matching team member", async () => {
    db.user.findUnique.mockResolvedValue({ id: "u-oli", name: "Oli", email: "oli@fernly.dev", role: "MEMBER", timezone: "UTC", bio: "", avatarColor: "forest" });
    db.user.update.mockResolvedValue({});
    db.teamMember.updateMany.mockResolvedValue({});
    await updateUser("u-oli", { name: "Oliver", avatarColor: "plum" });
    expect(db.teamMember.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { email: "oli@fernly.dev" },
        data: { name: "Oliver", avatarColor: "plum" },
      }),
    );
  });

  it("updateUser hashes a password reset", async () => {
    db.user.findUnique.mockResolvedValue({ id: "u-oli", name: "Oli", email: "oli@fernly.dev", role: "MEMBER", timezone: "UTC", bio: "", avatarColor: "forest" });
    db.user.update.mockResolvedValue({});
    db.teamMember.updateMany.mockResolvedValue({});
    await updateUser("u-oli", { resetPassword: "brand-new-pw" });
    const data = db.user.update.mock.calls[0][0].data;
    expect(data.passwordHash).toMatch(/^\$2[aby]\$/);
    expect(data.passwordHash).not.toBe("brand-new-pw");
  });

  it("deleteUser soft-deletes the account and audits it (L-P0-14)", async () => {
    db.user.findUnique.mockResolvedValue({ id: "u-oli", name: "Oli", email: "oli@fernly.dev" });
    db.user.update.mockResolvedValue({});
    db.teamMember.updateMany.mockResolvedValue({});
    await deleteUser("u-oli");
    // L-P0-14: soft-delete via update (sets deletedAt), not hard delete
    expect(db.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "u-oli" }, data: expect.objectContaining({ deletedAt: expect.any(Date) }) }),
    );
    // Also soft-deletes the matching TeamMember row
    expect(db.teamMember.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ email: "oli@fernly.dev", deletedAt: null }),
        data: expect.objectContaining({ deletedAt: expect.any(Date) }),
      }),
    );
    expect(db.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "user.deleted", detail: expect.stringContaining("oli@fernly.dev") }),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Project assignments
// ---------------------------------------------------------------------------

describe("project assignments", () => {
  it("assignUserToProject upserts idempotently", async () => {
    db.user.findUnique.mockResolvedValue({ id: "u-oli", name: "Oli" });
    db.project.findUnique.mockResolvedValue({ id: "p-1", name: "Apollo" });
    db.projectAssignment.upsert.mockResolvedValue({});
    await assignUserToProject("u-oli", "p-1", "MANAGER");
    expect(db.projectAssignment.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { projectId_userId: { projectId: "p-1", userId: "u-oli" } },
        create: { projectId: "p-1", userId: "u-oli", role: "MANAGER" },
        update: { role: "MANAGER" },
      }),
    );
  });

  it("assignUserToProject rejects unknown users or projects", async () => {
    db.user.findUnique.mockResolvedValue(null);
    expectErr(await assignUserToProject("ghost", "p-1"), /user not found/i);
    db.user.findUnique.mockResolvedValue({ id: "u-oli", name: "Oli" });
    db.project.findUnique.mockResolvedValue(null);
    expectErr(await assignUserToProject("u-oli", "ghost"), /project not found/i);
  });

  it("unassignUserFromProject deletes the assignment", async () => {
    db.user.findUnique.mockResolvedValue({ id: "u-oli", name: "Oli" });
    db.project.findUnique.mockResolvedValue({ id: "p-1", name: "Apollo" });
    db.projectAssignment.deleteMany.mockResolvedValue(1);
    await unassignUserFromProject("u-oli", "p-1");
    expect(db.projectAssignment.deleteMany).toHaveBeenCalledWith({
      where: { projectId: "p-1", userId: "u-oli" },
    });
  });

  it("getUserProjectAssignments maps project info", async () => {
    db.projectAssignment.findMany.mockResolvedValue([
      { id: "a-1", projectId: "p-1", userId: "u-oli", role: "MEMBER", createdAt: now, project: { id: "p-1", name: "Apollo", color: "forest", status: "RUNNING" } },
    ]);
    const list = expectOk(await getUserProjectAssignments("u-oli"));
    expect(list[0]).toMatchObject({ projectId: "p-1", project: { name: "Apollo" } });
  });

  it("getProjectAssignments maps user info", async () => {
    db.projectAssignment.findMany.mockResolvedValue([
      { id: "a-1", projectId: "p-1", userId: "u-oli", role: "MEMBER", createdAt: now, user: { id: "u-oli", name: "Oli", email: "oli@fernly.dev", role: "MEMBER", avatarColor: "ocean" } },
    ]);
    const list = expectOk(await getProjectAssignments("p-1"));
    expect(list[0].user).toMatchObject({ name: "Oli" });
  });
});

// ---------------------------------------------------------------------------
// Read helpers
// ---------------------------------------------------------------------------

describe("read helpers", () => {
  it("getAuditLogsForEntity returns [] for an empty entityId", async () => {
    const logs = expectOk(await getAuditLogsForEntity("TASK", ""));
    expect(logs).toEqual([]);
    expect(db.auditLog.findMany).not.toHaveBeenCalled();
  });

  it("getAuditLogsForEntity caps results at 50", async () => {
    db.auditLog.findMany.mockResolvedValue([]);
    await getAuditLogsForEntity("TASK", "t-1");
    expect(db.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 50 }),
    );
  });

  it("getMyProjects finds owned, assigned and explicitly-assigned projects", async () => {
    db.project.findMany.mockResolvedValue([{ id: "p-1", name: "Apollo", color: "forest", status: "RUNNING" }]);
    const projects = expectOk(await getMyProjects());
    const where = db.project.findMany.mock.calls[0][0].where;
    expect(where.OR).toHaveLength(3);
    // Identity matching must go through the stable user id, never the name.
    expect(where.OR).toEqual(expect.arrayContaining([
      expect.objectContaining({ ownerUserId: ADMIN.userId }),
      expect.objectContaining({ tasks: { some: { assignee: { userId: ADMIN.userId } } } }),
      expect.objectContaining({ assignments: { some: { userId: ADMIN.userId } } }),
    ]));
    expect(projects[0].name).toBe("Apollo");
  });

  it("getMyProjects returns [] when signed out", async () => {
    signIn(null);
    expect(await getMyProjects()).toEqual({ ok: true, data: [] });
    expect(db.project.findMany).not.toHaveBeenCalled();
  });

  it("getProjectMembers merges owner + assigned members without duplicates", async () => {
    db.project.findUnique.mockResolvedValue({ id: "p-1", name: "Apollo", ownerUserId: "u-ada" });
    const member = (id: string, name: string, userId: string | null = null) => ({
      id, name, userId, email: `${name.toLowerCase()}@fernly.dev`, role: "Dev", department: "ENGINEERING",
      avatarColor: "forest", online: false, openTasks: 0, completedTasks: 0, workload: 0,
    });
    db.teamMember.findMany.mockResolvedValue([member("m-mia", "Mia"), member("m-ada", "Ada", "u-ada")]);
    // The owner is resolved via the stable user-id link, not by name.
    db.teamMember.findUnique.mockResolvedValue(member("m-ada", "Ada", "u-ada"));

    const merged = expectOk(await getProjectMembers("p-1"));
    expect(db.teamMember.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "u-ada" } }),
    );
    expect(merged).toHaveLength(2);
    const ada = merged.find((m) => m.name === "Ada")!;
    expect(ada.isOwner).toBe(true);
    const mia = merged.find((m) => m.name === "Mia")!;
    expect(mia.isOwner).toBe(false);
  });

  it("getProjectMembers returns [] for unknown projects", async () => {
    db.project.findUnique.mockResolvedValue(null);
    expect(await getProjectMembers("ghost")).toEqual({ ok: true, data: [] });
  });
});

// ---------------------------------------------------------------------------
// changePassword happy path
// ---------------------------------------------------------------------------

describe("changePassword happy path", () => {
  it("verifies the current password and stores a new hash", async () => {
    signIn(MEMBER);
    const bcrypt = (await import("bcryptjs")).default;
    const currentHash = bcrypt.hashSync("current-password-1", 4);
    db.user.findUnique.mockResolvedValue({
      id: MEMBER.userId, email: MEMBER.email, name: MEMBER.name, passwordHash: currentHash,
    });
    db.user.update.mockResolvedValue({});

    await changePassword({
      userId: MEMBER.userId,
      currentPassword: "current-password-1",
      newPassword: "brand-new-pass",
    });

    const data = db.user.update.mock.calls[0][0].data;
    expect(await bcrypt.compare("brand-new-pass", data.passwordHash)).toBe(true);
    expect(db.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "auth.password_changed" }),
      }),
    );
  });

  it("bumps tokenVersion on password change — invalidates existing sessions (L-P0-8)", async () => {
    signIn(MEMBER);
    const bcrypt = (await import("bcryptjs")).default;
    const currentHash = bcrypt.hashSync("current-password-1", 4);
    db.user.findUnique.mockResolvedValue({
      id: MEMBER.userId, email: MEMBER.email, name: MEMBER.name, passwordHash: currentHash,
    });
    db.user.update.mockResolvedValue({});

    await changePassword({
      userId: MEMBER.userId,
      currentPassword: "current-password-1",
      newPassword: "brand-new-pass",
    });

    // The Prisma increment form is { increment: 1 } — verifies the bump is
    // atomic with the password hash update.
    const data = db.user.update.mock.calls[0][0].data;
    expect(data.tokenVersion).toEqual({ increment: 1 });
  });
});

// ---------------------------------------------------------------------------
// Workspace config & role mutations (happy paths)
// ---------------------------------------------------------------------------

describe("workspace config mutations", () => {
  it("updateWorkspaceSettings upserts the singleton row", async () => {
    db.workspace.upsert.mockResolvedValue({});
    await updateWorkspaceSettings({ name: "Renamed", minPasswordLength: 12 });
    expect(db.workspace.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "default" },
        create: { id: "default", name: "Renamed", minPasswordLength: 12 },
        update: { name: "Renamed", minPasswordLength: 12 },
      }),
    );
  });

  it.each([
    ["createConfigItem", "create"],
    ["updateConfigItem", "update"],
    ["deleteConfigItem", "delete"],
  ] as const)("%s writes through to the right table", async (action, _method) => {
    if (action === "createConfigItem") {
      db.taskStatusConfig.create.mockResolvedValue({});
      await createConfigItem("taskStatusConfig", { key: "BLOCKED" });
      expect(db.taskStatusConfig.create).toHaveBeenCalledWith({ data: { key: "BLOCKED" } });
    } else if (action === "updateConfigItem") {
      db.priorityConfig.update.mockResolvedValue({});
      await updateConfigItem("priorityConfig", "id-1", { label: "Urgent" });
      expect(db.priorityConfig.update).toHaveBeenCalledWith({ where: { id: "id-1" }, data: { label: "Urgent" } });
    } else {
      // P2 (edge-case audit) — deleteConfigItem now fetches the config row's
      // key + counts in-use references before deleting. Mock both so the
      // delete proceeds.
      db.departmentConfig.findUnique.mockResolvedValue({ key: "ENGINEERING" });
      db.teamMember.count.mockResolvedValue(0); // no members use it → delete OK
      db.departmentConfig.delete.mockResolvedValue({});
      await deleteConfigItem("departmentConfig", "id-1");
      expect(db.departmentConfig.delete).toHaveBeenCalledWith({ where: { id: "id-1" } });
    }
    expect(db.auditLog.create).toHaveBeenCalled();
  });
});

describe("role mutations", () => {
  it("updateRole updates metadata when permissions are not provided", async () => {
    db.role.findUnique.mockResolvedValue({ id: "r-1", label: "Member", key: "MEMBER" });
    db.role.update.mockResolvedValue({});
    await updateRole("r-1", { label: "Team Member" });
    expect(db.role.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ label: "Team Member" }) }),
    );
    expect(db.rolePermission.deleteMany).not.toHaveBeenCalled();
  });

  it("createRole creates the role and links permissions", async () => {
    db.role.findUnique.mockResolvedValue(null);
    db.role.create.mockResolvedValue({ id: "r-new", label: "Contractor" });
    db.role.count.mockResolvedValue(3);
    db.permission.findMany.mockResolvedValue([{ id: "p-1", key: "task:create" }]);
    db.rolePermission.create.mockResolvedValue({});

    await createRole({ key: "CONTRACTOR", label: "Contractor", permissions: ["task:create"] });
    expect(db.role.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ key: "CONTRACTOR", isSystem: false, sortOrder: 3 }),
      }),
    );
    expect(db.rolePermission.create).toHaveBeenCalledTimes(1);
  });

  it("deleteRole removes a non-system, unassigned role", async () => {
    db.role.findUnique.mockResolvedValue({ id: "r-2", label: "Contractor", key: "CONTRACTOR", isSystem: false });
    db.user.count.mockResolvedValue(0);
    db.role.delete.mockResolvedValue({});
    await deleteRole("r-2");
    expect(db.role.delete).toHaveBeenCalledWith({ where: { id: "r-2" } });
  });
});
