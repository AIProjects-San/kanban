import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// PR-38 (production-readiness round 2) — right-to-erasure hard erase.
//
// eraseUser permanently removes a SOFT-DELETED user: audit evidence row
// (inside the transaction), roster PII scrub, message display-name
// anonymisation, account-row delete. Guardrails under test:
//   • ADMIN-only, never yourself, trash-first (two-step safety)
//   • the audit row is written INSIDE the tx (no misleading row on failure)
//   • the audit row must not itself leak the erased email
// ---------------------------------------------------------------------------

const db = vi.hoisted(() => {
  const models = ["user", "teamMember", "message", "auditLog", "notification"];
  const methods = [
    "findUnique", "findMany", "findFirst", "create", "createMany", "update",
    "updateMany", "delete", "deleteMany", "count",
  ];
  const obj: Record<string, Record<string, ReturnType<typeof vi.fn>>> = {};
  for (const m of models) {
    obj[m] = {};
    for (const meth of methods) obj[m][meth] = vi.fn();
  }
  (obj as Record<string, unknown>).$transaction = vi.fn(
    async (fn: (tx: unknown) => Promise<unknown>) =>
      typeof fn === "function" ? fn(obj) : Promise.all(fn as unknown[]),
  );
  return obj;
});

vi.mock("@/lib/infra/db", () => ({ db }));

const requirePermissionMock = vi.fn();
const getSessionMock = vi.fn();
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
  
  requirePermissionForTarget: vi.fn(),
  AuthorizationError: class AuthorizationError extends Error {
    readonly digest = "AuthorizationError";
    constructor(m: string) {
      super(m);
      this.name = "AuthorizationError";
    }
  },
  };
});

const logAuditMock = vi.fn();
vi.mock("@/server-actions/shared", () => ({
  logAudit: (...a: unknown[]) => logAuditMock(...a),
  getScopedProjectIds: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { eraseUser } from "../trash";

const ADMIN = { userId: "u-admin", role: "ADMIN" as const, name: "Mira", email: "mira@x.co" };
const OTHER_ADMIN = { userId: "u-admin2", role: "ADMIN" as const, name: "Nadia", email: "nadia@x.co" };
const MANAGER = { userId: "u-mgr", role: "MANAGER" as const, name: "Ingrid", email: "ingrid@x.co" };

const SOFT_DELETED = {
  id: "u-oli",
  name: "Oli",
  email: "Oli@X.co",
  deletedAt: new Date("2026-10-30"),
};

beforeEach(() => {
  vi.clearAllMocks();
  requirePermissionMock.mockResolvedValue(ADMIN);
  getSessionMock.mockResolvedValue(ADMIN);
  db.user.findUnique.mockResolvedValue(SOFT_DELETED);
  db.user.delete.mockResolvedValue({});
  db.teamMember.deleteMany.mockResolvedValue({ count: 1 });
  db.message.updateMany.mockResolvedValue({ count: 0 });
  db.auditLog.create.mockResolvedValue({});
});

describe("PR-38 eraseUser (right-to-erasure)", () => {
  it("erases a soft-deleted user: audit row + roster scrub + anonymise + delete, in one tx", async () => {
    const res = await eraseUser("u-oli");
    expect(res.ok).toBe(true);

    expect(db.$transaction).toHaveBeenCalledTimes(1);

    // Evidence-first: the audit row is created inside the transaction.
    expect(db.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "user.erased",
          entityType: "USER",
          entityId: "u-oli",
          actorId: "u-admin",
          actorRole: "ADMIN",
        }),
      }),
    );

    // Roster PII scrubbed by stable link AND by (lowercased) email.
    expect(db.teamMember.deleteMany).toHaveBeenCalledWith({
      where: { OR: [{ userId: "u-oli" }, { email: "oli@x.co" }] },
    });

    // Display identity anonymised on both sides of conversations.
    expect(db.message.updateMany).toHaveBeenCalledWith({
      where: { senderUserId: "u-oli" },
      data: { senderName: "Erased user", senderRole: "" },
    });
    expect(db.message.updateMany).toHaveBeenCalledWith({
      where: { recipientUserId: "u-oli" },
      data: { recipientName: "Erased user" },
    });

    // The account row itself is gone.
    expect(db.user.delete).toHaveBeenCalledWith({ where: { id: "u-oli" } });
  });

  it("the audit row does not leak the erased email (entityLabel is the id prefix)", async () => {
    await eraseUser("u-oli");
    const call = db.auditLog.create.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(JSON.stringify(call.data)).not.toContain("oli@x.co");
    expect(call.data.entityLabel).toBe("u-oli".slice(0, 10));
  });

  it("rejects a non-admin even when they hold role:manage (irreversible = admin-only)", async () => {
    requirePermissionMock.mockResolvedValue(MANAGER);
    const res = await eraseUser("u-oli");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/Only administrators/);
    expect(db.user.delete).not.toHaveBeenCalled();
  });

  it("rejects erasing yourself", async () => {
    requirePermissionMock.mockResolvedValue(ADMIN);
    const res = await eraseUser("u-admin");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/own account/);
  });

  it("refuses to erase a user who is not already in the trash (two-step safety)", async () => {
    db.user.findUnique.mockResolvedValue({ ...SOFT_DELETED, deletedAt: null });
    const res = await eraseUser("u-oli");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/Soft-delete them first/);
    expect(db.user.delete).not.toHaveBeenCalled();
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });

  it("returns a clean error for an unknown id", async () => {
    db.user.findUnique.mockResolvedValue(null);
    const res = await eraseUser("ghost");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/not found/i);
  });

  it("another admin CAN erase (the self-block is per-actor, not global)", async () => {
    requirePermissionMock.mockResolvedValue(OTHER_ADMIN);
    const res = await eraseUser("u-oli");
    expect(res.ok).toBe(true);
    expect(db.user.delete).toHaveBeenCalled();
  });

  it("a transaction failure surfaces as a masked error (no partial erase, no leakage)", async () => {
    db.user.delete.mockRejectedValue(new Error("fk violation"));
    const res = await eraseUser("u-oli");
    expect(res.ok).toBe(false);
    // toResult masks unexpected errors — the operator sees a generic message,
    // the raw Prisma error never crosses the action boundary.
    if (!res.ok) expect(res.error).not.toMatch(/fk violation/i);
  });
});
