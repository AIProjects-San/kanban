import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// PR-35 (production-readiness round 2) — wiring test.
//
// The HIBP client itself is unit-tested in lib/__tests__/breach-check.test.ts
// (this file must NOT mock the module under another name — a file-level
// vi.mock would hijack that suite's import too, which is why the wiring
// tests live here instead).
//
// What this file pins: every password-SET flow consults the
// assertPasswordNotBreached guard, and a breach rejection aborts BEFORE any
// DB write (never hash, store, or audit a password we are about to reject).
// changePassword is the exemplar; the other three sites (createUser,
// updateUser resetPassword, completePasswordReset) share the call shape.
// ---------------------------------------------------------------------------

const { db, getBetterSession, assertSpy } = vi.hoisted(() => {
  const getBetterSession = vi.fn();
  const models = ["user", "auditLog", "passwordResetToken", "teamMember"];
  const methods = [
    "findMany", "findUnique", "findFirst", "create", "createMany", "update",
    "updateMany", "delete", "deleteMany", "upsert", "count", "aggregate",
  ];
  const db: Record<string, Record<string, ReturnType<typeof vi.fn>>> = {};
  for (const m of models) {
    db[m] = {};
    for (const meth of methods) db[m][meth] = vi.fn();
  }
  (db as Record<string, unknown>).$transaction = vi.fn(
    async (fn: (tx: unknown) => Promise<unknown> | unknown[]) =>
      typeof fn === "function" ? fn(db) : Promise.all(fn as unknown[]),
  );
  return { db, getBetterSession, assertSpy: vi.fn(async (_pw: string) => undefined) };
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
vi.mock("@/lib/breach-check", () => ({
  assertPasswordNotBreached: (pw: string) => assertSpy(pw),
  checkPasswordBreach: vi.fn(async () => ({ breached: false, checked: false })),
  isBreachCheckEnabled: vi.fn(() => false),
  BREACH_REJECTION_MESSAGE: "This password appears in a public data-breach list",
}));

import { changePassword, createUser, updateUser } from "@/server-actions/users";

const ADMIN_SESSION = {
  userId: "admin-1", email: "mira@fernly.app", name: "Mira Hale", role: "ADMIN",
};

async function realHashFor(password: string): Promise<string> {
  const bcrypt = (await import("bcryptjs")).default;
  return bcrypt.hashSync(password, 4);
}

describe("PR-35 wiring — password-SET flows consult the breach guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getBetterSession.mockResolvedValue(ADMIN_SESSION);
  });

  it("changePassword guards the NEW password before hashing", async () => {
    db.user.findUnique.mockResolvedValue({
      id: "admin-1",
      email: "mira@fernly.app",
      name: "Mira Hale",
      passwordHash: await realHashFor("current-password-1"),
    });
    await changePassword({
      userId: "admin-1",
      currentPassword: "current-password-1",
      newPassword: "fresh-pass-2026",
    });
    expect(assertSpy).toHaveBeenCalledWith("fresh-pass-2026");
    expect(db.user.update).toHaveBeenCalled();
  });

  it("changePassword aborts before any DB write when the guard rejects", async () => {
    assertSpy.mockRejectedValueOnce(
      Object.assign(
        new Error("This password appears in a public data-breach list and cannot be used."),
        { name: "ValidationError" },
      ),
    );
    db.user.findUnique.mockResolvedValue({
      id: "admin-1",
      email: "mira@fernly.app",
      name: "Mira Hale",
      passwordHash: await realHashFor("current-password-1"),
    });
    const res = await changePassword({
      userId: "admin-1",
      currentPassword: "current-password-1",
      newPassword: "breached-pass",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/data-breach list/);
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it("createUser guards the admin-chosen initial password", async () => {
    db.user.findUnique.mockResolvedValue(null); // email free
    db.teamMember.findUnique.mockResolvedValue(null);
    db.user.create.mockResolvedValue({
      id: "new-1", email: "new@fernly.app", name: "New User", role: "MEMBER",
    });
    db.teamMember.create.mockResolvedValue({});
    const res = await createUser({
      email: "new@fernly.app",
      name: "New User",
      password: "initial-pass-123",
      role: "MEMBER",
    });
    if (!res.ok) throw new Error(`unexpected failure: ${res.error}`);
    expect(assertSpy).toHaveBeenCalledWith("initial-pass-123");
    expect(db.user.create).toHaveBeenCalled();
  });

  it("updateUser guards the admin-forced reset password", async () => {
    db.user.findUnique.mockResolvedValue({
      id: "u-9",
      email: "u9@fernly.app",
      name: "User Nine",
      role: "MEMBER",
      timezone: "Pacific/Auckland",
      bio: "",
      avatarColor: "forest",
      managerId: null,
      deletedAt: null,
    });
    db.user.update.mockResolvedValue({});
    db.teamMember.updateMany.mockResolvedValue({ count: 0 });
    const res = await updateUser("u-9", { resetPassword: "forced-reset-1" });
    if (!res.ok) throw new Error(`unexpected failure: ${res.error}`);
    expect(assertSpy).toHaveBeenCalledWith("forced-reset-1");
    expect(db.user.update).toHaveBeenCalled();
  });
});
