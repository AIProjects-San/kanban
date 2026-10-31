import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// L-P2-29 / L-P2-30 / L-P2-33 / L-P2-35 — server-action tests for the P2
// batch: mentions, search, trash/restore, GDPR export.
// ---------------------------------------------------------------------------

const db = vi.hoisted(() => {
  const models = [
    "user", "task", "project", "teamMember", "message", "notification",
    "reminder", "timeEntry", "auditLog", "projectAssignment",
  ];
  const methods = ["findUnique", "findFirst", "findMany", "create", "createMany", "update", "updateMany", "delete", "deleteMany", "count", "aggregate"];
  const obj: Record<string, Record<string, ReturnType<typeof vi.fn>>> = {};
  for (const m of models) {
    obj[m] = {};
    for (const meth of methods) obj[m][meth] = vi.fn();
  }
  return obj;
});

vi.mock("@/lib/db", () => ({ db }));

const getSessionMock = vi.fn();
const requirePermissionMock = vi.fn();
const requirePermissionForTargetMock = vi.fn();
vi.mock("@/server-actions/auth-guard", () => ({
  getSession: () => getSessionMock(),
  requirePermission: (...a: unknown[]) => requirePermissionMock(...a),
  requirePermissionForTarget: (...a: unknown[]) => requirePermissionForTargetMock(...a),
  AuthorizationError: class AuthorizationError extends Error {
    readonly digest = "AuthorizationError";
    constructor(m: string) { super(m); this.name = "AuthorizationError"; }
  },
}));

const logAuditMock = vi.fn();
const getScopedProjectIdsMock = vi.fn();
vi.mock("@/server-actions/shared", () => ({
  logAudit: (...a: unknown[]) => logAuditMock(...a),
  getScopedProjectIds: (...a: unknown[]) => getScopedProjectIdsMock(...(a as [])),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { notifyMentionedUsers } from "../mentions";
import { searchWorkspace } from "../search";
import { getTrash, restoreProject, restoreUser, restoreMessage } from "../trash";
import { exportMyData } from "../data-export";

const MEMBER_AUTH = { userId: "u-mia", role: "MEMBER" as const, name: "Mia", email: "mia@x.co" };
const ADMIN_AUTH = { userId: "u-admin", role: "ADMIN" as const, name: "Admin", email: "a@x.co" };

beforeEach(() => {
  vi.clearAllMocks();
  getSessionMock.mockResolvedValue(MEMBER_AUTH);
  requirePermissionMock.mockResolvedValue(ADMIN_AUTH);
  requirePermissionForTargetMock.mockResolvedValue(ADMIN_AUTH);
  // Deep-dive review F-03 — default to unscoped so the existing where-shape
  // assertions stay meaningful; scoping tests override this.
  getScopedProjectIdsMock.mockResolvedValue(null);
  for (const m of Object.values(db)) {
    for (const fn of Object.values(m)) fn.mockResolvedValue([]);
  }
  db.notification.createMany.mockResolvedValue({ count: 0 });
});

// ---------------------------------------------------------------------------
// L-P2-29 — notifyMentionedUsers
// ---------------------------------------------------------------------------

describe("L-P2-29 notifyMentionedUsers", () => {
  it("creates a MENTION notification for each matched user", async () => {
    db.user.findMany.mockResolvedValue([
      { id: "u-1", name: "Ada Lovelace" },
      { id: "u-2", name: "Grace Hopper" },
      { id: "u-mia", name: "Mia" }, // the actor — must NOT be notified
    ]);
    const notified = await notifyMentionedUsers({
      text: "ping @Ada Lovelace and @Grace about this",
      actorUserId: "u-mia",
      actorName: "Mia",
      entityType: "TASK",
      entityLabel: "Fix the login bug",
      detail: "in Apollo",
    });
    expect(notified.sort()).toEqual(["u-1", "u-2"]);
    expect(db.notification.createMany).toHaveBeenCalledTimes(1);
    const call = db.notification.createMany.mock.calls[0][0];
    expect(call.data.length).toBe(2);
    expect(call.data[0]).toMatchObject({
      recipientUserId: "u-1",
      type: "MENTION",
      title: "Mia mentioned you in a task",
    });
  });

  it("matches a single first name only when unambiguous", async () => {
    db.user.findMany.mockResolvedValue([
      { id: "u-1", name: "Ada Lovelace" },
      { id: "u-2", name: "Ada Byron" }, // two Adas → ambiguous
    ]);
    const notified = await notifyMentionedUsers({
      text: "hey @Ada",
      actorUserId: "u-mia",
      actorName: "Mia",
      entityType: "TASK",
      entityLabel: "T",
    });
    expect(notified).toEqual([]);
  });

  it("never notifies the actor about their own mention", async () => {
    db.user.findMany.mockResolvedValue([{ id: "u-mia", name: "Mia" }]);
    const notified = await notifyMentionedUsers({
      text: "note to @Mia self",
      actorUserId: "u-mia",
      actorName: "Mia",
      entityType: "TASK",
      entityLabel: "T",
    });
    expect(notified).toEqual([]);
    expect(db.notification.createMany).not.toHaveBeenCalled();
  });

  it("returns [] when the text has no mentions", async () => {
    const notified = await notifyMentionedUsers({
      text: "no mentions at all",
      actorUserId: "u-mia",
      actorName: "Mia",
      entityType: "TASK",
      entityLabel: "T",
    });
    expect(notified).toEqual([]);
    expect(db.user.findMany).not.toHaveBeenCalled();
  });

  it("skips soft-deleted users (L-P0-14)", async () => {
    // The user.findMany where clause must filter deletedAt: null.
    await notifyMentionedUsers({
      text: "hey @Ada",
      actorUserId: "u-mia",
      actorName: "Mia",
      entityType: "TASK",
      entityLabel: "T",
    });
    expect(db.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { deletedAt: null } }),
    );
  });

  it("never throws — a failure to notify is swallowed", async () => {
    db.user.findMany.mockRejectedValue(new Error("DB down"));
    const notified = await notifyMentionedUsers({
      text: "hey @Ada",
      actorUserId: "u-mia",
      actorName: "Mia",
      entityType: "TASK",
      entityLabel: "T",
    });
    expect(notified).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// L-P2-30 — searchWorkspace
// ---------------------------------------------------------------------------

describe("L-P2-30 searchWorkspace", () => {
  it("returns empty results for queries shorter than 2 chars", async () => {
    const res = await searchWorkspace("a");
    if (!res.ok) throw new Error("expected ok");
    expect(res.data.tasks).toEqual([]);
    expect(res.data.projects).toEqual([]);
    expect(res.data.members).toEqual([]);
    expect(db.task.findMany).not.toHaveBeenCalled();
  });

  it("searches tasks by title and description (ILIKE, soft-delete filtered)", async () => {
    await searchWorkspace("login");
    const call = db.task.findMany.mock.calls[0][0];
    expect(call.where.project).toEqual({ deletedAt: null });
    expect(call.where.OR).toEqual([
      { title: { contains: "login", mode: "insensitive" } },
      { description: { contains: "login", mode: "insensitive" } },
    ]);
    expect(call.take).toBe(5);
  });

  it("searches projects by name and description (soft-delete filtered)", async () => {
    await searchWorkspace("apollo");
    const call = db.project.findMany.mock.calls[0][0];
    expect(call.where.deletedAt).toBeNull();
    expect(call.where.OR).toEqual([
      { name: { contains: "apollo", mode: "insensitive" } },
      { description: { contains: "apollo", mode: "insensitive" } },
    ]);
  });

  it("searches members by name and email (soft-delete filtered)", async () => {
    await searchWorkspace("ada");
    const call = db.teamMember.findMany.mock.calls[0][0];
    expect(call.where.deletedAt).toBeNull();
    expect(call.where.OR).toEqual([
      { name: { contains: "ada", mode: "insensitive" } },
      { email: { contains: "ada", mode: "insensitive" } },
    ]);
  });

  it("maps results into grouped SearchHits", async () => {
    db.task.findMany.mockResolvedValue([
      { id: "t-1", title: "Fix login", status: "TODO", project: { name: "Apollo" } },
    ]);
    db.project.findMany.mockResolvedValue([
      { id: "p-1", name: "Apollo", status: "RUNNING" },
    ]);
    db.teamMember.findMany.mockResolvedValue([
      { id: "m-1", name: "Ada", email: "ada@x.co", role: "Engineer" },
    ]);
    const res = await searchWorkspace("apol");
    if (!res.ok) throw new Error("expected ok");
    expect(res.data.tasks).toEqual([
      { id: "t-1", label: "Fix login", sublabel: "Apollo", kind: "task" },
    ]);
    expect(res.data.projects).toEqual([
      { id: "p-1", label: "Apollo", sublabel: "RUNNING", kind: "project" },
    ]);
    expect(res.data.members).toEqual([
      { id: "m-1", label: "Ada", sublabel: "Engineer", kind: "member" },
    ]);
  });

  it("requires a signed-in session", async () => {
    getSessionMock.mockResolvedValue(null);
    const res = await searchWorkspace("anything");
    expect(res.ok).toBe(false);
  });

  // Deep-dive review F-03 — scoped roles must not be able to search into
  // projects/tasks they cannot see.
  it("scopes task + project results to the caller's projects for MEMBER/MANAGER (F-03)", async () => {
    getScopedProjectIdsMock.mockResolvedValue(new Set(["p-1", "p-2"]));
    await searchWorkspace("apollo");
    const taskCall = db.task.findMany.mock.calls[0][0];
    expect(taskCall.where.AND[0].OR).toEqual([
      { projectId: { in: ["p-1", "p-2"] } },
      { assignee: { userId: MEMBER_AUTH.userId } },
    ]);
    expect(taskCall.where.AND[1].OR).toEqual([
      { title: { contains: "apollo", mode: "insensitive" } },
      { description: { contains: "apollo", mode: "insensitive" } },
    ]);
    const projectCall = db.project.findMany.mock.calls[0][0];
    expect(projectCall.where.id).toEqual({ in: ["p-1", "p-2"] });
  });

  it("leaves the member directory group unscoped (team:view semantics, F-03)", async () => {
    getScopedProjectIdsMock.mockResolvedValue(new Set(["p-1"]));
    await searchWorkspace("ada");
    const memberCall = db.teamMember.findMany.mock.calls[0][0];
    expect(memberCall.where.id).toBeUndefined();
    expect(memberCall.where.OR).toEqual([
      { name: { contains: "ada", mode: "insensitive" } },
      { email: { contains: "ada", mode: "insensitive" } },
    ]);
  });

  it("caps the query length at 100 characters (F-03)", async () => {
    const res = await searchWorkspace("a".repeat(500));
    if (!res.ok) throw new Error("expected ok");
    expect(res.data.query.length).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// L-P2-33 — trash / restore
// ---------------------------------------------------------------------------

describe("L-P2-33 getTrash", () => {
  it("lists soft-deleted projects, users, and messages, most recent first", async () => {
    db.project.findMany.mockResolvedValue([
      { id: "p-1", name: "Apollo", status: "RUNNING", deletedAt: new Date("2026-10-28") },
    ]);
    db.user.findMany.mockResolvedValue([
      { id: "u-1", name: "Oli", email: "oli@x.co", deletedAt: new Date("2026-10-30") },
    ]);
    db.message.findMany.mockResolvedValue([]);
    const res = await getTrash();
    if (!res.ok) throw new Error("expected ok");
    expect(res.data.length).toBe(2);
    // Most recently deleted first: Oli (10-30) before Apollo (10-28)
    expect(res.data[0]).toMatchObject({ id: "u-1", kind: "user", label: "Oli" });
    expect(res.data[1]).toMatchObject({ id: "p-1", kind: "project", label: "Apollo" });
  });

  it("requires role:manage (admin-only)", async () => {
    requirePermissionMock.mockRejectedValue(new Error("no perm"));
    const res = await getTrash();
    expect(res.ok).toBe(false);
  });

  it("queries only rows with deletedAt set", async () => {
    await getTrash();
    expect(db.project.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { deletedAt: { not: null } } }),
    );
    expect(db.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { deletedAt: { not: null } } }),
    );
    expect(db.message.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { deletedAt: { not: null } } }),
    );
  });
});

describe("L-P2-33 restoreProject", () => {
  it("clears deletedAt and audits the restore", async () => {
    db.project.findUnique.mockResolvedValue({
      id: "p-1", name: "Apollo", status: "RUNNING", deletedAt: new Date("2026-10-28"),
    });
    const res = await restoreProject("p-1");
    expect(res.ok).toBe(true);
    expect(db.project.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "p-1" }, data: { deletedAt: null } }),
    );
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "project.restored",
        detail: expect.stringMatching(/Restored project/),
      }),
    );
  });

  it("refuses to restore a project that is not in the trash", async () => {
    db.project.findUnique.mockResolvedValue({ id: "p-1", name: "Apollo", deletedAt: null });
    const res = await restoreProject("p-1");
    expect(res.ok).toBe(false);
    expect(db.project.update).not.toHaveBeenCalled();
  });
});

describe("L-P2-33 restoreUser", () => {
  it("clears deletedAt on the User AND the linked TeamMember row", async () => {
    db.user.findUnique.mockResolvedValue({
      id: "u-oli", name: "Oli", email: "oli@x.co", deletedAt: new Date("2026-10-30"),
    });
    const res = await restoreUser("u-oli");
    expect(res.ok).toBe(true);
    expect(db.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "u-oli" }, data: { deletedAt: null } }),
    );
    expect(db.teamMember.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { email: "oli@x.co" },
        data: { deletedAt: null },
      }),
    );
  });

  it("refuses to restore a user who is not in the trash", async () => {
    db.user.findUnique.mockResolvedValue({ id: "u-oli", name: "Oli", email: "oli@x.co", deletedAt: null });
    const res = await restoreUser("u-oli");
    expect(res.ok).toBe(false);
  });
});

describe("L-P2-33 restoreMessage", () => {
  it("lets the sender restore their own soft-deleted message", async () => {
    db.message.findUnique.mockResolvedValue({
      id: "m-1", subject: "hi", senderUserId: MEMBER_AUTH.userId, recipientUserId: "u-oli", deletedAt: new Date(),
    });
    const res = await restoreMessage("m-1");
    expect(res.ok).toBe(true);
    expect(db.message.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "m-1" }, data: { deletedAt: null } }),
    );
  });

  it("rejects restoring a message you neither sent nor received", async () => {
    db.message.findUnique.mockResolvedValue({
      id: "m-1", subject: "hi", senderUserId: "u-oli", recipientUserId: "u-admin", deletedAt: new Date(),
    });
    const res = await restoreMessage("m-1");
    expect(res.ok).toBe(false);
    expect(db.message.update).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// L-P2-35 — exportMyData
// ---------------------------------------------------------------------------

describe("L-P2-35 exportMyData", () => {
  it("exports the caller's account + settings + all related rows", async () => {
    db.user.findUnique.mockResolvedValue({
      id: "u-mia", email: "mia@x.co", name: "Mia", role: "MEMBER",
      timezone: "UTC", bio: "", avatarColor: "forest",
      createdAt: new Date("2026-01-01"),
      settings: { accent: "forest", dark: false },
    });
    db.project.findMany.mockResolvedValue([{ id: "p-1", name: "Apollo", ownerUserId: "u-mia" }]);
    db.task.findMany.mockResolvedValue([{ id: "t-1", title: "Fix login", assignee: { userId: "u-mia" } }]);
    db.message.findMany.mockResolvedValue([{ id: "m-1", subject: "hi", senderUserId: "u-mia" }]);

    const res = await exportMyData();
    if (!res.ok) throw new Error("expected ok");
    expect(res.data.account).toMatchObject({ id: "u-mia", email: "mia@x.co", name: "Mia" });
    expect(res.data.settings).toEqual({ accent: "forest", dark: false });
    expect(res.data.ownedProjects.length).toBe(1);
    expect(res.data.assignedTasks.length).toBe(1);
    expect(res.data.exportedAt).toBeTruthy();
  });

  it("scopes every query to the caller's own userId (self-service only)", async () => {
    db.user.findUnique.mockResolvedValue({
      id: "u-mia", email: "mia@x.co", name: "Mia", role: "MEMBER",
      timezone: "UTC", bio: "", avatarColor: "forest",
      createdAt: new Date("2026-01-01"), settings: null,
    });
    await exportMyData();
    expect(db.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "u-mia" } }),
    );
    expect(db.project.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { ownerUserId: "u-mia" } }),
    );
    expect(db.task.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { assignee: { userId: "u-mia" } } }),
    );
    expect(db.notification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { recipientUserId: "u-mia" } }),
    );
    expect(db.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { actorId: "u-mia" } }),
    );
  });

  it("requires a signed-in session", async () => {
    getSessionMock.mockResolvedValue(null);
    const res = await exportMyData();
    expect(res.ok).toBe(false);
  });

  it("fails when the account no longer exists", async () => {
    db.user.findUnique.mockResolvedValue(null);
    const res = await exportMyData();
    expect(res.ok).toBe(false);
  });
});
