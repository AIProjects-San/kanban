import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Bug tracking server action tests — full lifecycle coverage.
// ---------------------------------------------------------------------------

const db = vi.hoisted(() => {
  const models = ["bug", "bugComment", "user", "project", "task", "auditLog"];
  const methods = [
    "findMany", "findUnique", "findFirst", "create", "createMany", "update",
    "updateMany", "delete", "deleteMany", "upsert", "count", "aggregate",
  ];
  const obj: Record<string, Record<string, ReturnType<typeof vi.fn>>> = {};
  for (const m of models) {
    obj[m] = {};
    for (const meth of methods) obj[m][meth] = vi.fn();
  }
  // Interactive transactions: execute the callback against the same mock.
  (obj as Record<string, unknown>).$transaction = vi.fn(
    async (fn: unknown) =>
      typeof fn === "function" ? fn(obj) : Promise.resolve(fn),
  );
  return obj;
});

vi.mock("@/lib/infra/db", () => ({ db }));

const getSessionMock = vi.fn();
const requirePermissionMock = vi.fn();
vi.mock("@/server-actions/auth-guard", () => {
  class AuthorizationError extends Error {
    readonly digest = "AuthorizationError";
    constructor(m: string) { super(m); this.name = "AuthorizationError"; }
  }
  return {
    getSession: () => getSessionMock(),
    getSessionOrThrow: async () => {
      const a = await getSessionMock();
      if (!a) throw new AuthorizationError("You must be signed in.");
      return a;
    },
    requirePermission: (...a: unknown[]) => requirePermissionMock(...a),
    // The DB-aware probe, mocked to its static floor — these tests exercise
    // the role matrix, not the DB ceiling.
    checkPermission: async (role: unknown, perm: unknown) => {
      const rbac = await vi.importActual<typeof import("@/lib/auth/rbac")>("@/lib/auth/rbac");
      return rbac.hasPermission(role as never, perm as never);
    },
    AuthorizationError,
  };
});

const logAuditMock = vi.fn();
const getScopedProjectIdsMock = vi.fn();
const assertUserAssociatedWithProjectMock = vi.fn();
const getProjectAssociatedUserIdsMock = vi.fn();
vi.mock("@/server-actions/shared", () => ({
  logAudit: (...a: unknown[]) => logAuditMock(...a),
  getScopedProjectIds: (...a: unknown[]) => getScopedProjectIdsMock(...a),
  assertUserAssociatedWithProject: (...a: unknown[]) => assertUserAssociatedWithProjectMock(...a),
  getProjectAssociatedUserIds: (...a: unknown[]) => getProjectAssociatedUserIdsMock(...a),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import {
  createBug, getBug, getBugsPage, updateBug, assignBug,
  changeBugStatus, addBugComment, deleteBug,
  moveBug, linkBugToTask, getBugBoard, getTaskLinkedBugs, getLinkableBugs,
} from "../bugs";

const ADMIN_AUTH = { userId: "u-admin", role: "ADMIN" as const, name: "Ada", email: "ada@x.co" };
const MEMBER_AUTH = { userId: "u-mia", role: "MEMBER" as const, name: "Mia", email: "mia@x.co" };
const QA_AUTH = { userId: "u-qa", role: "MEMBER" as const, name: "Quinn", email: "quinn@x.co" };

beforeEach(() => {
  vi.clearAllMocks();
  getSessionMock.mockResolvedValue(MEMBER_AUTH);
  requirePermissionMock.mockResolvedValue(MEMBER_AUTH);
  // Project association rule — default to a known project whose associated
  // users include everyone in these fixtures. Individual tests override.
  getProjectAssociatedUserIdsMock.mockResolvedValue(new Set(["u-admin", "u-mia", "u-qa", "u-dev"]));
  assertUserAssociatedWithProjectMock.mockResolvedValue(undefined);
  db.bug.findUnique.mockResolvedValue(null);
  db.bug.findMany.mockResolvedValue([]);
  db.bug.create.mockResolvedValue({ id: "b-1", title: "Test bug", severity: "MAJOR", priority: "P2" });
  db.bug.update.mockResolvedValue({});
  db.bug.delete.mockResolvedValue({});
  db.bugComment.create.mockResolvedValue({ id: "c-1" });
  db.user.findUnique.mockResolvedValue(null);
  db.user.findMany.mockResolvedValue([]);
  db.project.findUnique.mockResolvedValue(null);
  db.project.findMany.mockResolvedValue([]);
  db.task.findUnique.mockResolvedValue(null);
  db.task.findMany.mockResolvedValue([]);
  getScopedProjectIdsMock.mockResolvedValue(null); // unscoped (ADMIN) by default
});

// ---------------------------------------------------------------------------
// createBug
// ---------------------------------------------------------------------------

describe("createBug", () => {
  it("creates a bug with defaults (NEW status, MAJOR severity, P2 priority)", async () => {
    requirePermissionMock.mockResolvedValue(QA_AUTH);
    const res = await createBug({ title: "Login broken", projectId: "p-1" });
    expect(res.ok).toBe(true);
    expect(db.bug.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          title: "Login broken",
          status: "NEW",
          severity: "MAJOR",
          priority: "P2",
          reporterUserId: "u-qa",
          projectId: "p-1",
        }),
      }),
    );
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "bug.created",
        entityType: "BUG",
        entityId: "b-1",
      }),
    );
  });

  it("accepts custom severity + priority", async () => {
    const res = await createBug({ title: "Crash", severity: "CRITICAL", priority: "P0", projectId: "p-1" });
    expect(res.ok).toBe(true);
    expect(db.bug.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ severity: "CRITICAL", priority: "P0" }),
      }),
    );
  });

  it("requires a project (project association rule)", async () => {
    const res = await createBug({ title: "Orphan bug" });
    expect(res.ok).toBe(false);
    expect(db.bug.create).not.toHaveBeenCalled();
  });

  it("rejects an unknown project", async () => {
    getProjectAssociatedUserIdsMock.mockResolvedValue(null);
    const res = await createBug({ title: "Ghost project", projectId: "p-ghost" });
    expect(res.ok).toBe(false);
    expect(db.bug.create).not.toHaveBeenCalled();
  });

  it("rejects a linked task from a different project", async () => {
    db.task.findUnique.mockResolvedValue({ projectId: "p-other" });
    const res = await createBug({ title: "Cross-project", projectId: "p-1", taskId: "t-1" });
    expect(res.ok).toBe(false);
    expect(db.bug.create).not.toHaveBeenCalled();
  });

  it("accepts a linked task from the same project", async () => {
    db.task.findUnique.mockResolvedValue({ projectId: "p-1" });
    const res = await createBug({ title: "Same project", projectId: "p-1", taskId: "t-1" });
    expect(res.ok).toBe(true);
    expect(db.bug.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ taskId: "t-1", projectId: "p-1" }) }),
    );
  });

  it("rejects empty title", async () => {
    const res = await createBug({ title: "" });
    expect(res.ok).toBe(false);
  });

  it("rejects title > 200 chars", async () => {
    const res = await createBug({ title: "x".repeat(201) });
    expect(res.ok).toBe(false);
  });

  it("rejects invalid severity", async () => {
    const res = await createBug({ title: "Test", severity: "INVALID" });
    expect(res.ok).toBe(false);
  });

  it("requires bug:create permission", async () => {
    requirePermissionMock.mockRejectedValue(new Error("no perm"));
    const res = await createBug({ title: "Test" });
    expect(res.ok).toBe(false);
  });

  it("sets reporterUserId from the session (not client)", async () => {
    requirePermissionMock.mockResolvedValue(QA_AUTH);
    await createBug({ title: "Test", projectId: "p-1" });
    expect(db.bug.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ reporterUserId: "u-qa" }),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// getBug
// ---------------------------------------------------------------------------

describe("getBug", () => {
  it("returns the bug with comments + resolved names", async () => {
    db.bug.findUnique.mockResolvedValue({
      id: "b-1", title: "Test", description: "desc",
      stepsToReproduce: "steps", expectedBehavior: "exp", actualBehavior: "act",
      severity: "MAJOR", priority: "P2", status: "NEW", resolution: null,
      reporterUserId: "u-qa", assigneeUserId: "u-dev",
      projectId: null, taskId: null, environment: "prod",
      createdAt: new Date(), updatedAt: new Date(),
      triagedAt: null, resolvedAt: null, closedAt: null,
      comments: [],
    });
    db.user.findMany.mockResolvedValue([
      { id: "u-qa", name: "Quinn" },
      { id: "u-dev", name: "Deva" },
    ]);
    const res = await getBug("b-1");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.reporterName).toBe("Quinn");
    expect(res.data.assigneeName).toBe("Deva");
  });

  it("throws for non-existent bug", async () => {
    db.bug.findUnique.mockResolvedValue(null);
    const res = await getBug("b-missing");
    expect(res.ok).toBe(false);
  });

  it("requires a signed-in session", async () => {
    getSessionMock.mockResolvedValue(null);
    const res = await getBug("b-1");
    expect(res.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getBugsPage
// ---------------------------------------------------------------------------

describe("getBugsPage", () => {
  it("returns paginated bugs with resolved names", async () => {
    db.bug.findMany.mockResolvedValue([
      { id: "b-1", title: "Bug 1", severity: "MAJOR", priority: "P2", status: "NEW",
        reporterUserId: "u-qa", assigneeUserId: null, projectId: null,
        createdAt: new Date(), updatedAt: new Date() },
    ]);
    db.user.findMany.mockResolvedValue([{ id: "u-qa", name: "Quinn" }]);
    const res = await getBugsPage({ limit: 10 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.items).toHaveLength(1);
    expect(res.data.items[0].reporterName).toBe("Quinn");
    expect(res.data.hasMore).toBe(false);
  });

  it("applies status filter", async () => {
    await getBugsPage({ status: "NEW" });
    expect(db.bug.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ status: "NEW" }) }),
    );
  });

  it("applies severity filter", async () => {
    await getBugsPage({ severity: "CRITICAL" });
    expect(db.bug.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ severity: "CRITICAL" }) }),
    );
  });

  it("applies search filter (ILIKE on title + description)", async () => {
    await getBugsPage({ search: "crash" });
    expect(db.bug.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([
            expect.objectContaining({ title: expect.objectContaining({ contains: "crash" }) }),
          ]),
        }),
      }),
    );
  });

  it("clamps limit to 200 max", async () => {
    await getBugsPage({ limit: 500 });
    expect(db.bug.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 201 }), // limit+1 for hasMore
    );
  });

  it("rejects malformed cursor (returns first page)", async () => {
    await getBugsPage({ cursor: "bad" });
    expect(db.bug.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 51 }),
    );
    // No cursor/skip in the query
    const call = db.bug.findMany.mock.calls[0][0];
    expect(call.cursor).toBeUndefined();
    expect(call.skip).toBeUndefined();
  });

  it("accepts valid 24-char cursor", async () => {
    const validCursor = "c".repeat(24);
    await getBugsPage({ cursor: validCursor });
    expect(db.bug.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: { id: validCursor }, skip: 1 }),
    );
  });

  it("sets hasMore when take returns limit+1 rows", async () => {
    db.bug.findMany.mockResolvedValue(
      Array.from({ length: 11 }, (_, i) => ({
        id: `b-${i}`, title: `Bug ${i}`, severity: "MAJOR", priority: "P2", status: "NEW",
        reporterUserId: "u-qa", assigneeUserId: null, projectId: null,
        createdAt: new Date(), updatedAt: new Date(),
      })),
    );
    const res = await getBugsPage({ limit: 10 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.hasMore).toBe(true);
    expect(res.data.items).toHaveLength(10);
  });
});

// ---------------------------------------------------------------------------
// updateBug
// ---------------------------------------------------------------------------

describe("updateBug", () => {
  it("updates title + severity", async () => {
    db.bug.findUnique.mockResolvedValue({
      id: "b-1", title: "Old", severity: "MINOR", priority: "P2",
      reporterUserId: "u-mia", assigneeUserId: null,
    });
    const res = await updateBug("b-1", { title: "New", severity: "CRITICAL" });
    expect(res.ok).toBe(true);
    expect(db.bug.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "b-1" },
        data: { title: "New", severity: "CRITICAL" },
      }),
    );
  });

  it("reporter can edit their own bug", async () => {
    db.bug.findUnique.mockResolvedValue({
      id: "b-1", title: "Old", reporterUserId: "u-mia", assigneeUserId: null,
    });
    const res = await updateBug("b-1", { title: "Updated" });
    expect(res.ok).toBe(true);
  });

  it("assignee can edit", async () => {
    db.bug.findUnique.mockResolvedValue({
      id: "b-1", title: "Old", reporterUserId: "u-qa", assigneeUserId: "u-mia",
    });
    const res = await updateBug("b-1", { title: "Updated" });
    expect(res.ok).toBe(true);
  });

  it("non-reporter non-assignee without bug:edit:any is rejected", async () => {
    db.bug.findUnique.mockResolvedValue({
      id: "b-1", title: "Old", reporterUserId: "u-qa", assigneeUserId: "u-dev",
    });
    const res = await updateBug("b-1", { title: "Hack" });
    expect(res.ok).toBe(false);
  });

  it("ADMIN (bug:edit:any) can edit any bug", async () => {
    requirePermissionMock.mockResolvedValue(ADMIN_AUTH);
    db.bug.findUnique.mockResolvedValue({
      id: "b-1", title: "Old", reporterUserId: "u-qa", assigneeUserId: "u-dev", projectId: "p-1",
    });
    const res = await updateBug("b-1", { title: "Admin edit" });
    expect(res.ok).toBe(true);
  });

  it("moves the bug to another project when the assignee is associated with it", async () => {
    db.bug.findUnique.mockResolvedValue({
      id: "b-1", title: "Old", reporterUserId: "u-mia", assigneeUserId: "u-dev", projectId: "p-1",
    });
    const res = await updateBug("b-1", { projectId: "p-2" });
    expect(res.ok).toBe(true);
    expect(assertUserAssociatedWithProjectMock).toHaveBeenCalledWith("u-dev", "p-2");
    expect(db.bug.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { projectId: "p-2" } }),
    );
  });

  it("rejects moving the bug off its project (projectId: null)", async () => {
    db.bug.findUnique.mockResolvedValue({
      id: "b-1", title: "Old", reporterUserId: "u-mia", assigneeUserId: null, projectId: "p-1",
    });
    const res = await updateBug("b-1", { projectId: null });
    expect(res.ok).toBe(false);
    expect(db.bug.update).not.toHaveBeenCalled();
  });

  it("rejects a project move when the current assignee is not associated with the new project", async () => {
    db.bug.findUnique.mockResolvedValue({
      id: "b-1", title: "Old", reporterUserId: "u-mia", assigneeUserId: "u-dev", projectId: "p-1",
    });
    assertUserAssociatedWithProjectMock.mockRejectedValue(new Error("not associated"));
    const res = await updateBug("b-1", { projectId: "p-2" });
    expect(res.ok).toBe(false);
    expect(db.bug.update).not.toHaveBeenCalled();
  });

  it("rejects a project move when the linked task belongs to a different project", async () => {
    db.bug.findUnique.mockResolvedValue({
      id: "b-1", title: "Old", reporterUserId: "u-mia", assigneeUserId: null, projectId: "p-1", taskId: "t-1",
    });
    db.task.findUnique.mockResolvedValue({ projectId: "p-other" });
    const res = await updateBug("b-1", { projectId: "p-2" });
    expect(res.ok).toBe(false);
    expect(db.bug.update).not.toHaveBeenCalled();
  });

  it("throws for non-existent bug", async () => {
    db.bug.findUnique.mockResolvedValue(null);
    const res = await updateBug("b-missing", { title: "X" });
    expect(res.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// assignBug
// ---------------------------------------------------------------------------

describe("assignBug", () => {
  it("assigns to a valid user associated with the bug's project", async () => {
    requirePermissionMock.mockResolvedValue(ADMIN_AUTH);
    db.bug.findUnique.mockResolvedValue({ id: "b-1", title: "Test", projectId: "p-1" });
    db.user.findUnique.mockResolvedValue({ name: "Deva" });
    const res = await assignBug("b-1", "u-dev");
    expect(res.ok).toBe(true);
    expect(assertUserAssociatedWithProjectMock).toHaveBeenCalledWith("u-dev", "p-1");
    expect(db.bug.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "b-1" }, data: { assigneeUserId: "u-dev" } }),
    );
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "bug.assigned", detail: expect.stringContaining("Deva") }),
    );
  });

  it("unassigns (null assignee) — no association check needed", async () => {
    requirePermissionMock.mockResolvedValue(ADMIN_AUTH);
    db.bug.findUnique.mockResolvedValue({ id: "b-1", title: "Test", projectId: "p-1" });
    const res = await assignBug("b-1", null);
    expect(res.ok).toBe(true);
    expect(assertUserAssociatedWithProjectMock).not.toHaveBeenCalled();
    expect(db.bug.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { assigneeUserId: null } }),
    );
  });

  it("rejects a user who is not associated with the bug's project", async () => {
    requirePermissionMock.mockResolvedValue(ADMIN_AUTH);
    db.bug.findUnique.mockResolvedValue({ id: "b-1", title: "Test", projectId: "p-1" });
    db.user.findUnique.mockResolvedValue({ name: "Outsider" });
    assertUserAssociatedWithProjectMock.mockRejectedValue(new Error("not associated"));
    const res = await assignBug("b-1", "u-outsider");
    expect(res.ok).toBe(false);
    expect(db.bug.update).not.toHaveBeenCalled();
  });

  it("rejects assignment on a legacy bug without a project", async () => {
    requirePermissionMock.mockResolvedValue(ADMIN_AUTH);
    db.bug.findUnique.mockResolvedValue({ id: "b-1", title: "Test", projectId: null });
    db.user.findUnique.mockResolvedValue({ name: "Deva" });
    const res = await assignBug("b-1", "u-dev");
    expect(res.ok).toBe(false);
    expect(db.bug.update).not.toHaveBeenCalled();
  });

  it("rejects non-existent assignee", async () => {
    requirePermissionMock.mockResolvedValue(ADMIN_AUTH);
    db.bug.findUnique.mockResolvedValue({ id: "b-1", title: "Test", projectId: "p-1" });
    db.user.findUnique.mockResolvedValue(null);
    const res = await assignBug("b-1", "u-ghost");
    expect(res.ok).toBe(false);
  });

  it("rejects soft-deleted assignee", async () => {
    requirePermissionMock.mockResolvedValue(ADMIN_AUTH);
    db.bug.findUnique.mockResolvedValue({ id: "b-1", title: "Test", projectId: "p-1" });
    db.user.findUnique.mockResolvedValue(null); // deletedAt:null filter excludes
    const res = await assignBug("b-1", "u-deleted");
    expect(res.ok).toBe(false);
  });

  it("requires bug:assign permission", async () => {
    requirePermissionMock.mockRejectedValue(new Error("no perm"));
    const res = await assignBug("b-1", "u-dev");
    expect(res.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// changeBugStatus — lifecycle enforcement
// ---------------------------------------------------------------------------

describe("changeBugStatus", () => {
  it("NEW → TRIAGED is allowed", async () => {
    db.bug.findUnique.mockResolvedValue({
      id: "b-1", title: "Test", status: "NEW", reporterUserId: "u-mia", assigneeUserId: null,
      triagedAt: null, resolvedAt: null, closedAt: null,
    });
    const res = await changeBugStatus("b-1", { status: "TRIAGED" });
    expect(res.ok).toBe(true);
    expect(db.bug.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "TRIAGED" }) }),
    );
  });

  it("NEW → RESOLVED is rejected (must go through IN_PROGRESS)", async () => {
    db.bug.findUnique.mockResolvedValue({
      id: "b-1", title: "Test", status: "NEW", reporterUserId: "u-mia", assigneeUserId: null,
    });
    const res = await changeBugStatus("b-1", { status: "RESOLVED" });
    expect(res.ok).toBe(false);
  });

  it("IN_PROGRESS → IN_REVIEW is allowed", async () => {
    db.bug.findUnique.mockResolvedValue({
      id: "b-1", title: "Test", status: "IN_PROGRESS", reporterUserId: "u-mia", assigneeUserId: null,
    });
    const res = await changeBugStatus("b-1", { status: "IN_REVIEW" });
    expect(res.ok).toBe(true);
  });

  it("RESOLVED → REOPENED is allowed", async () => {
    db.bug.findUnique.mockResolvedValue({
      id: "b-1", title: "Test", status: "RESOLVED", reporterUserId: "u-mia", assigneeUserId: null,
      resolvedAt: new Date(), closedAt: null,
    });
    const res = await changeBugStatus("b-1", { status: "REOPENED" });
    expect(res.ok).toBe(true);
    // REOPENED clears resolvedAt
    expect(db.bug.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ resolvedAt: null, closedAt: null }) }),
    );
  });

  it("CLOSED → IN_PROGRESS is rejected (must REOPENED first)", async () => {
    db.bug.findUnique.mockResolvedValue({
      id: "b-1", title: "Test", status: "CLOSED", reporterUserId: "u-mia", assigneeUserId: null,
    });
    const res = await changeBugStatus("b-1", { status: "IN_PROGRESS" });
    expect(res.ok).toBe(false);
  });

  it("RESOLVED requires resolution (defaults to FIXED)", async () => {
    db.bug.findUnique.mockResolvedValue({
      id: "b-1", title: "Test", status: "IN_PROGRESS", reporterUserId: "u-mia", assigneeUserId: null,
    });
    const res = await changeBugStatus("b-1", { status: "RESOLVED" });
    expect(res.ok).toBe(true);
    expect(db.bug.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ resolution: "FIXED" }) }),
    );
  });

  it("RESOLVED with custom resolution", async () => {
    db.bug.findUnique.mockResolvedValue({
      id: "b-1", title: "Test", status: "IN_PROGRESS", reporterUserId: "u-mia", assigneeUserId: null,
    });
    const res = await changeBugStatus("b-1", { status: "RESOLVED", resolution: "WONT_FIX" });
    expect(res.ok).toBe(true);
    expect(db.bug.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ resolution: "WONT_FIX" }) }),
    );
  });

  it("sets triagedAt on first TRIAGED transition", async () => {
    db.bug.findUnique.mockResolvedValue({
      id: "b-1", title: "Test", status: "NEW", reporterUserId: "u-mia", assigneeUserId: null,
      triagedAt: null,
    });
    await changeBugStatus("b-1", { status: "TRIAGED" });
    expect(db.bug.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ triagedAt: expect.any(Date) }) }),
    );
  });

  it("does not overwrite triagedAt on re-triage", async () => {
    const oldTriagedAt = new Date("2026-01-01");
    db.bug.findUnique.mockResolvedValue({
      id: "b-1", title: "Test", status: "REOPENED", reporterUserId: "u-mia", assigneeUserId: null,
      triagedAt: oldTriagedAt,
    });
    await changeBugStatus("b-1", { status: "IN_PROGRESS" });
    // triagedAt not in the update data (already set)
    const updateCall = db.bug.update.mock.calls[0][0];
    expect(updateCall.data.triagedAt).toBeUndefined();
  });

  it("adds an optional comment alongside the status change", async () => {
    db.bug.findUnique.mockResolvedValue({
      id: "b-1", title: "Test", status: "NEW", reporterUserId: "u-mia", assigneeUserId: null,
    });
    await changeBugStatus("b-1", { status: "TRIAGED", comment: "Looks legit" });
    expect(db.bugComment.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ body: "Looks legit" }) }),
    );
  });

  it("audits bug.resolved on RESOLVED transition", async () => {
    db.bug.findUnique.mockResolvedValue({
      id: "b-1", title: "Test", status: "IN_PROGRESS", reporterUserId: "u-mia", assigneeUserId: null,
    });
    await changeBugStatus("b-1", { status: "RESOLVED", resolution: "FIXED" });
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "bug.resolved" }),
    );
  });

  it("audits bug.reopened on REOPENED transition", async () => {
    db.bug.findUnique.mockResolvedValue({
      id: "b-1", title: "Test", status: "RESOLVED", reporterUserId: "u-mia", assigneeUserId: null,
      resolvedAt: new Date(), closedAt: null,
    });
    await changeBugStatus("b-1", { status: "REOPENED" });
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "bug.reopened" }),
    );
  });
});

// ---------------------------------------------------------------------------
// addBugComment
// ---------------------------------------------------------------------------

describe("addBugComment", () => {
  it("adds a comment with author info from session", async () => {
    db.bug.findUnique.mockResolvedValue({ title: "Test bug" });
    const res = await addBugComment({ bugId: "b-1", body: "I can reproduce this" });
    expect(res.ok).toBe(true);
    expect(db.bugComment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          bugId: "b-1",
          body: "I can reproduce this",
          authorId: "u-mia",
          authorName: "Mia",
        }),
      }),
    );
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "bug.commented" }),
    );
  });

  it("rejects empty comment", async () => {
    const res = await addBugComment({ bugId: "b-1", body: "" });
    expect(res.ok).toBe(false);
  });

  it("rejects comment > 5000 chars", async () => {
    const res = await addBugComment({ bugId: "b-1", body: "x".repeat(5001) });
    expect(res.ok).toBe(false);
  });

  it("throws for non-existent bug", async () => {
    db.bug.findUnique.mockResolvedValue(null);
    const res = await addBugComment({ bugId: "b-missing", body: "test" });
    expect(res.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// deleteBug
// ---------------------------------------------------------------------------

describe("deleteBug", () => {
  it("ADMIN can delete a bug", async () => {
    requirePermissionMock.mockResolvedValue(ADMIN_AUTH);
    db.bug.findUnique.mockResolvedValue({ title: "Test" });
    const res = await deleteBug("b-1");
    expect(res.ok).toBe(true);
    expect(db.bug.delete).toHaveBeenCalledWith({ where: { id: "b-1" } });
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "bug.deleted" }),
    );
  });

  it("MEMBER cannot delete (bug:delete denied)", async () => {
    requirePermissionMock.mockRejectedValue(new Error("no perm"));
    const res = await deleteBug("b-1");
    expect(res.ok).toBe(false);
  });

  it("throws for non-existent bug", async () => {
    requirePermissionMock.mockResolvedValue(ADMIN_AUTH);
    db.bug.findUnique.mockResolvedValue(null);
    const res = await deleteBug("b-missing");
    expect(res.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Board enhancement — moveBug (drag-and-drop board moves)
// ---------------------------------------------------------------------------

describe("moveBug (board drag)", () => {
  it("NEW → TRIAGED drag updates status + boardOrder + sets triagedAt", async () => {
    db.bug.findUnique.mockResolvedValue({
      id: "b-1", title: "Board bug", status: "NEW", reporterUserId: "u-mia", assigneeUserId: null,
      triagedAt: null, resolvedAt: null, closedAt: null,
    });
    const res = await moveBug("b-1", { status: "TRIAGED", order: 3 });
    expect(res.ok).toBe(true);
    expect(db.bug.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "TRIAGED", boardOrder: 3, triagedAt: expect.any(Date) }),
      }),
    );
  });

  it("same-status drag is a pure reorder (allowed, logs bug.moved)", async () => {
    db.bug.findUnique.mockResolvedValue({
      id: "b-1", title: "Board bug", status: "NEW", reporterUserId: "u-mia", assigneeUserId: null,
    });
    const res = await moveBug("b-1", { status: "NEW", order: 5 });
    expect(res.ok).toBe(true);
    expect(db.bug.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "NEW", boardOrder: 5 }) }),
    );
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "bug.moved" }),
    );
  });

  it("illegal drag NEW → IN_REVIEW is rejected (lifecycle guard)", async () => {
    db.bug.findUnique.mockResolvedValue({
      id: "b-1", title: "Board bug", status: "NEW", reporterUserId: "u-mia", assigneeUserId: null,
    });
    const res = await moveBug("b-1", { status: "IN_REVIEW", order: 0 });
    expect(res.ok).toBe(false);
    expect(db.bug.update).not.toHaveBeenCalled();
  });

  it("drag to RESOLVED defaults the resolution to FIXED", async () => {
    db.bug.findUnique.mockResolvedValue({
      id: "b-1", title: "Board bug", status: "IN_PROGRESS", reporterUserId: "u-mia", assigneeUserId: null,
    });
    const res = await moveBug("b-1", { status: "RESOLVED", order: 0 });
    expect(res.ok).toBe(true);
    expect(db.bug.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "RESOLVED", resolution: "FIXED", resolvedAt: expect.any(Date) }),
      }),
    );
  });

  it("drag to REOPENED clears resolvedAt/closedAt", async () => {
    db.bug.findUnique.mockResolvedValue({
      id: "b-1", title: "Board bug", status: "RESOLVED", reporterUserId: "u-mia", assigneeUserId: null,
      resolvedAt: new Date(), closedAt: new Date(),
    });
    const res = await moveBug("b-1", { status: "REOPENED", order: 0 });
    expect(res.ok).toBe(true);
    expect(db.bug.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ resolvedAt: null, closedAt: null }) }),
    );
  });

  it("rejects malformed order (NaN / negative)", async () => {
    db.bug.findUnique.mockResolvedValue({
      id: "b-1", title: "Board bug", status: "NEW", reporterUserId: "u-mia", assigneeUserId: null,
    });
    const res = await moveBug("b-1", { status: "TRIAGED", order: -1 });
    expect(res.ok).toBe(false);
    expect(db.bug.update).not.toHaveBeenCalled();
  });

  it("non-reporter non-assignee without bug:edit:any cannot drag", async () => {
    db.bug.findUnique.mockResolvedValue({
      id: "b-1", title: "Board bug", status: "NEW", reporterUserId: "u-someone-else", assigneeUserId: null,
    });
    const res = await moveBug("b-1", { status: "TRIAGED", order: 0 });
    expect(res.ok).toBe(false);
    expect(db.bug.update).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Board enhancement — linkBugToTask (Task ↔ Bug traceability)
// ---------------------------------------------------------------------------

describe("linkBugToTask", () => {
  it("links a bug to a task in the SAME project (ADMIN is unscoped)", async () => {
    requirePermissionMock.mockResolvedValue(ADMIN_AUTH);
    db.bug.findUnique.mockResolvedValue({
      id: "b-1", title: "Linkable bug", status: "NEW", reporterUserId: "u-qa", assigneeUserId: null, taskId: null, projectId: "p-1",
    });
    db.task.findUnique.mockResolvedValue({
      id: "t-1", title: "Target task", projectId: "p-1", assignee: { userId: "u-dev" },
    });
    const res = await linkBugToTask("b-1", { taskId: "t-1" });
    expect(res.ok).toBe(true);
    expect(db.bug.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { taskId: "t-1" } }),
    );
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "bug.linked" }),
    );
  });

  it("unlinks a bug (null taskId) and logs bug.unlinked", async () => {
    db.bug.findUnique.mockResolvedValue({
      id: "b-1", title: "Linked bug", status: "NEW", reporterUserId: "u-mia", assigneeUserId: null, taskId: "t-1", projectId: "p-1",
    });
    const res = await linkBugToTask("b-1", { taskId: null });
    expect(res.ok).toBe(true);
    expect(db.bug.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { taskId: null } }),
    );
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "bug.unlinked" }),
    );
  });

  it("rejects a task from a different project (project association rule)", async () => {
    db.bug.findUnique.mockResolvedValue({
      id: "b-1", title: "Linkable bug", status: "NEW", reporterUserId: "u-mia", assigneeUserId: null, taskId: null, projectId: "p-1",
    });
    db.task.findUnique.mockResolvedValue({
      id: "t-1", title: "Other project task", projectId: "p-2", assignee: { userId: "u-dev" },
    });
    const res = await linkBugToTask("b-1", { taskId: "t-1" });
    expect(res.ok).toBe(false);
    expect(db.bug.update).not.toHaveBeenCalled();
  });

  it("rejects linking on a legacy bug without a project", async () => {
    db.bug.findUnique.mockResolvedValue({
      id: "b-1", title: "Legacy bug", status: "NEW", reporterUserId: "u-mia", assigneeUserId: null, taskId: null, projectId: null,
    });
    db.task.findUnique.mockResolvedValue({
      id: "t-1", title: "Any task", projectId: "p-1", assignee: { userId: "u-dev" },
    });
    const res = await linkBugToTask("b-1", { taskId: "t-1" });
    expect(res.ok).toBe(false);
    expect(db.bug.update).not.toHaveBeenCalled();
  });

  it("rejects a same-project task the caller cannot see (scope still applies)", async () => {
    db.bug.findUnique.mockResolvedValue({
      id: "b-1", title: "Linkable bug", status: "NEW", reporterUserId: "u-mia", assigneeUserId: null, taskId: null, projectId: "p-hidden",
    });
    db.task.findUnique.mockResolvedValue({
      id: "t-1", title: "Hidden task", projectId: "p-hidden", assignee: { userId: "u-dev" },
    });
    getScopedProjectIdsMock.mockResolvedValue(new Set(["p-visible"]));
    const res = await linkBugToTask("b-1", { taskId: "t-1" });
    expect(res.ok).toBe(false);
    expect(db.bug.update).not.toHaveBeenCalled();
  });

  it("MEMBER cannot link to a task outside their scope", async () => {
    db.bug.findUnique.mockResolvedValue({
      id: "b-1", title: "Linkable bug", status: "NEW", reporterUserId: "u-mia", assigneeUserId: null, taskId: null, projectId: "p-visible",
    });
    db.task.findUnique.mockResolvedValue({
      id: "t-1", title: "Hidden task", projectId: "p-hidden", assignee: { userId: "u-dev" },
    });
    getScopedProjectIdsMock.mockResolvedValue(new Set(["p-visible"]));
    const res = await linkBugToTask("b-1", { taskId: "t-1" });
    expect(res.ok).toBe(false);
    expect(db.bug.update).not.toHaveBeenCalled();
  });

  it("MEMBER can link to a task in their scope", async () => {
    db.bug.findUnique.mockResolvedValue({
      id: "b-1", title: "Linkable bug", status: "NEW", reporterUserId: "u-mia", assigneeUserId: null, taskId: null, projectId: "p-visible",
    });
    db.task.findUnique.mockResolvedValue({
      id: "t-1", title: "Visible task", projectId: "p-visible", assignee: { userId: "u-dev" },
    });
    getScopedProjectIdsMock.mockResolvedValue(new Set(["p-visible"]));
    const res = await linkBugToTask("b-1", { taskId: "t-1" });
    expect(res.ok).toBe(true);
    expect(db.bug.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { taskId: "t-1" } }),
    );
  });

  it("rejects a non-existent task", async () => {
    db.bug.findUnique.mockResolvedValue({
      id: "b-1", title: "Linkable bug", status: "NEW", reporterUserId: "u-qa", assigneeUserId: null, taskId: null, projectId: "p-1",
    });
    db.task.findUnique.mockResolvedValue(null);
    const res = await linkBugToTask("b-1", { taskId: "t-missing" });
    expect(res.ok).toBe(false);
    expect(db.bug.update).not.toHaveBeenCalled();
  });

  it("non-editor cannot change the link", async () => {
    db.bug.findUnique.mockResolvedValue({
      id: "b-1", title: "Someone else's bug", status: "NEW", reporterUserId: "u-someone-else", assigneeUserId: null, taskId: null, projectId: "p-1",
    });
    const res = await linkBugToTask("b-1", { taskId: "t-1" });
    expect(res.ok).toBe(false);
    expect(db.bug.update).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Board enhancement — board data readers
// ---------------------------------------------------------------------------

describe("getBugBoard", () => {
  it("returns board items with resolved names", async () => {
    db.bug.findMany.mockResolvedValue([
      {
        id: "b-1", title: "Card bug", severity: "MAJOR", priority: "P2", status: "NEW",
        boardOrder: 0, resolution: null,
        reporterUserId: "u-qa", assigneeUserId: "u-dev", projectId: "p-1", taskId: "t-1",
        createdAt: new Date(), updatedAt: new Date(),
      },
    ]);
    db.user.findMany.mockResolvedValue([
      { id: "u-qa", name: "Quinn" },
      { id: "u-dev", name: "Dev" },
    ]);
    db.project.findMany.mockResolvedValue([{ id: "p-1", name: "Apollo" }]);
    db.task.findMany.mockResolvedValue([{ id: "t-1", title: "Tasky" }]);

    const res = await getBugBoard();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.items).toHaveLength(1);
    expect(res.data.items[0]).toMatchObject({
      reporterName: "Quinn", assigneeName: "Dev", projectName: "Apollo", taskTitle: "Tasky", order: 0,
    });
  });

  it("requires a signed-in session", async () => {
    getSessionMock.mockResolvedValue(null);
    const res = await getBugBoard();
    expect(res.ok).toBe(false);
  });
});

describe("getTaskLinkedBugs / getLinkableBugs", () => {
  it("getTaskLinkedBugs returns bugs for the task", async () => {
    db.bug.findMany.mockResolvedValue([
      { id: "b-1", title: "Linked", severity: "MAJOR", priority: "P1", status: "NEW", resolution: null },
    ]);
    const res = await getTaskLinkedBugs("t-1");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toHaveLength(1);
    expect(db.bug.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { taskId: "t-1" } }),
    );
  });

  it("getLinkableBugs scopes candidates to the task's project and excludes bugs already linked to THIS task", async () => {
    db.task.findUnique.mockResolvedValue({ projectId: "p-1" });
    db.bug.findMany.mockResolvedValue([]);
    const res = await getLinkableBugs("t-1", "");
    expect(res.ok).toBe(true);
    const where = db.bug.findMany.mock.calls[0][0].where;
    expect(where.projectId).toBe("p-1");
    expect(where.OR).toEqual([{ taskId: null }, { taskId: { not: "t-1" } }]);
  });

  it("getLinkableBugs applies the search filter on top of the project scope", async () => {
    db.task.findUnique.mockResolvedValue({ projectId: "p-1" });
    db.bug.findMany.mockResolvedValue([]);
    const res = await getLinkableBugs("t-1", "crash");
    expect(res.ok).toBe(true);
    const where = db.bug.findMany.mock.calls[0][0].where;
    expect(where.projectId).toBe("p-1");
    expect(where.title).toEqual({ contains: "crash", mode: "insensitive" });
  });

  it("getLinkableBugs returns [] for a task without a project (legacy rows)", async () => {
    db.task.findUnique.mockResolvedValue({ projectId: null });
    const res = await getLinkableBugs("t-1", "");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data).toEqual([]);
    expect(db.bug.findMany).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// PR-56 — remaining branch coverage. Each test below pins a specific
// statement in bugs.ts that the suites above never executed (verified via
// the v8 JSON statement map before writing them).
// ---------------------------------------------------------------------------

describe("PR-56 — remaining branch coverage", () => {
  // bugs.ts:98 — createBug with a taskId whose task row does not exist
  // (the "different project" fixture always found the task first).
  it("createBug rejects a non-existent linked task", async () => {
    db.task.findUnique.mockResolvedValue(null);
    const res = await createBug({ title: "Bad link", projectId: "p-1", taskId: "t-missing" });
    expect(res.ok).toBe(false);
    expect(res).toMatchObject({ code: "AUTH", error: "Task not found." });
    expect(db.bug.create).not.toHaveBeenCalled();
  });

  // bugs.ts:219-225 — getBug comments projection: the map callback never ran
  // before because every fixture used an empty comments array.
  it("getBug projects comments (id/author/body/ISO createdAt)", async () => {
    db.bug.findUnique.mockResolvedValue({
      id: "b-1", title: "Test", description: "desc",
      stepsToReproduce: "steps", expectedBehavior: "exp", actualBehavior: "act",
      severity: "MAJOR", priority: "P2", status: "NEW", resolution: null,
      reporterUserId: "u-qa", assigneeUserId: "u-dev",
      projectId: null, taskId: null, environment: "prod",
      createdAt: new Date(), updatedAt: new Date(),
      triagedAt: null, resolvedAt: null, closedAt: null,
      comments: [
        {
          id: "c-1", authorId: "u-qa", authorName: "Quinn",
          body: "Reproduced on staging", createdAt: new Date("2026-01-02T03:04:05.678Z"),
        },
      ],
    });
    db.user.findMany.mockResolvedValue([
      { id: "u-qa", name: "Quinn" },
      { id: "u-dev", name: "Deva" },
    ]);
    const res = await getBug("b-1");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.comments).toEqual([
      {
        id: "c-1", authorId: "u-qa", authorName: "Quinn",
        body: "Reproduced on staging", createdAt: "2026-01-02T03:04:05.678Z",
      },
    ]);
  });

  // bugs.ts:262 — getBugsPage with no signed-in session.
  it("getBugsPage requires a signed-in session", async () => {
    getSessionMock.mockResolvedValue(null);
    const res = await getBugsPage();
    expect(res.ok).toBe(false);
    expect(res).toMatchObject({ code: "AUTH", error: "You must be signed in." });
    expect(db.bug.findMany).not.toHaveBeenCalled();
  });

  // bugs.ts:277-280 — getBugsPage: the priority / assignee / reporter /
  // project filters (only status + severity were exercised before).
  it("getBugsPage applies priority/assignee/reporter/project filters", async () => {
    await getBugsPage({
      priority: "P1", assigneeUserId: "u-dev", reporterUserId: "u-qa", projectId: "p-1",
    });
    expect(db.bug.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          priority: "P1",
          assigneeUserId: "u-dev",
          reporterUserId: "u-qa",
          projectId: "p-1",
        }),
      }),
    );
  });

  // bugs.ts:308-309 + 320 — getBugsPage: rows carrying an assignee and a
  // project, so the bulk id-sets are populated AND the projectMap projection
  // runs against a non-empty project lookup (fixtures used null ids before).
  it("getBugsPage resolves assignee + project names in bulk", async () => {
    db.bug.findMany.mockResolvedValue([
      {
        id: "b-1", title: "Bug 1", severity: "MAJOR", priority: "P2", status: "NEW",
        reporterUserId: "u-qa", assigneeUserId: "u-dev", projectId: "p-1",
        createdAt: new Date(), updatedAt: new Date(),
      },
    ]);
    db.user.findMany.mockResolvedValue([
      { id: "u-qa", name: "Quinn" },
      { id: "u-dev", name: "Deva" },
    ]);
    db.project.findMany.mockResolvedValue([{ id: "p-1", name: "Apollo" }]);
    const res = await getBugsPage({ limit: 10 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.items[0]).toMatchObject({
      reporterName: "Quinn",
      assigneeName: "Deva",
      projectName: "Apollo",
    });
  });

  // bugs.ts:375 — updateBug: moving the bug to a project that does not exist
  // (getProjectAssociatedUserIds returns null on the NEW project id).
  it("updateBug rejects a project move to a non-existent project", async () => {
    db.bug.findUnique.mockResolvedValue({
      id: "b-1", title: "Old", reporterUserId: "u-mia", assigneeUserId: null, projectId: "p-1",
    });
    getProjectAssociatedUserIdsMock.mockResolvedValue(null);
    const res = await updateBug("b-1", { projectId: "p-ghost" });
    expect(res.ok).toBe(false);
    expect(res).toMatchObject({ code: "AUTH", error: "Project not found." });
    expect(getProjectAssociatedUserIdsMock).toHaveBeenCalledWith("p-ghost");
    expect(db.bug.update).not.toHaveBeenCalled();
  });

  // bugs.ts:394-400 — updateBug: every editable field assignment except
  // title/severity (only title + severity were patched before).
  it("updateBug patches description/steps/expected/actual/priority/environment", async () => {
    db.bug.findUnique.mockResolvedValue({
      id: "b-1", title: "Old title", description: "old desc", stepsToReproduce: "old steps",
      expectedBehavior: "old expected", actualBehavior: "old actual", severity: "MINOR",
      priority: "P3", environment: "dev", reporterUserId: "u-mia", assigneeUserId: null,
      projectId: "p-1",
    });
    const res = await updateBug("b-1", {
      description: "new desc",
      stepsToReproduce: "new steps",
      expectedBehavior: "new expected",
      actualBehavior: "new actual",
      priority: "P0",
      environment: "staging",
    });
    expect(res.ok).toBe(true);
    expect(db.bug.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "b-1" },
        data: expect.objectContaining({
          description: "new desc",
          stepsToReproduce: "new steps",
          expectedBehavior: "new expected",
          actualBehavior: "new actual",
          priority: "P0",
          environment: "staging",
        }),
      }),
    );
  });

  // bugs.ts:408-409 — updateBug audit trail: priority + description land in
  // the "changes" list (only title/severity entries were built before).
  it("updateBug lists priority + description in the audit change set", async () => {
    db.bug.findUnique.mockResolvedValue({
      id: "b-1", title: "Old title", description: "old desc", severity: "MINOR",
      priority: "P3", reporterUserId: "u-mia", assigneeUserId: null, projectId: "p-1",
    });
    const res = await updateBug("b-1", {
      title: "New title",
      description: "new desc",
      severity: "CRITICAL",
      priority: "P0",
    });
    expect(res.ok).toBe(true);
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "bug.updated",
        detail: "Updated bug (title, severity, priority, description)",
      }),
    );
  });

  // bugs.ts:432 — assignBug: the target bug does not exist.
  it("assignBug throws for a non-existent bug", async () => {
    requirePermissionMock.mockResolvedValue(ADMIN_AUTH);
    db.bug.findUnique.mockResolvedValue(null);
    const res = await assignBug("b-missing", "u-dev");
    expect(res.ok).toBe(false);
    expect(res).toMatchObject({ code: "AUTH", error: "Bug not found." });
    expect(db.bug.update).not.toHaveBeenCalled();
  });

  // bugs.ts:484 — changeBugStatus: the target bug does not exist.
  it("changeBugStatus throws for a non-existent bug", async () => {
    db.bug.findUnique.mockResolvedValue(null);
    const res = await changeBugStatus("b-missing", { status: "TRIAGED" });
    expect(res.ok).toBe(false);
    expect(res).toMatchObject({ code: "AUTH", error: "Bug not found." });
    expect(db.bug.update).not.toHaveBeenCalled();
  });

  // bugs.ts:510 — changeBugStatus: first transition INTO CLOSED stamps
  // closedAt (no prior test ever moved a bug to CLOSED).
  it("changeBugStatus NEW → CLOSED stamps closedAt and audits bug.closed", async () => {
    db.bug.findUnique.mockResolvedValue({
      id: "b-1", title: "Test", status: "NEW", reporterUserId: "u-mia", assigneeUserId: null,
      closedAt: null,
    });
    const res = await changeBugStatus("b-1", { status: "CLOSED" });
    expect(res.ok).toBe(true);
    expect(db.bug.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "CLOSED",
          resolution: null,
          closedAt: expect.any(Date),
        }),
      }),
    );
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "bug.closed" }),
    );
  });

  // bugs.ts:574 — addBugComment with no signed-in session.
  it("addBugComment requires a signed-in session", async () => {
    getSessionMock.mockResolvedValue(null);
    const res = await addBugComment({ bugId: "b-1", body: "hello" });
    expect(res.ok).toBe(false);
    expect(res).toMatchObject({ code: "AUTH", error: "You must be signed in." });
    expect(db.bugComment.create).not.toHaveBeenCalled();
  });

  // bugs.ts:642 — moveBug: the target bug does not exist.
  it("moveBug throws for a non-existent bug", async () => {
    db.bug.findUnique.mockResolvedValue(null);
    const res = await moveBug("b-missing", { status: "TRIAGED", order: 0 });
    expect(res.ok).toBe(false);
    expect(res).toMatchObject({ code: "AUTH", error: "Bug not found." });
    expect(db.bug.update).not.toHaveBeenCalled();
  });

  // bugs.ts:674 — moveBug: drag into CLOSED stamps closedAt (no prior test
  // dragged a bug into the CLOSED column).
  it("moveBug drag NEW → CLOSED stamps closedAt", async () => {
    db.bug.findUnique.mockResolvedValue({
      id: "b-1", title: "Board bug", status: "NEW", reporterUserId: "u-mia", assigneeUserId: null,
      closedAt: null, resolution: null,
    });
    const res = await moveBug("b-1", { status: "CLOSED", order: 2 });
    expect(res.ok).toBe(true);
    expect(db.bug.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "CLOSED",
          boardOrder: 2,
          resolution: null,
          closedAt: expect.any(Date),
        }),
      }),
    );
  });

  // bugs.ts:732 — linkBugToTask: the target bug does not exist.
  it("linkBugToTask throws for a non-existent bug", async () => {
    db.bug.findUnique.mockResolvedValue(null);
    const res = await linkBugToTask("b-missing", { taskId: "t-1" });
    expect(res.ok).toBe(false);
    expect(res).toMatchObject({ code: "AUTH", error: "Bug not found." });
    expect(db.bug.update).not.toHaveBeenCalled();
  });

  // bugs.ts:744 — linkBugToTask: the task lookup misses. The bug's reporter
  // matches the session so the earlier edit-permission check passes — the
  // pre-existing "non-existent task" fixture used a bug reported by u-qa and
  // therefore died at assertBugEditPermission before reaching this branch.
  it("linkBugToTask rejects a non-existent task (editable bug)", async () => {
    db.bug.findUnique.mockResolvedValue({
      id: "b-1", title: "Linkable bug", status: "NEW", reporterUserId: "u-mia", assigneeUserId: null,
      taskId: null, projectId: "p-1",
    });
    db.task.findUnique.mockResolvedValue(null);
    const res = await linkBugToTask("b-1", { taskId: "t-missing" });
    expect(res.ok).toBe(false);
    expect(res).toMatchObject({ code: "AUTH", error: "Task not found." });
    expect(db.bug.update).not.toHaveBeenCalled();
  });

  // bugs.ts:892 — getTaskLinkedBugs with no signed-in session.
  it("getTaskLinkedBugs requires a signed-in session", async () => {
    getSessionMock.mockResolvedValue(null);
    const res = await getTaskLinkedBugs("t-1");
    expect(res.ok).toBe(false);
    expect(res).toMatchObject({ code: "AUTH", error: "You must be signed in." });
    expect(db.bug.findMany).not.toHaveBeenCalled();
  });

  // bugs.ts:912 — getLinkableBugs with no signed-in session.
  it("getLinkableBugs requires a signed-in session", async () => {
    getSessionMock.mockResolvedValue(null);
    const res = await getLinkableBugs("t-1", "");
    expect(res.ok).toBe(false);
    expect(res).toMatchObject({ code: "AUTH", error: "You must be signed in." });
    expect(db.task.findUnique).not.toHaveBeenCalled();
  });
});
