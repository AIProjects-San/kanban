import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock next-auth's getServerSession BEFORE importing the module under test.
// ---------------------------------------------------------------------------

const getServerSession = vi.fn();
vi.mock("next-auth", () => ({
  getServerSession: (...args: unknown[]) => getServerSession(...args),
}));

import {
  getSession,
  requirePermission,
  getSessionOrThrow,
  AuthorizationError,
} from "@/server-actions/auth-guard";

const ADMIN_SESSION = {
  user: { id: "u-admin", role: "ADMIN", name: "Ada", email: "ada@example.com" },
};
const MEMBER_SESSION = {
  user: { id: "u-member", role: "MEMBER", name: "Mia", email: "mia@example.com" },
};

describe("getSession", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns null when there is no session", async () => {
    getServerSession.mockResolvedValue(null);
    expect(await getSession()).toBeNull();
  });

  it("returns null when the session has no user id", async () => {
    getServerSession.mockResolvedValue({ user: { name: "Ghost" } });
    expect(await getSession()).toBeNull();
  });

  it("normalises a valid session", async () => {
    getServerSession.mockResolvedValue(ADMIN_SESSION);
    const auth = await getSession();
    expect(auth).toEqual({
      userId: "u-admin",
      role: "ADMIN",
      name: "Ada",
      email: "ada@example.com",
    });
  });

  it("downgrades an unknown role string to MEMBER (deny-by-default)", async () => {
    getServerSession.mockResolvedValue({
      user: { id: "u-x", role: "SUPERUSER", name: "X", email: "x@example.com" },
    });
    const auth = await getSession();
    expect(auth?.role).toBe("MEMBER");
  });
});

describe("requirePermission", () => {
  beforeEach(() => vi.clearAllMocks());

  it("throws AuthorizationError when not signed in", async () => {
    getServerSession.mockResolvedValue(null);
    await expect(requirePermission("task:create")).rejects.toThrow(AuthorizationError);
    await expect(requirePermission("task:create")).rejects.toThrow(/signed in/i);
  });

  it("throws when the role lacks the permission", async () => {
    getServerSession.mockResolvedValue(MEMBER_SESSION);
    await expect(requirePermission("role:manage")).rejects.toThrow(AuthorizationError);
    await expect(requirePermission("role:manage")).rejects.toThrow(/MEMBER/);
  });

  it("returns the auth context when the permission is granted", async () => {
    getServerSession.mockResolvedValue(MEMBER_SESSION);
    const auth = await requirePermission("task:edit:own");
    expect(auth.userId).toBe("u-member");
  });
});

describe("getSessionOrThrow", () => {
  beforeEach(() => vi.clearAllMocks());

  it("throws for anonymous callers", async () => {
    getServerSession.mockResolvedValue(null);
    await expect(getSessionOrThrow()).rejects.toThrow(AuthorizationError);
  });

  it("returns the session for signed-in callers of any role", async () => {
    getServerSession.mockResolvedValue(MEMBER_SESSION);
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
