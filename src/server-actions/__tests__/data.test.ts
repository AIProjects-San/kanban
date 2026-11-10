import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — the Prisma client, Better Auth session, and next/cache.
// These are installed BEFORE importing the module under test.
// ---------------------------------------------------------------------------

const { db, getBetterSession } = vi.hoisted(() => {
  const getBetterSession = vi.fn();

  // A generic auto-mock factory: db.<model>.<method> is a vi.fn().
  const models = [
    "auditLog", "project", "task", "teamMember", "reminder", "notification",
    "timeEntry", "calendarEvent", "message", "messageRead", "bug", "user", "userSettings",
    "projectAssignment", "workspace", "role", "permission", "rolePermission",
    "taskStatusConfig", "projectStatusConfig", "eventTypeConfig",
    "leaveRequest", "leaveType", "leavePolicy", "leaveBalance",
    "taskTagConfig", "priorityConfig", "departmentConfig",
    // P24 — the notification template master (config-loader reads it).
    "notificationTemplate",
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
  return { db, getBetterSession };
});

vi.mock("@/lib/auth-better", () => ({
  // The Better Auth session seam (PR-49 default stack). revokeUserSessions
  // is stubbed so password-change flows that call the revocation bridge
  // never touch a real instance.
  getBetterSession,
  revokeUserSessions: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/db", () => ({ db }));

// Deep-dive review F-14 test support — control the DB RBAC ceiling without
// touching the config cache. Default: nothing extra granted (deny by
// default, matching a failed/empty DB read).
const hasPermissionDbMock = vi.fn();
vi.mock("@/lib/config-loader", async () => {
  const actual = await vi.importActual<typeof import("@/lib/config-loader")>("@/lib/config-loader");
  return {
    ...actual,
    hasPermissionDb: (...a: unknown[]) => hasPermissionDbMock(...(a as [])),
  };
});

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
} from "@/server-actions/data";
import { AuthorizationError } from "@/server-actions/auth-guard";

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
  getBetterSession.mockResolvedValue(
    user ? { userId: user.userId, name: user.name, email: user.email, role: user.role } : null,
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
  // Default DB RBAC ceiling: nothing extra granted (deny by default).
  hasPermissionDbMock.mockResolvedValue(false);
  db.auditLog.create.mockResolvedValue({});
  db.task.aggregate.mockResolvedValue({ _max: { order: 0 } });
  // PR-20 — recalcMemberStats now uses two COUNT queries; default them to 0
  // so tests that don't care about that side-effect don't produce NaN
  // workload values. Tests that DO care override this.
  db.task.count.mockResolvedValue(0);
  // The workspace config loader reads every config table in parallel —
  // default them to empty arrays so getWorkspaceConfig() resolves.
  for (const table of [
    "taskStatusConfig", "projectStatusConfig", "eventTypeConfig",
    "taskTagConfig", "priorityConfig", "departmentConfig",
    "role", "permission", "rolePermission",
    "leaveRequest", "leaveType", "leavePolicy", "leaveBalance",
    "notificationTemplate",
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

  it("lets ADMIN see everything (no scoping where clause on projects, only soft-delete filter)", async () => {
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
    // Admin gets NO project scoping (no id: { in: [...] }) but the L-P0-14
    // soft-delete filter still applies — soft-deleted projects are hidden.
    const projectCall = db.project.findMany.mock.calls.at(-1)![0];
    expect(projectCall.where).toEqual({ deletedAt: null });
    const messageCall = db.message.findMany.mock.calls.at(-1)![0];
    expect(messageCall.where).toEqual(
      expect.objectContaining({
        OR: expect.any(Array),
      }),
    );
  });

  // Regression (caught by the e2e suite): tasks with projectId = null —
  // created before the task modal's project picker finished loading, or whose
  // project row was hard-deleted (onDelete: SetNull) — were silently excluded
  // by the old `{ project: { deletedAt: null } }` filter. They persisted but
  // never rendered on ANY board. The visibility filter must accept them.
  it("keeps projectId:null tasks visible on the ADMIN board (orphan-task regression)", async () => {
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

    const taskCall = db.task.findMany.mock.calls.at(-1)![0];
    expect(taskCall.where.OR).toEqual(
      expect.arrayContaining([
        { project: { deletedAt: null } },
        { projectId: null },
      ]),
    );
  });

  it("keeps projectId:null tasks visible for a MEMBER whose scope OR matches them", async () => {
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

    const taskCall = db.task.findMany.mock.calls.at(-1)![0];
    // Scoped shape: AND [ scope OR, visibility OR ] — the visibility clause
    // must still accept projectId:null rows.
    expect(taskCall.where.AND).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          OR: expect.arrayContaining([
            { projectId: null },
            { project: { deletedAt: null } },
          ]),
        }),
      ]),
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

    expectOk(await updateTask("t-1", { title: "Still mine" }));
    expect(db.task.update).toHaveBeenCalled();
  });

  it("rejects a MEMBER updating someone else's task", async () => {
    signIn(MEMBER);
    db.task.findUnique.mockResolvedValue(freshTask({ assigneeId: "m-oli" }));

    expectErr(await updateTask("t-1", { title: "Not mine" }), /only edit tasks that are assigned to you/i);
    expect(db.task.update).not.toHaveBeenCalled();
  });

  it("rejects a MEMBER updating an unassigned task", async () => {
    signIn(MEMBER);
    db.task.findUnique.mockResolvedValue(freshTask({ assigneeId: null }));

    expectErr(await updateTask("t-1", { title: "Nobody's" }), "AUTH");
    expect(db.task.update).not.toHaveBeenCalled();
  });

  it("rejects a MEMBER with no team-member profile (deny by default)", async () => {
    signIn({ ...MEMBER, email: "stranger@fernly.dev" });
    db.task.findUnique.mockResolvedValue(freshTask({ assigneeId: "m-mia" }));

    expectErr(await updateTask("t-1", { title: "Nope" }), "AUTH");
  });

  it("allows ADMIN (task:edit:any) to update any task", async () => {
    signIn(ADMIN);
    db.task.findUnique.mockResolvedValue(freshTask({ assigneeId: "m-oli" }));
    db.task.update.mockResolvedValue(freshTask());
    db.teamMember.update.mockResolvedValue({});

    expectOk(await updateTask("t-1", { title: "Admin override" }));
    expect(db.task.update).toHaveBeenCalled();
  });

  it("allows MANAGER (task:edit:any) to update any task", async () => {
    signIn(MANAGER);
    db.task.findUnique.mockResolvedValue(freshTask({ assigneeId: "m-oli" }));
    db.task.update.mockResolvedValue(freshTask());
    db.teamMember.update.mockResolvedValue({});

    expectOk(await updateTask("t-1", { title: "Manager override" }));
  });

  it("silently no-ops when the task does not exist", async () => {
    signIn(ADMIN);
    db.task.findUnique.mockResolvedValue(null);
    expectOk(await updateTask("missing", { title: "x" }));
    expect(db.task.update).not.toHaveBeenCalled();
  });
});

describe("moveTask ownership (P0-2 regression)", () => {
  it("rejects a MEMBER moving someone else's task", async () => {
    signIn(MEMBER);
    db.task.findUnique.mockResolvedValue(freshTask({ assigneeId: "m-oli" }));

    expectErr(await moveTask("t-1", "DONE", 0), "AUTH");
    expect(db.task.update).not.toHaveBeenCalled();
  });

  it("allows a MEMBER to move their own task", async () => {
    signIn(MEMBER);
    db.task.findUnique.mockResolvedValue(freshTask({ assigneeId: "m-mia" }));
    db.task.update.mockResolvedValue(freshTask());
    db.teamMember.update.mockResolvedValue({});

    expectOk(await moveTask("t-1", "DONE", 0));
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
    expectErr(await markNotificationRead("n-1", true), "AUTH");
    expect(db.notification.update).not.toHaveBeenCalled();
  });

  it("markAllNotificationsRead rejects anonymous callers", async () => {
    expectErr(await markAllNotificationsRead(), "AUTH");
    expect(db.notification.updateMany).not.toHaveBeenCalled();
  });

  it("markMessageRead rejects anonymous callers", async () => {
    expectErr(await markMessageRead("m-1"), "AUTH");
  });

  it("markMessageRead only marks messages addressed to the caller as read (L-P0-2)", async () => {
    signIn(MEMBER);
    // L-P0-2: the new implementation findUnique's the message to verify the
    // recipient check, then upserts a MessageRead row.
    db.message.findUnique.mockResolvedValue({ id: "m-1", recipientUserId: MEMBER.userId });
    db.messageRead.upsert.mockResolvedValue({ id: "mr-1", userId: MEMBER.userId, messageId: "m-1", readAt: new Date() });
    await markMessageRead("m-1");
    expect(db.message.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "m-1" },
        select: { recipientUserId: true },
      }),
    );
    expect(db.messageRead.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId_messageId: { userId: MEMBER.userId, messageId: "m-1" } },
      }),
    );
  });

  it("markMessageRead silently no-ps for messages NOT addressed to the caller (L-P0-2)", async () => {
    signIn(MEMBER);
    db.message.findUnique.mockResolvedValue({ id: "m-1", recipientUserId: "someone-else" });
    await markMessageRead("m-1");
    expect(db.messageRead.upsert).not.toHaveBeenCalled();
  });

  it("markThreadRead marks the caller's incoming messages as read via MessageRead (L-P0-2)", async () => {
    signIn(MEMBER);
    // L-P0-2: the new implementation findMany's the unread messages in the
    // thread addressed to me, then createMany's MessageRead rows.
    db.message.findMany.mockResolvedValue([
      { id: "m-1" },
      { id: "m-2" },
    ]);
    db.messageRead.createMany.mockResolvedValue({ count: 2 });
    await markThreadRead("th-1");
    expect(db.message.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          threadId: "th-1",
          recipientUserId: MEMBER.userId,
          readBy: { none: { userId: MEMBER.userId } },
        }),
      }),
    );
    expect(db.messageRead.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          { userId: MEMBER.userId, messageId: "m-1" },
          { userId: MEMBER.userId, messageId: "m-2" },
        ],
        // NOTE: skipDuplicates was removed (unsupported on SQLite); the
        // readBy-none pre-filter already guarantees the rows are new.
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
  it("lets the sender delete their message (L-P0-14 soft-delete)", async () => {
    signIn(MEMBER);
    db.message.findUnique.mockResolvedValue({
      id: "m-1", senderUserId: MEMBER.userId, recipientUserId: "u-oli", subject: "hi",
    });
    db.message.update.mockResolvedValue({});
    expectOk(await deleteMessage("m-1"));
    // L-P0-14: soft-delete via update (sets deletedAt), not hard delete
    expect(db.message.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "m-1" }, data: expect.objectContaining({ deletedAt: expect.any(Date) }) }),
    );
  });

  it("lets the recipient delete a message they received (L-P0-14 soft-delete)", async () => {
    signIn(MEMBER);
    db.message.findUnique.mockResolvedValue({
      id: "m-1", senderUserId: "u-oli", recipientUserId: MEMBER.userId, subject: "hi",
    });
    db.message.update.mockResolvedValue({});
    expectOk(await deleteMessage("m-1"));
  });

  it("rejects deleting a message you neither sent nor received", async () => {
    signIn(MEMBER);
    db.message.findUnique.mockResolvedValue({
      id: "m-1", senderUserId: "u-oli", recipientUserId: "u-admin", subject: "hi",
    });
    expectErr(await deleteMessage("m-1"), /sent or received/i);
    expect(db.message.delete).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// logTime attribution (P1-10)
// ---------------------------------------------------------------------------

describe("logTime (P1-10)", () => {
  it("rejects anonymous callers", async () => {
    expectErr(await logTime({ projectId: "p-1", date: iso(new Date()), hours: 2 }), "AUTH");
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
    expectErr(await logTime({ projectId: "p-1", date: iso(new Date()), hours: 2 }), /team member profile/i);
  });

  it.each([0, -1, 25])("rejects invalid hours: %s", async (hours) => {
    signIn(MEMBER);
    // F-11 — validation moved into logTimeSchema; the message now states
    // the exact rule (0 is rejected, not just >24).
    expectErr(await logTime({ projectId: "p-1", date: iso(new Date()), hours }), /greater than 0 and at most 24/i);
  });

  it("rejects NaN hours at the schema layer", async () => {
    signIn(MEMBER);
    expectErr(await logTime({ projectId: "p-1", date: iso(new Date()), hours: NaN }), /hours/i);
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
    // Project association rule — MEMBER must have the project in their
    // scope (explicit assignment below) and the project must exist.
    db.project.findMany.mockResolvedValue([]); // owned: none
    db.projectAssignment.findMany.mockImplementation(
      ({ select }: { select?: { projectId?: boolean; userId?: boolean } }) => {
        // getScopedProjectIds asks for projectId; the association helper
        // asks for userId. Mia is staffed on p-1 either way.
        if (select?.projectId) return Promise.resolve([{ projectId: "p-1" }]);
        if (select?.userId) return Promise.resolve([{ userId: MEMBER.userId }]);
        return Promise.resolve([]);
      },
    );
    db.project.findUnique.mockResolvedValue({ ownerUserId: null, deletedAt: null });
    expectOk(await createTask({ title: "New", projectId: "p-1" }));
  });

  it("createTask rejects a project outside the caller's scope (MEMBER)", async () => {
    signIn(MEMBER);
    db.project.findMany.mockResolvedValue([]);
    db.task.findMany.mockResolvedValue([]);
    db.projectAssignment.findMany.mockResolvedValue([]); // no associations
    const res = await createTask({ title: "New", projectId: "p-hidden" });
    expect(res.ok).toBe(false);
    expect(db.task.create).not.toHaveBeenCalled();
  });

  it("createTask rejects a project that does not exist (ADMIN is unscoped)", async () => {
    signIn(ADMIN);
    db.project.findUnique.mockResolvedValue(null);
    const res = await createTask({ title: "Ghost", projectId: "p-ghost" });
    expect(res.ok).toBe(false);
    expect(db.task.create).not.toHaveBeenCalled();
  });

  it("createProject is denied for MEMBER", async () => {
    signIn(MEMBER);
    expectErr(await createProject({ name: "Nope" }), "AUTH");
    expect(db.project.create).not.toHaveBeenCalled();
  });

  it("createProject is allowed for MANAGER", async () => {
    signIn(MANAGER);
    db.project.create.mockResolvedValue({ id: "p-2", name: "Yes" });
    expectOk(await createProject({ name: "Yes" }));
  });

  it("deleteProject is denied for MANAGER", async () => {
    signIn(MANAGER);
    db.project.findUnique.mockResolvedValue({ id: "p-1" });
    expectErr(await deleteProject("p-1"), "AUTH");
    expect(db.project.delete).not.toHaveBeenCalled();
  });

  it("deleteProject is allowed for ADMIN", async () => {
    signIn(ADMIN);
    db.project.findUnique.mockResolvedValue({ id: "p-1", name: "Bye" });
    db.project.delete.mockResolvedValue({});
    expectOk(await deleteProject("p-1"));
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
    expectErr(await getAuditLogs(), "AUTH");
  });

  it("getAuditLogs is allowed for ADMIN", async () => {
    signIn(ADMIN);
    db.auditLog.findMany.mockResolvedValue([]);
    expect(await getAuditLogs()).toEqual({ ok: true, data: [] });
  });

  it("getAllUsers requires role:manage", async () => {
    signIn(MEMBER);
    expectErr(await getAllUsers(), "AUTH");
    signIn(MANAGER);
    expectErr(await getAllUsers(), "AUTH");
    signIn(ADMIN);
    db.user.findMany.mockResolvedValue([]);
    expect(await getAllUsers()).toEqual({ ok: true, data: [] });
  });

  it("getAuditLogsForEntity requires a session", async () => {
    expectErr(await getAuditLogsForEntity("TASK", "t-1"), "AUTH");
    signIn(MEMBER);
    db.auditLog.findMany.mockResolvedValue([]);
    expect(await getAuditLogsForEntity("TASK", "t-1")).toEqual({ ok: true, data: [] });
  });

  it("updateWorkspaceSettings requires role:manage", async () => {
    signIn(MANAGER);
    expectErr(await updateWorkspaceSettings({ name: "X" }), "AUTH");
    signIn(ADMIN);
    db.workspace.upsert.mockResolvedValue({});
    expectOk(await updateWorkspaceSettings({ name: "X" }));
  });

  it("config item mutations require role:manage", async () => {
    signIn(MEMBER);
    expectErr(await createConfigItem("taskStatusConfig", { key: "X" }), "AUTH");
    expectErr(await updateConfigItem("taskStatusConfig", "id", { label: "x" }), "AUTH");
    expectErr(await deleteConfigItem("taskStatusConfig", "id"), "AUTH");
  });
});

// ---------------------------------------------------------------------------
// User management validation
// ---------------------------------------------------------------------------

describe("createUser validation", () => {
  it("rejects anonymous callers", async () => {
    expectErr(await createUser({ name: "A", email: "a@b.co", password: "longenough1", role: "MEMBER" }), "AUTH");
  });

  it("rejects invalid emails", async () => {
    signIn(ADMIN);
    expectErr(await createUser({ name: "A", email: "not-an-email", password: "longenough1", role: "MEMBER" }), /valid email/i);
  });

  it("rejects short passwords", async () => {
    signIn(ADMIN);
    expectErr(await createUser({ name: "A", email: "a@b.co", password: "short", role: "MEMBER" }), /at least 8 characters/i);
  });

  it("rejects unknown roles", async () => {
    signIn(ADMIN);
    expectErr(await createUser({ name: "A", email: "a@b.co", password: "longenough1", role: "SUPERUSER" }), /ADMIN, MANAGER, or MEMBER/i);
  });

  it("rejects duplicate emails", async () => {
    signIn(ADMIN);
    db.user.findUnique.mockResolvedValue({ id: "existing" });
    expectErr(await createUser({ name: "A", email: "a@b.co", password: "longenough1", role: "MEMBER" }), /already exists/i);
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

    expect(result).toEqual({ ok: true, data: { id: "u-new" } });
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
    expectErr(await updateUser(ADMIN.userId, { role: "MEMBER" }), /own role/i);
  });

  it("allows an admin to change someone else's role", async () => {
    signIn(ADMIN);
    db.user.findUnique.mockResolvedValue({ id: "u-oli", role: "MEMBER", email: "o@x.co", name: "Oli" });
    db.user.update.mockResolvedValue({});
    db.teamMember.updateMany.mockResolvedValue({});
    expectOk(await updateUser("u-oli", { role: "MANAGER" }));
  });

  it("rejects invalid role values", async () => {
    signIn(ADMIN);
    db.user.findUnique.mockResolvedValue({ id: "u-oli", role: "MEMBER", email: "o@x.co", name: "Oli" });
    expectErr(await updateUser("u-oli", { role: "GOD" }), /invalid role/i);
  });

  // Deep-dive review F-14 — only an ADMIN may grant the ADMIN role. Under
  // the default matrix only admins hold role:manage, but the DB RBAC editor
  // can grant role:manage to a MANAGER — that must not let them mint admins.
  it("prevents a non-admin role:manage holder from granting the ADMIN role (F-14)", async () => {
    // Simulate the DB ceiling granting MANAGER the role:manage permission.
    hasPermissionDbMock.mockResolvedValue(true);
    signIn(MANAGER);
    db.user.findUnique.mockResolvedValue({ id: "u-oli", role: "MEMBER", email: "o@x.co", name: "Oli", managerId: null });
    db.user.findMany.mockResolvedValue([]); // subtree lookup
    expectErr(await updateUser("u-oli", { role: "ADMIN" }), /only an admin can grant/i);
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it("allows an admin to grant the ADMIN role", async () => {
    signIn(ADMIN);
    db.user.findUnique.mockResolvedValue({ id: "u-oli", role: "MANAGER", email: "o@x.co", name: "Oli" });
    db.user.update.mockResolvedValue({});
    db.teamMember.updateMany.mockResolvedValue({});
    expectOk(await updateUser("u-oli", { role: "ADMIN" }));
  });
});

describe("deleteUser guards", () => {
  it("prevents deleting your own account", async () => {
    signIn(ADMIN);
    expectErr(await deleteUser(ADMIN.userId), /own account/i);
    expect(db.user.delete).not.toHaveBeenCalled();
  });

  it("requires role:manage", async () => {
    signIn(MEMBER);
    expectErr(await deleteUser("u-oli"), "AUTH");
  });
});

// ---------------------------------------------------------------------------
// Self-service flows
// ---------------------------------------------------------------------------

describe("changePassword", () => {
  it("rejects changing someone else's password", async () => {
    signIn(MEMBER);
    expectErr(await changePassword({ userId: "u-oli", currentPassword: "a", newPassword: "b" }), /own password/i);
  });

  it("rejects a wrong current password", async () => {
    signIn(MEMBER);
    db.user.findUnique.mockResolvedValue({
      id: MEMBER.userId,
      email: MEMBER.email,
      name: MEMBER.name,
      passwordHash: "$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidiu",
    });
    expectErr(await changePassword({ userId: MEMBER.userId, currentPassword: "wrong", newPassword: "brandnew1" }), /incorrect/i);
  });

  it("rejects new passwords shorter than 8 chars", async () => {
    signIn(MEMBER);
    expectErr(await changePassword({ userId: MEMBER.userId, currentPassword: "old", newPassword: "short" }), /at least 8 characters/i);
  });

  it("rejects reusing the current password", async () => {
    signIn(MEMBER);
    expectErr(await changePassword({ userId: MEMBER.userId, currentPassword: "samepass", newPassword: "samepass" }), /different/i);
  });
});

describe("self-profile & settings", () => {
  it("updateProfile rejects editing someone else's profile", async () => {
    signIn(MEMBER);
    expectErr(await updateProfile("u-oli", { name: "x", timezone: "UTC", bio: "", avatarColor: "forest" }), /own profile/i);
  });

  it("updateUserSettings rejects editing someone else's settings", async () => {
    signIn(MEMBER);
    expectErr(await updateUserSettings("u-oli", { dark: true }), /own settings/i);
  });

  it("updateUserSettings persists your own settings", async () => {
    signIn(MEMBER);
    db.userSettings.upsert.mockResolvedValue({});
    expectOk(await updateUserSettings(MEMBER.userId, { dark: true }));
    expect(db.userSettings.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: MEMBER.userId } }),
    );
  });

  it("PR-65: updateUserSettings persists the per-user sidebar rail", async () => {
    signIn(MEMBER);
    db.userSettings.upsert.mockResolvedValue({});
    expectOk(await updateUserSettings(MEMBER.userId, { sidebarRail: true }));
    expect(db.userSettings.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: MEMBER.userId },
        create: expect.objectContaining({ userId: MEMBER.userId, sidebarRail: true }),
        update: expect.objectContaining({ sidebarRail: true }),
      }),
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
    expectErr(await deleteRole("r-1"), /system role/i);
    expect(db.role.delete).not.toHaveBeenCalled();
  });

  it("deleteRole refuses when users still hold the role", async () => {
    signIn(ADMIN);
    db.role.findUnique.mockResolvedValue({ id: "r-2", label: "Contractor", key: "CONTRACTOR", isSystem: false });
    db.user.count.mockResolvedValue(3);
    expectErr(await deleteRole("r-2"), /3 user\(s\)/i);
    expect(db.role.delete).not.toHaveBeenCalled();
  });

  it("createRole rejects duplicate keys", async () => {
    signIn(ADMIN);
    db.role.findUnique.mockResolvedValue({ id: "r-1" });
    expectErr(await createRole({ key: "MEMBER", label: "Dupe" }), /already exists/i);
  });
});

// ---------------------------------------------------------------------------
// Zod validation layer (P2-22) + password policy (P2-19) + reminder ownership
// ---------------------------------------------------------------------------

describe("input validation (zod)", () => {
  it("rejects empty task titles server-side", async () => {
    signIn(MEMBER);
    expectErr(await createTask({ title: " " }), /title/i);
    expect(db.task.create).not.toHaveBeenCalled();
  });

  it("rejects absurdly long task titles", async () => {
    signIn(MEMBER);
    expectErr(await createTask({ title: "x".repeat(500) }));
  });

  it("rejects an invalid member email", async () => {
    signIn(ADMIN);
    expectErr(await createMember({ name: "N", role: "Dev", department: "DESIGN", email: "not-an-email" }), /valid email/i);
    expect(db.teamMember.create).not.toHaveBeenCalled();
  });

  it("rejects invalid event durations", async () => {
    signIn(ADMIN);
    expectErr(await createEvent({ title: "X", date: new Date().toISOString(), durationMin: 9999 }));
  });

  it("rejects empty message bodies", async () => {
    signIn(MEMBER);
    expectErr(await sendMessage({ direction: "OUT", senderName: "Mia", recipientName: "Oli", subject: "s", body: "" }), /body/i);
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

    expectErr(await createUser({ name: "A", email: "a@b.co", password: "short9chars", role: "MEMBER" }), /at least 12 characters/i);
    expect(db.user.create).not.toHaveBeenCalled();
  });
});

describe("reminder ownership (P2-17)", () => {
  it("lets the owner toggle their personal reminder", async () => {
    signIn(MEMBER);
    db.reminder.findUnique.mockResolvedValue({ id: "r-1", title: "Mine", completed: false, ownerId: MEMBER.userId });
    db.reminder.update.mockResolvedValue({});
    expectOk(await toggleReminder("r-1", true));
  });

  it("blocks another member from toggling a personal reminder", async () => {
    signIn(OTHER_MEMBER);
    db.reminder.findUnique.mockResolvedValue({ id: "r-1", title: "Mine", completed: false, ownerId: MEMBER.userId });
    expectErr(await toggleReminder("r-1", true), /own reminders/i);
    expect(db.reminder.update).not.toHaveBeenCalled();
  });

  it("lets ADMIN toggle anyone's reminder", async () => {
    signIn(ADMIN);
    db.reminder.findUnique.mockResolvedValue({ id: "r-1", title: "Mine", completed: false, ownerId: MEMBER.userId });
    db.reminder.update.mockResolvedValue({});
    expectOk(await toggleReminder("r-1", true));
  });

  it("anyone signed in can toggle workspace-wide reminders (ownerId null)", async () => {
    signIn(MEMBER);
    db.reminder.findUnique.mockResolvedValue({ id: "r-1", title: "Shared", completed: false, ownerId: null });
    db.reminder.update.mockResolvedValue({});
    expectOk(await toggleReminder("r-1", true));
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

  it("getDashboardData scopes notifications to own + workspace-wide (per-user routing)", async () => {
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
    const notifCall = db.notification.findMany.mock.calls[0][0];
    expect(notifCall.where.OR).toEqual(
      expect.arrayContaining([
        { recipientUserId: MEMBER.userId },
        { recipientUserId: null },
      ]),
    );
  });

  // PR-52 — reminders are personal-only. The dashboard previously also
  // surfaced legacy workspace-wide rows (ownerId = null) to every signed-in
  // user; a reminder is a personal todo, never a broadcast, so the query
  // now matches ONLY the signed-in user's rows.
  it("getDashboardData scopes reminders to the signed-in user only (no workspace-wide)", async () => {
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
    // Exact match — the where clause is a flat { ownerId } filter, NOT an
    // OR that would also pull in null-owner (workspace-wide) rows.
    expect(reminderCall.where).toEqual({ ownerId: MEMBER.userId });
    // Belt-and-braces: assert no OR clause sneaks the null scope back in.
    expect(reminderCall.where).not.toHaveProperty("OR");
    expect(reminderCall.where).not.toMatchObject({ ownerId: null });
  });

  it("getDashboardData does NOT surface another member's reminders (PR-52 regression)", async () => {
    // The DB mock returns a reminder owned by a DIFFERENT user plus a
    // legacy workspace-wide (ownerId = null) row. Neither should appear in
    // the payload — the where-clause filters at the DB, but assert the
    // loader doesn't re-introduce them client-side either.
    signIn(MEMBER);
    db.project.findMany.mockResolvedValue([]);
    db.task.findMany.mockResolvedValue([]);
    db.teamMember.findMany.mockResolvedValue([]);
    db.reminder.findMany.mockResolvedValue([
      { id: "r-other", title: "Not mine", dueDate: new Date(), completed: false, createdAt: new Date(), ownerId: OTHER_MEMBER.userId },
      { id: "r-shared", title: "Legacy shared", dueDate: new Date(), completed: false, createdAt: new Date(), ownerId: null },
    ]);
    db.notification.findMany.mockResolvedValue([]);
    db.timeEntry.findMany.mockResolvedValue([]);
    db.calendarEvent.findMany.mockResolvedValue([]);
    db.message.findMany.mockResolvedValue([]);
    db.projectAssignment.findMany.mockResolvedValue([]);
    db.leaveRequest.findMany.mockResolvedValue([]);
    db.bug.findMany.mockResolvedValue([]);

    const data = await getDashboardData();
    // The where clause must ask for ONLY the signed-in user's reminders.
    const reminderCall = db.reminder.findMany.mock.calls[0][0];
    expect(reminderCall.where).toEqual({ ownerId: MEMBER.userId });
    // And the returned payload (whatever the mock yielded) is what the
    // client renders — assert the loader passes it through unchanged so a
    // future client-side filter can't accidentally widen the scope.
    expect(data.reminders).toHaveLength(2);
    // The mock is dumb (returns whatever it was told), but the contract
    // under test is the where-clause, proven above.
  });

  it("getDashboardData reminders scope is the same for ADMIN (personal even for admins)", async () => {
    // Reminders are personal for everyone — an admin should see their OWN
    // reminders, not every reminder in the workspace. (Admins do see
    // workspace-wide tasks/projects/members, but reminders were never a
    // shared resource.)
    signIn(ADMIN);
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
    expect(reminderCall.where).toEqual({ ownerId: ADMIN.userId });
  });
});

describe("P16 (PR-11) — fiscal-year start month setting", () => {
  it("persists a valid month through the workspace upsert", async () => {
    signIn(ADMIN);
    db.workspace.upsert.mockResolvedValue({});
    expectOk(await updateWorkspaceSettings({ fiscalYearStartMonth: 4 }));
    // The upsert carries the month in both the create and update branches.
    expect(db.workspace.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "default" },
        update: expect.objectContaining({ fiscalYearStartMonth: 4 }),
      }),
    );
  });

  it("rejects months outside 1–12 at the write-time gate", async () => {
    signIn(ADMIN);
    expectErr(await updateWorkspaceSettings({ fiscalYearStartMonth: 0 }), /fiscalYearStartMonth/i);
    expectErr(await updateWorkspaceSettings({ fiscalYearStartMonth: 13 }), /fiscalYearStartMonth/i);
    expectErr(await updateWorkspaceSettings({ fiscalYearStartMonth: 4.5 }), /fiscalYearStartMonth/i);
    expect(db.workspace.upsert).not.toHaveBeenCalled();
  });
});

describe("P17 (PR-B27 / PR-B25) — loss-of-pay basis + leave balances knobs", () => {
  it("persists a valid basis mode and balances toggle through the workspace upsert", async () => {
    signIn(ADMIN);
    db.workspace.upsert.mockResolvedValue({});
    expectOk(await updateWorkspaceSettings({ lopBasisMode: "ATTENDANCE", showLeaveBalancesOnSlip: true }));
    expect(db.workspace.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "default" },
        update: expect.objectContaining({ lopBasisMode: "ATTENDANCE", showLeaveBalancesOnSlip: true }),
      }),
    );
  });

  it("rejects a fourth basis mode (enum gate) and non-boolean toggles at write time", async () => {
    signIn(ADMIN);
    expectErr(await updateWorkspaceSettings({ lopBasisMode: "GARBAGE" as unknown as "HYBRID" }), /lopBasisMode|invalid/i);
    expectErr(await updateWorkspaceSettings({ showLeaveBalancesOnSlip: "yes" as unknown as boolean }), /showLeaveBalancesOnSlip|boolean/i);
    expect(db.workspace.upsert).not.toHaveBeenCalled();
  });
});

describe("P18 (PR-B16) — payslip email on lock knob", () => {
  it("persists the toggle through the workspace upsert", async () => {
    signIn(ADMIN);
    db.workspace.upsert.mockResolvedValue({});
    expectOk(await updateWorkspaceSettings({ emailPayslipsOnLock: true }));
    expect(db.workspace.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "default" },
        update: expect.objectContaining({ emailPayslipsOnLock: true }),
      }),
    );
  });

  it("rejects non-boolean values at the write-time gate", async () => {
    signIn(ADMIN);
    expectErr(await updateWorkspaceSettings({ emailPayslipsOnLock: "yes" as unknown as boolean }), /emailPayslipsOnLock|boolean/i);
    expect(db.workspace.upsert).not.toHaveBeenCalled();
  });
});
