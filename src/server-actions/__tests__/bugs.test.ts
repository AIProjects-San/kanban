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

vi.mock("@/lib/db", () => ({ db }));

const getSessionMock = vi.fn();
const requirePermissionMock = vi.fn();
vi.mock("@/server-actions/auth-guard", () => ({
  getSession: () => getSessionMock(),
  requirePermission: (...a: unknown[]) => requirePermissionMock(...a),
  AuthorizationError: class AuthorizationError extends Error {
    readonly digest = "AuthorizationError";
    constructor(m: string) { super(m); this.name = "AuthorizationError"; }
  },
}));

const logAuditMock = vi.fn();
vi.mock("@/server-actions/shared", () => ({
  logAudit: (...a: unknown[]) => logAuditMock(...a),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import {
  createBug, getBug, getBugsPage, updateBug, assignBug,
  changeBugStatus, addBugComment, deleteBug,
} from "../bugs";

const ADMIN_AUTH = { userId: "u-admin", role: "ADMIN" as const, name: "Ada", email: "ada@x.co" };
const MEMBER_AUTH = { userId: "u-mia", role: "MEMBER" as const, name: "Mia", email: "mia@x.co" };
const QA_AUTH = { userId: "u-qa", role: "MEMBER" as const, name: "Quinn", email: "quinn@x.co" };

beforeEach(() => {
  vi.clearAllMocks();
  getSessionMock.mockResolvedValue(MEMBER_AUTH);
  requirePermissionMock.mockResolvedValue(MEMBER_AUTH);
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
});

// ---------------------------------------------------------------------------
// createBug
// ---------------------------------------------------------------------------

describe("createBug", () => {
  it("creates a bug with defaults (NEW status, MAJOR severity, P2 priority)", async () => {
    requirePermissionMock.mockResolvedValue(QA_AUTH);
    const res = await createBug({ title: "Login broken" });
    expect(res.ok).toBe(true);
    expect(db.bug.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          title: "Login broken",
          status: "NEW",
          severity: "MAJOR",
          priority: "P2",
          reporterUserId: "u-qa",
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
    const res = await createBug({ title: "Crash", severity: "CRITICAL", priority: "P0" });
    expect(res.ok).toBe(true);
    expect(db.bug.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ severity: "CRITICAL", priority: "P0" }),
      }),
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
    await createBug({ title: "Test" });
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
      id: "b-1", title: "Old", reporterUserId: "u-qa", assigneeUserId: "u-dev",
    });
    const res = await updateBug("b-1", { title: "Admin edit" });
    expect(res.ok).toBe(true);
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
  it("assigns to a valid user", async () => {
    requirePermissionMock.mockResolvedValue(ADMIN_AUTH);
    db.bug.findUnique.mockResolvedValue({ id: "b-1", title: "Test" });
    db.user.findUnique.mockResolvedValue({ name: "Deva" });
    const res = await assignBug("b-1", "u-dev");
    expect(res.ok).toBe(true);
    expect(db.bug.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "b-1" }, data: { assigneeUserId: "u-dev" } }),
    );
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "bug.assigned", detail: expect.stringContaining("Deva") }),
    );
  });

  it("unassigns (null assignee)", async () => {
    requirePermissionMock.mockResolvedValue(ADMIN_AUTH);
    db.bug.findUnique.mockResolvedValue({ id: "b-1", title: "Test" });
    const res = await assignBug("b-1", null);
    expect(res.ok).toBe(true);
    expect(db.bug.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { assigneeUserId: null } }),
    );
  });

  it("rejects non-existent assignee", async () => {
    requirePermissionMock.mockResolvedValue(ADMIN_AUTH);
    db.bug.findUnique.mockResolvedValue({ id: "b-1", title: "Test" });
    db.user.findUnique.mockResolvedValue(null);
    const res = await assignBug("b-1", "u-ghost");
    expect(res.ok).toBe(false);
  });

  it("rejects soft-deleted assignee", async () => {
    requirePermissionMock.mockResolvedValue(ADMIN_AUTH);
    db.bug.findUnique.mockResolvedValue({ id: "b-1", title: "Test" });
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
