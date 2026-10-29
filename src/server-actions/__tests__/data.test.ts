import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — the Prisma client, next-auth session, and next/cache.
// These are installed BEFORE importing the module under test.
// ---------------------------------------------------------------------------

const { db, getServerSession } = vi.hoisted(() => {
  const getServerSession = vi.fn();

  // A generic auto-mock factory: db.<model>.<method> is a vi.fn().
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
  getDashboardData,
  getUserProfile,
  createEvent,
  toggleReminder,
  createReminder,
  createMember,
  updateTask,
  moveTask,
  markNotificationRead,
  markAllNotificationsRead,
  markMessageRead,
  markThreadRead,
  deleteMessage,
  logTime,
  sendMessage,
  createTask,
  createProject,
  deleteProject,
  createUser,
  updateUser,
  deleteUser,
  changePassword,
  updateProfile,
  updateUserSettings,
  getAllUsers,
  getAuditLogs,
  getAuditLogsForEntity,
  updateWorkspaceSettings,
  createConfigItem,
  updateConfigItem,
  deleteConfigItem,
  updateRole,
  createRole,
  deleteRole,
  AuthorizationError,
} from "@/server-actions/data";

// ---------------------------------------------------------------------------
// Test fixtures & helpers
// ---------------------------------------------------------------------------

interface FixtureUser {
  userId: string;
  name: string;
  email: string;
  role: "ADMIN" | "MANAGER" | "MEMBER";
}

const ADMIN: FixtureUser = { userId: "u-admin", name: "Ada Admin", email: "ada@fernly.dev", role: "ADMIN" };
const MANAGER: FixtureUser = { userId: "u-mgr", name: "Max Manager", email: "max@fernly.dev", role: "MANAGER" };
const MEMBER: FixtureUser = { userId: "u-mia", name: "Mia Member", email: "mia@fernly.dev", role: "MEMBER" };
const OTHER_MEMBER: FixtureUser = { userId: "u-oli", name: "Oli Other", email: "oli@fernly.dev", role: "MEMBER" };

function signIn(user: FixtureUser | null) {
  getServerSession.mockResolvedValue(
    user ? { user: { id: user.userId, name: user.name, email: user.email, role: user.role } } : null,
  );
}

/** Wire teamMember.findUnique to resolve the member profile for a user email. */
const MEMBER_PROFILE_IDS: Record<string, string> = {
  "ada@fernly.dev": "m-ada",
  "max@fernly.dev": "m-max",
  "mia@fernly.dev": "m-mia",
  "oli@fernly.dev": "m-oli",
};

function wireMemberLookup() {
  db.teamMember.findUnique.mockImplementation(({ where }: { where: { email?: string; id?: string } }) => {
    if (where?.email) {
      const id = MEMBER_PROFILE_IDS[where.email.toLowerCase()];
      return Promise.resolve(id ? { id, email: where.email } : null);
    }
    if (where?.id) {
      const email = Object.entries(MEMBER_PROFILE_IDS).find(([, id]) => id === where.id)?.[0];
      return Promise.resolve(email ? { id: where.id, email } : null);
    }
    return Promise.resolve(null);
  });
}

function iso(d: Date) {
  return d.toISOString();
}

const freshTask = (over: Partial<Record<string, unknown>> = {}) => ({
  id: "t-1",
  title: "Write tests",
  description: "",
  status: "TODO",
  priority: "MEDIUM",
  tag: "QA",
  dueDate: null,
  projectId: "p-1",
  assigneeId: "m-mia",
  order: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  signIn(null);
  wireMemberLookup();
  db.auditLog.create.mockResolvedValue({});
  db.task.aggregate.mockResolvedValue({ _max: { order: 0 } });
  // The workspace config loader reads every config table in parallel —
  // default them to empty arrays so getWorkspaceConfig() resolves.
  for (const table of [
    "taskStatusConfig", "projectStatusConfig", "eventTypeConfig",
    "taskTagConfig", "priorityConfig", "departmentConfig",
    "role", "permission", "rolePermission",
  ]) {
    db[table].findMany.mockResolvedValue([]);
  }
});

// ---------------------------------------------------------------------------
// getDashboardData — privilege escalation regression tests
// ---------------------------------------------------------------------------

describe("getDashboardData (P0-1 regression)", () => {
  it("returns the empty payload for anonymous callers", async () => {
    const data = await getDashboardData();
    expect(data.projects).toEqual([]);
    expect(data.tasks).toEqual([]);
    expect(data.stats.total).toBe(0);
    expect(db.project.findMany).not.toHaveBeenCalled();
  });

  it("scopes projects for a MEMBER from the SESSION (not caller arguments)", async () => {
    signIn(MEMBER);
    db.project.findMany.mockResolvedValue([]);
    db.task.findMany.mockResolvedValue([]);
    db.teamMember.findMany.mockResolvedValue([]);
    db.reminder.findMany.mockResolvedValue([]);
    db.notification.findMany.mockResolvedValue([]);
    db.timeEntry.findMany.mockResolvedValue([]);
    db.calendarEvent.findMany.mockResolvedValue([]);
    db.message.findMany.mockResolvedValue([]);
    db.projectAssignment.findMany.mockResolvedValue([]);

    const data = await getDashboardData();
    expect(data.scope?.isMember).toBe(true);

    // The MAIN project query (the last project.findMany call — earlier calls
    // are the scoping pre-queries) MUST carry a restrictive where clause.
    const projectCall = db.project.findMany.mock.calls.at(-1)![0];
    expect(projectCall.where).toBeDefined();
    expect(projectCall.where.id).toHaveProperty("in");

    // Same for tasks: scoped by project membership or direct assignment.
    const taskCall = db.task.findMany.mock.calls.at(-1)![0];
    expect(taskCall.where).toBeDefined();

    // Messages must be filtered to the signed-in user.
    const messageCall = db.message.findMany.mock.calls[0][0];
    expect(messageCall.where.OR).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ senderUserId: MEMBER.userId }),
        expect.objectContaining({ recipientUserId: MEMBER.userId }),
      ]),
    );
  });

  it("scopes a MEMBER via stable user ids, never via names (identity migration)", async () => {
    signIn(MEMBER);
    db.project.findMany.mockResolvedValue([]);
    db.task.findMany.mockResolvedValue([]);
    db.teamMember.findMany.mockResolvedValue([]);
    db.reminder.findMany.mockResolvedValue([]);
    db.notification.findMany.mockResolvedValue([]);
    db.timeEntry.findMany.mockResolvedValue([]);
    db.calendarEvent.findMany.mockResolvedValue([]);
    db.message.findMany.mockResolvedValue([]);
    db.projectAssignment.findMany.mockResolvedValue([]);

    await getDashboardData();

    // The ownership pre-query must match on the stable id. Two users sharing
    // a name must NOT see each other's projects (review §6.1).
    const ownedCall = db.project.findMany.mock.calls.find(
      ([args]) => args?.where?.ownerUserId !== undefined,
    );
    expect(ownedCall).toBeDefined();
    expect(ownedCall![0].where.ownerUserId).toBe(MEMBER.userId);

    // Task-assignment pre-query: assignee matched by userId, not name.
    const assignedCall = db.task.findMany.mock.calls.find(
      ([args]) => args?.where?.assignee !== undefined && args.where.assignee !== null,
    );
    expect(assignedCall).toBeDefined();
    expect(assignedCall![0].where.assignee).toEqual({ userId: MEMBER.userId });

    // No query anywhere may filter identity by the caller's name.
    const nameFilters = JSON.stringify(db.project.findMany.mock.calls)
      + JSON.stringify(db.task.findMany.mock.calls)
      + JSON.stringify(db.teamMember.findMany.mock.calls);
    expect(nameFilters).not.toContain(`"name":"${MEMBER.name}"`);
    expect(nameFilters).not.toContain(`ownerName`);
  });

  it("lets ADMIN see everything (no scoping where clause on projects)", async () => {
    signIn(ADMIN);
    db.project.findMany.mockResolvedValue([]);
    db.task.findMany.mockResolvedValue([]);
    db.teamMember.findMany.mockResolvedValue([]);
    db.reminder.findMany.mockResolvedValue([]);
    db.notification.findMany.mockResolvedValue([]);
    db.timeEntry.findMany.mockResolvedValue([]);
    db.calendarEvent.findMany.mockResolvedValue([]);
    db.message.findMany.mockResolvedValue([]);

    await getDashboardData();
    // Admin gets NO project scoping (where is undefined) but messages are
    // still filtered to their own mailbox.
    const projectCall = db.project.findMany.mock.calls.at(-1)![0];
    expect(projectCall.where).toBeUndefined();
    const messageCall = db.message.findMany.mock.calls.at(-1)![0];
    expect(messageCall.where).toEqual(
      expect.objectContaining({
        OR: expect.any(Array),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// updateTask / moveTask — IDOR regression tests
// ---------------------------------------------------------------------------

describe("updateTask ownership (P0-2 regression)", () => {
  it("allows a MEMBER to update a task assigned to them", async () => {
    signIn(MEMBER);
    db.task.findUnique.mockResolvedValue(freshTask({ assigneeId: "m-mia" }));
    db.task.update.mockResolvedValue(freshTask());
    db.teamMember.update.mockResolvedValue({});

    await expect(
      updateTask("t-1", { title: "Still mine" }),
    ).resolves.toBeUndefined();
    expect(db.task.update).toHaveBeenCalled();
  });

  it("rejects a MEMBER updating someone else's task", async () => {
    signIn(MEMBER);
    db.task.findUnique.mockResolvedValue(freshTask({ assigneeId: "m-oli" }));

    await expect(updateTask("t-1", { title: "Not mine" })).rejects.toThrow(
      /only edit tasks that are assigned to you/i,
    );
    expect(db.task.update).not.toHaveBeenCalled();
  });

  it("rejects a MEMBER updating an unassigned task", async () => {
    signIn(MEMBER);
    db.task.findUnique.mockResolvedValue(freshTask({ assigneeId: null }));

    await expect(updateTask("t-1", { title: "Nobody's" })).rejects.toThrow(AuthorizationError);
    expect(db.task.update).not.toHaveBeenCalled();
  });

  it("rejects a MEMBER with no team-member profile (deny by default)", async () => {
    signIn({ ...MEMBER, email: "stranger@fernly.dev" });
    db.task.findUnique.mockResolvedValue(freshTask({ assigneeId: "m-mia" }));

    await expect(updateTask("t-1", { title: "Nope" })).rejects.toThrow(AuthorizationError);
  });

  it("allows ADMIN (task:edit:any) to update any task", async () => {
    signIn(ADMIN);
    db.task.findUnique.mockResolvedValue(freshTask({ assigneeId: "m-oli" }));
    db.task.update.mockResolvedValue(freshTask());
    db.teamMember.update.mockResolvedValue({});

    await expect(updateTask("t-1", { title: "Admin override" })).resolves.toBeUndefined();
    expect(db.task.update).toHaveBeenCalled();
  });

  it("allows MANAGER (task:edit:any) to update any task", async () => {
    signIn(MANAGER);
    db.task.findUnique.mockResolvedValue(freshTask({ assigneeId: "m-oli" }));
    db.task.update.mockResolvedValue(freshTask());
    db.teamMember.update.mockResolvedValue({});

    await expect(updateTask("t-1", { title: "Manager override" })).resolves.toBeUndefined();
  });

  it("silently no-ops when the task does not exist", async () => {
    signIn(ADMIN);
    db.task.findUnique.mockResolvedValue(null);
    await expect(updateTask("missing", { title: "x" })).resolves.toBeUndefined();
    expect(db.task.update).not.toHaveBeenCalled();
  });
});

describe("moveTask ownership (P0-2 regression)", () => {
  it("rejects a MEMBER moving someone else's task", async () => {
    signIn(MEMBER);
    db.task.findUnique.mockResolvedValue(freshTask({ assigneeId: "m-oli" }));

    await expect(moveTask("t-1", "DONE", 0)).rejects.toThrow(AuthorizationError);
    expect(db.task.update).not.toHaveBeenCalled();
  });

  it("allows a MEMBER to move their own task", async () => {
    signIn(MEMBER);
    db.task.findUnique.mockResolvedValue(freshTask({ assigneeId: "m-mia" }));
    db.task.update.mockResolvedValue(freshTask());
    db.teamMember.update.mockResolvedValue({});

    await expect(moveTask("t-1", "DONE", 0)).resolves.toBeUndefined();
    expect(db.task.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "DONE" }) }),
    );
  });
});

// ---------------------------------------------------------------------------
// Unauthenticated mutation regression tests (P0-3)
// ---------------------------------------------------------------------------

describe("notification & message mutations require auth (P0-3 regression)", () => {
  it("markNotificationRead rejects anonymous callers", async () => {
    await expect(markNotificationRead("n-1", true)).rejects.toThrow(AuthorizationError);
    expect(db.notification.update).not.toHaveBeenCalled();
  });

  it("markAllNotificationsRead rejects anonymous callers", async () => {
    await expect(markAllNotificationsRead()).rejects.toThrow(AuthorizationError);
    expect(db.notification.updateMany).not.toHaveBeenCalled();
  });

  it("markMessageRead rejects anonymous callers", async () => {
    await expect(markMessageRead("m-1")).rejects.toThrow(AuthorizationError);
  });

  it("markMessageRead only updates messages addressed to the caller", async () => {
    signIn(MEMBER);
    db.message.updateMany.mockResolvedValue({ count: 1 });
    await markMessageRead("m-1");
    expect(db.message.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "m-1", recipientUserId: MEMBER.userId }),
      }),
    );
  });

  it("markThreadRead only marks the caller's incoming messages as read", async () => {
    signIn(MEMBER);
    db.message.updateMany.mockResolvedValue({ count: 2 });
    await markThreadRead("th-1");
    expect(db.message.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          threadId: "th-1",
          direction: "IN",
          recipientUserId: MEMBER.userId,
        }),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// getUserProfile IDOR regression (P0-4)
// ---------------------------------------------------------------------------

describe("getUserProfile (P0-4 regression)", () => {
  const profile = (id: string) => ({
    id,
    email: `${id}@fernly.dev`,
    name: id,
    role: "MEMBER",
    timezone: "UTC",
    bio: "",
    avatarColor: "forest",
    settings: null,
  });

  it("rejects anonymous callers", async () => {
    await expect(getUserProfile("u-mia")).rejects.toThrow(AuthorizationError);
    expect(db.user.findUnique).not.toHaveBeenCalled();
  });

  it("lets a user read their own profile", async () => {
    signIn(MEMBER);
    db.user.findUnique.mockResolvedValue(profile("u-mia"));
    await expect(getUserProfile("u-mia")).resolves.toMatchObject({ id: "u-mia" });
  });

  it("rejects a MEMBER reading someone else's profile", async () => {
    signIn(MEMBER);
    await expect(getUserProfile("u-oli")).rejects.toThrow(/own profile/i);
    expect(db.user.findUnique).not.toHaveBeenCalled();
  });

  it("lets ADMIN read any profile (user management needs it)", async () => {
    signIn(ADMIN);
    db.user.findUnique.mockResolvedValue(profile("u-oli"));
    await expect(getUserProfile("u-oli")).resolves.toMatchObject({ id: "u-oli" });
  });
});

// ---------------------------------------------------------------------------
// deleteMessage ownership (P1-9)
// ---------------------------------------------------------------------------

describe("deleteMessage ownership (P1-9)", () => {
  it("lets the sender delete their message", async () => {
    signIn(MEMBER);
    db.message.findUnique.mockResolvedValue({
      id: "m-1", senderUserId: MEMBER.userId, recipientUserId: "u-oli", subject: "hi",
    });
    db.message.delete.mockResolvedValue({});
    await expect(deleteMessage("m-1")).resolves.toBeUndefined();
    expect(db.message.delete).toHaveBeenCalled();
  });

  it("lets the recipient delete a message they received", async () => {
    signIn(MEMBER);
    db.message.findUnique.mockResolvedValue({
      id: "m-1", senderUserId: "u-oli", recipientUserId: MEMBER.userId, subject: "hi",
    });
    db.message.delete.mockResolvedValue({});
    await expect(deleteMessage("m-1")).resolves.toBeUndefined();
  });

  it("rejects deleting a message you neither sent nor received", async () => {
    signIn(MEMBER);
    db.message.findUnique.mockResolvedValue({
      id: "m-1", senderUserId: "u-oli", recipientUserId: "u-admin", subject: "hi",
    });
    await expect(deleteMessage("m-1")).rejects.toThrow(/sent or received/i);
    expect(db.message.delete).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// logTime attribution (P1-10)
// ---------------------------------------------------------------------------

describe("logTime (P1-10)", () => {
  it("rejects anonymous callers", async () => {
    await expect(
      logTime({ projectId: "p-1", date: iso(new Date()), hours: 2 }),
    ).rejects.toThrow(AuthorizationError);
  });

  it("derives the member id from the session, never the input", async () => {
    signIn(MEMBER);
    db.timeEntry.create.mockResolvedValue({ id: "te-1" });
    db.project.findUnique.mockResolvedValue({ id: "p-1", name: "Apollo" });

    await logTime({
      projectId: "p-1",
      memberId: "m-oli", // spoofing attempt — must be ignored
      date: iso(new Date()),
      hours: 3,
    });

    expect(db.timeEntry.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ memberId: "m-mia" }),
      }),
    );
  });

  it("rejects users without a team member profile", async () => {
    signIn({ ...MEMBER, email: "stranger@fernly.dev" });
    await expect(
      logTime({ projectId: "p-1", date: iso(new Date()), hours: 2 }),
    ).rejects.toThrow(/team member profile/i);
  });

  it.each([0, -1, 25, NaN])("rejects invalid hours: %s", async (hours) => {
    signIn(MEMBER);
    await expect(
      logTime({ projectId: "p-1", date: iso(new Date()), hours }),
    ).rejects.toThrow(/between 0 and 24/i);
  });
});

// ---------------------------------------------------------------------------
// Permission gating across the remaining actions
// ---------------------------------------------------------------------------

describe("permission gating", () => {
  it("createTask requires task:create (MEMBER has it)", async () => {
    signIn(MEMBER);
    db.task.create.mockResolvedValue(freshTask({ project: null }));
    db.teamMember.update.mockResolvedValue({});
    await expect(createTask({ title: "New" })).resolves.toBeUndefined();
  });

  it("createProject is denied for MEMBER", async () => {
    signIn(MEMBER);
    await expect(createProject({ name: "Nope" })).rejects.toThrow(AuthorizationError);
    expect(db.project.create).not.toHaveBeenCalled();
  });

  it("createProject is allowed for MANAGER", async () => {
    signIn(MANAGER);
    db.project.create.mockResolvedValue({ id: "p-2", name: "Yes" });
    await expect(createProject({ name: "Yes" })).resolves.toBeUndefined();
  });

  it("deleteProject is denied for MANAGER", async () => {
    signIn(MANAGER);
    db.project.findUnique.mockResolvedValue({ id: "p-1" });
    await expect(deleteProject("p-1")).rejects.toThrow(AuthorizationError);
    expect(db.project.delete).not.toHaveBeenCalled();
  });

  it("deleteProject is allowed for ADMIN", async () => {
    signIn(ADMIN);
    db.project.findUnique.mockResolvedValue({ id: "p-1", name: "Bye" });
    db.project.delete.mockResolvedValue({});
    await expect(deleteProject("p-1")).resolves.toBeUndefined();
  });

  it("sendMessage stamps the sender from the session", async () => {
    signIn(MEMBER);
    db.message.create.mockResolvedValue({});
    await sendMessage({
      direction: "OUT",
      senderName: "Imposter",
      recipientName: "Oli",
      subject: "s",
      body: "b",
      senderUserId: "u-hacker", // not part of the input type, but the action
      // must use the session value regardless of any client payload
    } as never);
    expect(db.message.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ senderUserId: MEMBER.userId }),
      }),
    );
  });

  it("getAuditLogs requires audit:view (denied for MEMBER)", async () => {
    signIn(MEMBER);
    await expect(getAuditLogs()).rejects.toThrow(AuthorizationError);
  });

  it("getAuditLogs is allowed for ADMIN", async () => {
    signIn(ADMIN);
    db.auditLog.findMany.mockResolvedValue([]);
    await expect(getAuditLogs()).resolves.toEqual([]);
  });

  it("getAllUsers requires role:manage", async () => {
    signIn(MEMBER);
    await expect(getAllUsers()).rejects.toThrow(AuthorizationError);
    signIn(MANAGER);
    await expect(getAllUsers()).rejects.toThrow(AuthorizationError);
    signIn(ADMIN);
    db.user.findMany.mockResolvedValue([]);
    await expect(getAllUsers()).resolves.toEqual([]);
  });

  it("getAuditLogsForEntity requires a session", async () => {
    await expect(getAuditLogsForEntity("TASK", "t-1")).rejects.toThrow(AuthorizationError);
    signIn(MEMBER);
    db.auditLog.findMany.mockResolvedValue([]);
    await expect(getAuditLogsForEntity("TASK", "t-1")).resolves.toEqual([]);
  });

  it("updateWorkspaceSettings requires role:manage", async () => {
    signIn(MANAGER);
    await expect(updateWorkspaceSettings({ name: "X" })).rejects.toThrow(AuthorizationError);
    signIn(ADMIN);
    db.workspace.upsert.mockResolvedValue({});
    await expect(updateWorkspaceSettings({ name: "X" })).resolves.toBeUndefined();
  });

  it("config item mutations require role:manage", async () => {
    signIn(MEMBER);
    await expect(
      createConfigItem("taskStatusConfig", { key: "X" }),
    ).rejects.toThrow(AuthorizationError);
    await expect(
      updateConfigItem("taskStatusConfig", "id", { label: "x" }),
    ).rejects.toThrow(AuthorizationError);
    await expect(
      deleteConfigItem("taskStatusConfig", "id"),
    ).rejects.toThrow(AuthorizationError);
  });
});

// ---------------------------------------------------------------------------
// User management validation
// ---------------------------------------------------------------------------

describe("createUser validation", () => {
  it("rejects anonymous callers", async () => {
    await expect(
      createUser({ name: "A", email: "a@b.co", password: "longenough1", role: "MEMBER" }),
    ).rejects.toThrow(AuthorizationError);
  });

  it("rejects invalid emails", async () => {
    signIn(ADMIN);
    await expect(
      createUser({ name: "A", email: "not-an-email", password: "longenough1", role: "MEMBER" }),
    ).rejects.toThrow(/valid email/i);
  });

  it("rejects short passwords", async () => {
    signIn(ADMIN);
    await expect(
      createUser({ name: "A", email: "a@b.co", password: "short", role: "MEMBER" }),
    ).rejects.toThrow(/at least 8 characters/i);
  });

  it("rejects unknown roles", async () => {
    signIn(ADMIN);
    await expect(
      createUser({ name: "A", email: "a@b.co", password: "longenough1", role: "SUPERUSER" }),
    ).rejects.toThrow(/ADMIN, MANAGER, or MEMBER/i);
  });

  it("rejects duplicate emails", async () => {
    signIn(ADMIN);
    db.user.findUnique.mockResolvedValue({ id: "existing" });
    await expect(
      createUser({ name: "A", email: "a@b.co", password: "longenough1", role: "MEMBER" }),
    ).rejects.toThrow(/already exists/i);
  });

  it("hashes the password and creates user + team member", async () => {
    signIn(ADMIN);
    db.user.findUnique.mockResolvedValue(null); // no dup
    db.user.create.mockResolvedValue({ id: "u-new" });
    db.teamMember.findUnique.mockResolvedValue(null);
    db.teamMember.create.mockResolvedValue({ id: "m-new" });

    const result = await createUser({
      name: "Newbie",
      email: "new@fernly.dev",
      password: "longenough1",
      role: "MEMBER",
    });

    expect(result).toEqual({ id: "u-new" });
    const createArgs = db.user.create.mock.calls[0][0];
    expect(createArgs.data.email).toBe("new@fernly.dev");
    expect(createArgs.data.passwordHash).not.toBe("longenough1");
    expect(createArgs.data.passwordHash).toMatch(/^\$2[aby]\$/);
    expect(db.teamMember.create).toHaveBeenCalled();
  });
});

describe("updateUser guards", () => {
  it("prevents an admin from demoting themselves", async () => {
    signIn(ADMIN);
    db.user.findUnique.mockResolvedValue({ id: ADMIN.userId, role: "ADMIN", email: ADMIN.email, name: "Ada" });
    await expect(
      updateUser(ADMIN.userId, { role: "MEMBER" }),
    ).rejects.toThrow(/own role/i);
  });

  it("allows an admin to change someone else's role", async () => {
    signIn(ADMIN);
    db.user.findUnique.mockResolvedValue({ id: "u-oli", role: "MEMBER", email: "o@x.co", name: "Oli" });
    db.user.update.mockResolvedValue({});
    db.teamMember.updateMany.mockResolvedValue({});
    await expect(updateUser("u-oli", { role: "MANAGER" })).resolves.toBeUndefined();
  });

  it("rejects invalid role values", async () => {
    signIn(ADMIN);
    db.user.findUnique.mockResolvedValue({ id: "u-oli", role: "MEMBER", email: "o@x.co", name: "Oli" });
    await expect(updateUser("u-oli", { role: "GOD" })).rejects.toThrow(/invalid role/i);
  });
});

describe("deleteUser guards", () => {
  it("prevents deleting your own account", async () => {
    signIn(ADMIN);
    await expect(deleteUser(ADMIN.userId)).rejects.toThrow(/own account/i);
    expect(db.user.delete).not.toHaveBeenCalled();
  });

  it("requires role:manage", async () => {
    signIn(MEMBER);
    await expect(deleteUser("u-oli")).rejects.toThrow(AuthorizationError);
  });
});

// ---------------------------------------------------------------------------
// Self-service flows
// ---------------------------------------------------------------------------

describe("changePassword", () => {
  it("rejects changing someone else's password", async () => {
    signIn(MEMBER);
    await expect(
      changePassword({ userId: "u-oli", currentPassword: "a", newPassword: "b" }),
    ).rejects.toThrow(/own password/i);
  });

  it("rejects a wrong current password", async () => {
    signIn(MEMBER);
    db.user.findUnique.mockResolvedValue({
      id: MEMBER.userId,
      email: MEMBER.email,
      name: MEMBER.name,
      passwordHash: "$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidiu",
    });
    await expect(
      changePassword({ userId: MEMBER.userId, currentPassword: "wrong", newPassword: "brandnew1" }),
    ).rejects.toThrow(/incorrect/i);
  });

  it("rejects new passwords shorter than 8 chars", async () => {
    signIn(MEMBER);
    await expect(
      changePassword({ userId: MEMBER.userId, currentPassword: "old", newPassword: "short" }),
    ).rejects.toThrow(/at least 8 characters/i);
  });

  it("rejects reusing the current password", async () => {
    signIn(MEMBER);
    await expect(
      changePassword({ userId: MEMBER.userId, currentPassword: "samepass", newPassword: "samepass" }),
    ).rejects.toThrow(/different/i);
  });
});

describe("self-profile & settings", () => {
  it("updateProfile rejects editing someone else's profile", async () => {
    signIn(MEMBER);
    await expect(
      updateProfile("u-oli", { name: "x", role: "Dev", timezone: "UTC", bio: "", avatarColor: "forest" }),
    ).rejects.toThrow(/own profile/i);
  });

  it("updateUserSettings rejects editing someone else's settings", async () => {
    signIn(MEMBER);
    await expect(updateUserSettings("u-oli", { dark: true })).rejects.toThrow(/own settings/i);
  });

  it("updateUserSettings persists your own settings", async () => {
    signIn(MEMBER);
    db.userSettings.upsert.mockResolvedValue({});
    await expect(updateUserSettings(MEMBER.userId, { dark: true })).resolves.toBeUndefined();
    expect(db.userSettings.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: MEMBER.userId } }),
    );
  });
});

// ---------------------------------------------------------------------------
// Role management
// ---------------------------------------------------------------------------

describe("role management", () => {
  it("updateRole replaces the permission set", async () => {
    signIn(ADMIN);
    db.role.findUnique.mockResolvedValue({ id: "r-1", label: "Member", key: "MEMBER" });
    db.role.update.mockResolvedValue({});
    db.rolePermission.deleteMany.mockResolvedValue({});
    db.permission.findMany.mockResolvedValue([
      { id: "p-1", key: "task:create" },
      { id: "p-2", key: "task:edit:own" },
    ]);
    db.rolePermission.create.mockResolvedValue({});

    await updateRole("r-1", { permissions: ["task:create", "task:edit:own"] });
    expect(db.rolePermission.deleteMany).toHaveBeenCalledWith({ where: { roleId: "r-1" } });
    // Permissions are replaced atomically via createMany inside a transaction.
    expect(db.rolePermission.createMany).toHaveBeenCalledTimes(1);
    expect(db.rolePermission.createMany).toHaveBeenCalledWith({
      data: [
        { roleId: "r-1", permissionId: "p-1" },
        { roleId: "r-1", permissionId: "p-2" },
      ],
    });
  });

  it("deleteRole refuses to remove system roles", async () => {
    signIn(ADMIN);
    db.role.findUnique.mockResolvedValue({ id: "r-1", label: "Admin", key: "ADMIN", isSystem: true });
    await expect(deleteRole("r-1")).rejects.toThrow(/system role/i);
    expect(db.role.delete).not.toHaveBeenCalled();
  });

  it("deleteRole refuses when users still hold the role", async () => {
    signIn(ADMIN);
    db.role.findUnique.mockResolvedValue({ id: "r-2", label: "Contractor", key: "CONTRACTOR", isSystem: false });
    db.user.count.mockResolvedValue(3);
    await expect(deleteRole("r-2")).rejects.toThrow(/3 user\(s\)/i);
    expect(db.role.delete).not.toHaveBeenCalled();
  });

  it("createRole rejects duplicate keys", async () => {
    signIn(ADMIN);
    db.role.findUnique.mockResolvedValue({ id: "r-1" });
    await expect(createRole({ key: "MEMBER", label: "Dupe" })).rejects.toThrow(/already exists/i);
  });
});

// ---------------------------------------------------------------------------
// Zod validation layer (P2-22) + password policy (P2-19) + reminder ownership
// ---------------------------------------------------------------------------

describe("input validation (zod)", () => {
  it("rejects empty task titles server-side", async () => {
    signIn(MEMBER);
    await expect(createTask({ title: "   " })).rejects.toThrow(/title/i);
    expect(db.task.create).not.toHaveBeenCalled();
  });

  it("rejects absurdly long task titles", async () => {
    signIn(MEMBER);
    await expect(createTask({ title: "x".repeat(500) })).rejects.toThrow();
  });

  it("rejects an invalid member email", async () => {
    signIn(ADMIN);
    await expect(
      createMember({ name: "N", role: "Dev", department: "DESIGN", email: "not-an-email" }),
    ).rejects.toThrow(/valid email/i);
    expect(db.teamMember.create).not.toHaveBeenCalled();
  });

  it("rejects invalid event durations", async () => {
    signIn(ADMIN);
    await expect(
      createEvent({ title: "X", date: new Date().toISOString(), durationMin: 9999 }),
    ).rejects.toThrow();
  });

  it("rejects empty message bodies", async () => {
    signIn(MEMBER);
    await expect(
      sendMessage({ direction: "OUT", senderName: "Mia", recipientName: "Oli", subject: "s", body: "" }),
    ).rejects.toThrow(/body/i);
  });

  it("normalises member emails to lowercase", async () => {
    signIn(ADMIN);
    db.teamMember.create.mockResolvedValue({ id: "m-9" });
    await createMember({ name: "Nina", role: "Dev", department: "DESIGN", email: "  NINA@Fernly.DEV " });
    expect(db.teamMember.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ email: "nina@fernly.dev" }) }),
    );
  });
});

describe("workspace-configured password policy (P2-19)", () => {
  it("enforces the workspace minPasswordLength when creating users", async () => {
    signIn(ADMIN);
    // The config loader caches for 60s — invalidate so the mock row is read.
    const { bumpConfigCache } = await import("@/lib/config-loader");
    bumpConfigCache();
    db.user.findUnique.mockResolvedValue(null); // no duplicate
    // getWorkspaceConfig reads db.workspace.findFirst — configure 12.
    db.workspace.findFirst.mockResolvedValue({
      name: "X", defaultTimezone: "UTC", defaultUserRole: "MEMBER",
      defaultDepartment: "ENGINEERING", defaultAvatarColor: "forest",
      defaultJobTitle: "T", minPasswordLength: 12, workloadFullCapacity: 6,
      auditLogLimit: 300, entityHistoryLimit: 50, dashboardNotifLimit: 20,
    });

    await expect(
      createUser({ name: "A", email: "a@b.co", password: "short9chars", role: "MEMBER" }),
    ).rejects.toThrow(/at least 12 characters/i);
    expect(db.user.create).not.toHaveBeenCalled();
  });
});

describe("reminder ownership (P2-17)", () => {
  it("lets the owner toggle their personal reminder", async () => {
    signIn(MEMBER);
    db.reminder.findUnique.mockResolvedValue({ id: "r-1", title: "Mine", completed: false, ownerId: MEMBER.userId });
    db.reminder.update.mockResolvedValue({});
    await expect(toggleReminder("r-1", true)).resolves.toBeUndefined();
  });

  it("blocks another member from toggling a personal reminder", async () => {
    signIn(OTHER_MEMBER);
    db.reminder.findUnique.mockResolvedValue({ id: "r-1", title: "Mine", completed: false, ownerId: MEMBER.userId });
    await expect(toggleReminder("r-1", true)).rejects.toThrow(/own reminders/i);
    expect(db.reminder.update).not.toHaveBeenCalled();
  });

  it("lets ADMIN toggle anyone's reminder", async () => {
    signIn(ADMIN);
    db.reminder.findUnique.mockResolvedValue({ id: "r-1", title: "Mine", completed: false, ownerId: MEMBER.userId });
    db.reminder.update.mockResolvedValue({});
    await expect(toggleReminder("r-1", true)).resolves.toBeUndefined();
  });

  it("anyone signed in can toggle workspace-wide reminders (ownerId null)", async () => {
    signIn(MEMBER);
    db.reminder.findUnique.mockResolvedValue({ id: "r-1", title: "Shared", completed: false, ownerId: null });
    db.reminder.update.mockResolvedValue({});
    await expect(toggleReminder("r-1", true)).resolves.toBeUndefined();
  });

  it("createReminder stamps the signed-in user as owner", async () => {
    signIn(MEMBER);
    db.reminder.create.mockResolvedValue({ id: "r-2" });
    await createReminder({ title: "Personal", dueDate: new Date().toISOString() });
    expect(db.reminder.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ ownerId: MEMBER.userId, title: "Personal" }),
      }),
    );
  });

  it("getDashboardData scopes reminders to own + workspace-wide", async () => {
    signIn(MEMBER);
    const empty: unknown[] = [];
    db.project.findMany.mockResolvedValue(empty);
    db.task.findMany.mockResolvedValue(empty);
    db.teamMember.findMany.mockResolvedValue(empty);
    db.reminder.findMany.mockResolvedValue(empty);
    db.notification.findMany.mockResolvedValue(empty);
    db.timeEntry.findMany.mockResolvedValue(empty);
    db.calendarEvent.findMany.mockResolvedValue(empty);
    db.message.findMany.mockResolvedValue(empty);
    db.projectAssignment.findMany.mockResolvedValue(empty);

    await getDashboardData();
    const reminderCall = db.reminder.findMany.mock.calls[0][0];
    expect(reminderCall.where.OR).toEqual(
      expect.arrayContaining([
        { ownerId: MEMBER.userId },
        { ownerId: null },
      ]),
    );
  });
});
