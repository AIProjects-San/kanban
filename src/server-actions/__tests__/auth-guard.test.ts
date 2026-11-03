import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock the Better Auth session helper BEFORE importing the module under
// test. Since the PR-49 flip the repo default stack is "better", so
// auth-guard's getSession() resolves through getBetterSession().
// (Session normalisation — unknown-role downgrade, soft-delete guard — is
// pinned by src/lib/__tests__/auth-better.test.ts at the real seam.)
// ---------------------------------------------------------------------------

const { getBetterSession } = vi.hoisted(() => ({ getBetterSession: vi.fn() }));
vi.mock("@/lib/auth-better", () => ({
  getBetterSession,
  revokeUserSessions: vi.fn(),
}));

// Mock the Prisma client so `requirePermissionForTarget`'s DB reads
// (target lookup + subtree walk) return deterministic data.
const userFindUnique = vi.fn();
const userFindMany = vi.fn();
vi.mock("@/lib/db", () => ({
  db: {
    user: {
      findUnique: (...args: unknown[]) => userFindUnique(...args),
      findMany: (...args: unknown[]) => userFindMany(...args),
    },
  },
}));

// L-P0-7 — requirePermission now consults hasPermissionDb on top of the
// static matrix. Mock the config-loader so the DB-driven check is
// deterministic per test. Default: DB returns false.
const hasPermissionDbMock = vi.fn();
vi.mock("@/lib/config-loader", () => ({
  hasPermissionDb: (...args: unknown[]) => hasPermissionDbMock(...args),
}));

import {
  getSession,
  requirePermission,
  requirePermissionForTarget,
  getSessionOrThrow,
  AuthorizationError,
} from "@/server-actions/auth-guard";

const ADMIN_SESSION = {
  userId: "u-admin", role: "ADMIN", name: "Ada", email: "ada@example.com",
};
const MANAGER_SESSION = {
  userId: "u-mgr", role: "MANAGER", name: "Mia Manager", email: "mia@example.com",
};
const MEMBER_SESSION = {
  userId: "u-member", role: "MEMBER", name: "Mia", email: "mia@example.com",
};

describe("getSession", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns null when there is no session", async () => {
    getBetterSession.mockResolvedValue(null);
    expect(await getSession()).toBeNull();
  });

  it("delegates to getBetterSession and returns the resolved AuthResult unchanged", async () => {
    getBetterSession.mockResolvedValue(ADMIN_SESSION);
    const auth = await getSession();
    expect(auth).toEqual({
      userId: "u-admin",
      role: "ADMIN",
      name: "Ada",
      email: "ada@example.com",
    });
    expect(getBetterSession).toHaveBeenCalledTimes(1);
  });
});

describe("requirePermission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // L-P0-7 — default: DB returns false, so only the static floor grants.
    hasPermissionDbMock.mockResolvedValue(false);
  });

  it("throws AuthorizationError when not signed in", async () => {
    getBetterSession.mockResolvedValue(null);
    await expect(requirePermission("task:create")).rejects.toThrow(AuthorizationError);
    await expect(requirePermission("task:create")).rejects.toThrow(/signed in/i);
  });

  it("throws when the role lacks the permission", async () => {
    getBetterSession.mockResolvedValue(MEMBER_SESSION);
    await expect(requirePermission("role:manage")).rejects.toThrow(AuthorizationError);
    await expect(requirePermission("role:manage")).rejects.toThrow(/MEMBER/);
  });

  it("returns the auth context when the permission is granted", async () => {
    getBetterSession.mockResolvedValue(MEMBER_SESSION);
    const auth = await requirePermission("task:edit:own");
    expect(auth.userId).toBe("u-member");
  });

  // -------------------------------------------------------------------------
  // L-P0-7 — DB-driven RBAC enforcement.
  // -------------------------------------------------------------------------

  it("L-P0-7: floor holds — static permission is granted even if DB revokes it", async () => {
    getBetterSession.mockResolvedValue(MEMBER_SESSION);
    hasPermissionDbMock.mockResolvedValue(false);
    const auth = await requirePermission("task:edit:own");
    expect(auth.userId).toBe("u-member");
    // The DB check is NOT consulted for floor perms — the static matrix
    // short-circuits to true.
    expect(hasPermissionDbMock).not.toHaveBeenCalled();
  });

  it("L-P0-7: DB grants extra — a permission the static matrix denies is granted via DB", async () => {
    getBetterSession.mockResolvedValue(MEMBER_SESSION);
    hasPermissionDbMock.mockResolvedValue(true);
    const auth = await requirePermission("audit:view");
    expect(auth.userId).toBe("u-member");
    expect(hasPermissionDbMock).toHaveBeenCalledWith("MEMBER", "audit:view");
  });

  it("L-P0-7: DB revocation no-op for floor perms — ADMIN keeps role:manage regardless of DB", async () => {
    getBetterSession.mockResolvedValue(ADMIN_SESSION);
    hasPermissionDbMock.mockResolvedValue(false);
    const auth = await requirePermission("role:manage");
    expect(auth.userId).toBe("u-admin");
  });

  it("L-P0-7: DB failure falls back to static-only (deny-by-default)", async () => {
    getBetterSession.mockResolvedValue(MEMBER_SESSION);
    hasPermissionDbMock.mockRejectedValue(new Error("DB connection lost"));
    await expect(requirePermission("audit:view")).rejects.toThrow(AuthorizationError);
  });

  it("L-P0-7: DB failure does NOT revoke floor perms (static floor still holds)", async () => {
    getBetterSession.mockResolvedValue(MEMBER_SESSION);
    hasPermissionDbMock.mockRejectedValue(new Error("DB connection lost"));
    const auth = await requirePermission("task:edit:own");
    expect(auth.userId).toBe("u-member");
  });
});

describe("getSessionOrThrow", () => {
  beforeEach(() => vi.clearAllMocks());

  it("throws for anonymous callers", async () => {
    getBetterSession.mockResolvedValue(null);
    await expect(getSessionOrThrow()).rejects.toThrow(AuthorizationError);
  });

  it("returns the session for signed-in callers of any role", async () => {
    getBetterSession.mockResolvedValue(MEMBER_SESSION);
    const auth = await getSessionOrThrow();
    expect(auth.userId).toBe("u-member");
  });
});

describe("AuthorizationError", () => {
  it("carries a stable name for client-side detection", () => {
    const err = new AuthorizationError("nope");
    expect(err.name).toBe("AuthorizationError");
    expect(err.message).toBe("nope");
    expect(err instanceof Error).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// requirePermissionForTarget — hierarchy-aware permission gate.
// Verifies that the standard role check is followed by a hierarchy check
// using the manager-chain. Mocks the DB so we can drive each scenario.
// ---------------------------------------------------------------------------

describe("requirePermissionForTarget", () => {
  beforeEach(() => vi.clearAllMocks());

  it("throws if the role lacks the permission (skips hierarchy check)", async () => {
    getBetterSession.mockResolvedValue(MEMBER_SESSION);
    // MEMBER doesn't have role:manage — should reject before any DB read.
    await expect(
      requirePermissionForTarget("role:manage", "u-other"),
    ).rejects.toThrow(AuthorizationError);
    expect(userFindUnique).not.toHaveBeenCalled();
  });

  it("MANAGER is also rejected by the role check for role:manage (admin-only perm)", async () => {
    // role:manage is ADMIN-only in the current RBAC matrix, so MANAGERs
    // never reach the hierarchy layer for user-CRUD actions. This is
    // intentional: the hierarchy foundation is in place for any future
    // permission that expands MANAGERs' scope (see lib/hierarchy.ts →
    // canManageUser for the predicate that would apply).
    getBetterSession.mockResolvedValue(MANAGER_SESSION);
    await expect(
      requirePermissionForTarget("role:manage", "u-other"),
    ).rejects.toThrow(/does not have permission/);
    expect(userFindUnique).not.toHaveBeenCalled();
  });

  it("passes for self-targeted calls (self-management, no DB lookup)", async () => {
    getBetterSession.mockResolvedValue(ADMIN_SESSION);
    // Target == actor → no DB lookup needed.
    const auth = await requirePermissionForTarget("role:manage", "u-admin");
    expect(auth.userId).toBe("u-admin");
    expect(userFindUnique).not.toHaveBeenCalled();
  });

  it("throws when the target user does not exist", async () => {
    getBetterSession.mockResolvedValue(ADMIN_SESSION);
    userFindUnique.mockResolvedValue(null);
    await expect(
      requirePermissionForTarget("role:manage", "u-ghost"),
    ).rejects.toThrow(/User not found/);
  });

  it("ADMIN passes for any target (subtree is not consulted)", async () => {
    getBetterSession.mockResolvedValue(ADMIN_SESSION);
    userFindUnique.mockResolvedValue({
      id: "u-other", role: "MEMBER", managerId: "u-someone-else",
    });
    // For admins, getSubtreeUserIds is short-circuited in requirePermissionForTarget,
    // so userFindMany (subtree BFS) must NOT be called.
    const auth = await requirePermissionForTarget("role:manage", "u-other");
    expect(auth.userId).toBe("u-admin");
    expect(userFindMany).not.toHaveBeenCalled();
  });

  it("exercises the hierarchy path when MANAGER has the requested permission", async () => {
    // Use `analytics:view` (which MANAGERs DO have) to drive the
    // hierarchy check end-to-end. The target is in the manager's
    // subtree → the call should pass.
    getBetterSession.mockResolvedValue(MANAGER_SESSION);
    userFindUnique.mockResolvedValueOnce({
      id: "u-report", role: "MEMBER", managerId: "u-mgr",
    });
    // Subtree BFS: the actor's findMany returns their direct reports;
    // subsequent calls return empty (no deeper level).
    userFindMany.mockResolvedValueOnce([{ id: "u-report" }]);
    userFindMany.mockResolvedValue([]);

    const auth = await requirePermissionForTarget("analytics:view", "u-report");
    expect(auth.userId).toBe("u-mgr");
    // The target lookup happened (otherwise we couldn't have checked).
    expect(userFindUnique).toHaveBeenCalled();
  });

  it("rejects at the hierarchy layer when a permitted MANAGER targets a non-report", async () => {
    getBetterSession.mockResolvedValue(MANAGER_SESSION);
    userFindUnique.mockResolvedValueOnce({
      id: "u-peer-rep", role: "MEMBER", managerId: "u-mgr-2",
    });
    // The actor's subtree is empty — u-peer-rep is not in it.
    userFindMany.mockResolvedValueOnce([]);

    await expect(
      requirePermissionForTarget("analytics:view", "u-peer-rep"),
    ).rejects.toThrow(/reporting chain/i);
  });
});
