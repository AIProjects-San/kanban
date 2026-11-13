import { describe, it, expect, vi, beforeEach } from "vitest";

// PR-56 — the owner-resolution branches of project CRUD. The happy paths
// (no owner) were covered indirectly; the TeamMember-lookup branches
// (create with an owner, owner reassignment on update, soft-deleted owner
// rejection) had no coverage — 71% statements before this suite.

const db = vi.hoisted(() => {
  const models = ["project", "teamMember"];
  const methods = ["findUnique", "findFirst", "findMany", "create", "update", "updateMany", "delete", "deleteMany", "count"];
  const obj: Record<string, Record<string, ReturnType<typeof vi.fn>>> = {};
  for (const m of models) {
    obj[m] = {};
    for (const meth of methods) obj[m][meth] = vi.fn();
  }
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
  AuthorizationError,
  };
});

const logAuditMock = vi.fn();
vi.mock("@/server-actions/shared", () => ({
  logAudit: (...a: unknown[]) => logAuditMock(...a),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { createProject, updateProject, deleteProject } from "../projects";

const ADMIN_AUTH = { userId: "u-admin", role: "ADMIN" as const, name: "Admin", email: "a@x.co" };

const OWNER_MEMBER = {
  id: "tm-1",
  name: "Ada Lovelace",
  userId: "u-ada",
  deletedAt: null,
};

const EXISTING_PROJECT = {
  id: "p-1",
  name: "Old name",
  description: "old",
  status: "RUNNING",
  priority: "MEDIUM",
  color: "forest",
  dueDate: null,
  ownerName: "",
  ownerUserId: null,
  progress: 0,
  deletedAt: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  requirePermissionMock.mockResolvedValue(ADMIN_AUTH);
});

describe("createProject — owner resolution (PR-56)", () => {
  it("creates without an owner when ownerMemberId is absent", async () => {
    db.project.create.mockResolvedValue({ id: "p-new", name: "No owner" });
    const res = await createProject({ name: "No owner" });
    expect(res.ok).toBe(true);
    // No TeamMember lookup happened.
    expect(db.teamMember.findUnique).not.toHaveBeenCalled();
    const data = db.project.create.mock.calls[0][0].data;
    expect(data.ownerName).toBe("");
    expect(data.ownerUserId).toBeNull();
  });

  it("resolves the owner's stable user id + display name from the roster", async () => {
    db.teamMember.findUnique.mockResolvedValue(OWNER_MEMBER);
    db.project.create.mockResolvedValue({ id: "p-new", name: "Owned" });
    const res = await createProject({ name: "Owned", ownerMemberId: "tm-1" });
    expect(res.ok).toBe(true);
    // The roster lookup filters soft-deleted members.
    expect(db.teamMember.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "tm-1", deletedAt: null },
        select: { name: true, userId: true },
      }),
    );
    const data = db.project.create.mock.calls[0][0].data;
    expect(data.ownerName).toBe("Ada Lovelace");
    expect(data.ownerUserId).toBe("u-ada");
    // Audit row records the created project.
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "project.created", entityId: "p-new" }),
    );
  });

  it("rejects an owner id that is not on the (non-deleted) roster", async () => {
    db.teamMember.findUnique.mockResolvedValue(null);
    const res = await createProject({ name: "X", ownerMemberId: "tm-ghost" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("VALIDATION");
    expect(res.error).toContain("not a team member");
    // No project row was written.
    expect(db.project.create).not.toHaveBeenCalled();
  });
});

describe("updateProject — owner reassignment (PR-56)", () => {
  it("reassigns the owner to a valid roster member", async () => {
    db.project.findUnique.mockResolvedValue(EXISTING_PROJECT);
    db.teamMember.findUnique.mockResolvedValue(OWNER_MEMBER);
    db.project.update.mockResolvedValue({ ...EXISTING_PROJECT, name: "Renamed" });
    const res = await updateProject("p-1", { ownerMemberId: "tm-1", name: "Renamed" });
    expect(res.ok).toBe(true);
    expect(db.teamMember.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "tm-1", deletedAt: null },
        select: { name: true, userId: true },
      }),
    );
    const data = db.project.update.mock.calls[0][0].data;
    expect(data.ownerName).toBe("Ada Lovelace");
    expect(data.ownerUserId).toBe("u-ada");
    // The change list mentions name + owner.
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "project.updated",
        detail: expect.stringContaining("name, owner"),
      }),
    );
  });

  it("clears the owner when ownerMemberId is an empty string", async () => {
    db.project.findUnique.mockResolvedValue({ ...EXISTING_PROJECT, ownerUserId: "u-old", ownerName: "Old Owner" });
    db.project.update.mockResolvedValue(EXISTING_PROJECT);
    const res = await updateProject("p-1", { ownerMemberId: "" });
    expect(res.ok).toBe(true);
    const data = db.project.update.mock.calls[0][0].data;
    expect(data.ownerName).toBe("");
    expect(data.ownerUserId).toBeNull();
  });

  it("keeps the owner untouched when ownerMemberId is not in the patch", async () => {
    db.project.findUnique.mockResolvedValue(EXISTING_PROJECT);
    db.project.update.mockResolvedValue(EXISTING_PROJECT);
    const res = await updateProject("p-1", { name: "Just a rename" });
    expect(res.ok).toBe(true);
    expect(db.teamMember.findUnique).not.toHaveBeenCalled();
    const data = db.project.update.mock.calls[0][0].data;
    expect(data.ownerName).toBeUndefined();
    expect(data.ownerUserId).toBeUndefined();
  });

  it("rejects reassignment to a soft-deleted / unknown member", async () => {
    db.project.findUnique.mockResolvedValue(EXISTING_PROJECT);
    db.teamMember.findUnique.mockResolvedValue(null);
    const res = await updateProject("p-1", { ownerMemberId: "tm-gone" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("VALIDATION");
    expect(res.error).toContain("not a team member");
    expect(db.project.update).not.toHaveBeenCalled();
  });

  it("is a clean no-op when the project does not exist", async () => {
    db.project.findUnique.mockResolvedValue(null);
    const res = await updateProject("p-missing", { name: "X" });
    expect(res.ok).toBe(true);
    expect(db.project.update).not.toHaveBeenCalled();
  });

  it("lists status, priority and color changes in the audit detail (L123-125)", async () => {
    db.project.findUnique.mockResolvedValue(EXISTING_PROJECT);
    db.project.update.mockResolvedValue(EXISTING_PROJECT);
    const res = await updateProject("p-1", {
      status: "PAUSED",
      priority: "HIGH",
      color: "ocean",
    });
    expect(res.ok).toBe(true);
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "project.updated",
        detail: expect.stringContaining("status, priority, color"),
      }),
    );
  });

  it("writes the no-change audit arm when the patch matches the existing values", async () => {
    db.project.findUnique.mockResolvedValue(EXISTING_PROJECT);
    db.project.update.mockResolvedValue(EXISTING_PROJECT);
    const res = await updateProject("p-1", { name: "Old name" });
    expect(res.ok).toBe(true);
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "project.updated",
        detail: expect.stringMatching(/^Saved project /),
      }),
    );
  });
});

describe("deleteProject — soft delete (PR-56)", () => {
  it("soft-deletes (sets deletedAt) and preserves tasks", async () => {
    db.project.findUnique.mockResolvedValue(EXISTING_PROJECT);
    db.project.update.mockResolvedValue({ ...EXISTING_PROJECT, deletedAt: new Date() });
    const res = await deleteProject("p-1");
    expect(res.ok).toBe(true);
    const args = db.project.update.mock.calls[0][0];
    expect(args.where).toEqual({ id: "p-1" });
    expect(args.data.deletedAt).toBeInstanceOf(Date);
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "project.deleted", entityId: "p-1" }),
    );
  });

  it("is a clean no-op when the project does not exist", async () => {
    db.project.findUnique.mockResolvedValue(null);
    const res = await deleteProject("p-missing");
    expect(res.ok).toBe(true);
    expect(db.project.update).not.toHaveBeenCalled();
  });
});
