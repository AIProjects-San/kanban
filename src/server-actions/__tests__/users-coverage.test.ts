import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// PR-56-U — branch-coverage suite for src/server-actions/users.ts.
//
// The main suites exercise users.ts through the data.ts re-exports
// (data.test.ts / data-crud.test.ts / data-branches.test.ts) and directly
// (breach-wiring.test.ts), but they leave a set of branches unexecuted:
// anonymous-session guards, not-found no-op throws, password length
// ceilings, hierarchy/self-protection guards, the managerId sync branches,
// and the whole signOutAllDevices action (no other suite calls it). Each
// test below pins exactly one of those branches — see the per-test comments.
//
// Mock topology follows the house conventions:
//   • vi.hoisted per-model db mock (data.test.ts / p2-batch.test.ts)
//   • factory-mocked auth-guard with AuthorizationError carrying
//     `readonly digest = "AuthorizationError"` (p2-batch.test.ts /
//     auth-tokens.test.ts — toResult() instanceof-checks against THIS class)
//   • mocked shared.logAudit, next/cache revalidatePath
//   • mocked @/lib/password (password-reset.test.ts) and @/lib/breach-check
//     (breach-wiring.test.ts) so no bcrypt hashing or HIBP egress runs
//   • mocked @/lib/auth-revoke — the PR-48 Better-Auth session revocation
//     bridge called by changePassword / deleteUser / signOutAllDevices
// ---------------------------------------------------------------------------

const db = vi.hoisted(() => {
  const models = ["user", "userSettings", "teamMember", "passwordResetToken"];
  const methods = [
    "findUnique", "findFirst", "findMany", "create", "createMany", "update",
    "updateMany", "delete", "deleteMany", "upsert", "count", "aggregate",
  ];
  const obj: Record<string, Record<string, ReturnType<typeof vi.fn>>> = {};
  for (const m of models) {
    obj[m] = {};
    for (const meth of methods) obj[m][meth] = vi.fn();
  }
  // Interactive transactions run the callback against the same mock so
  // tx.<model>.<method>() is recorded on the shared spies; the ARRAY form
  // (changePassword / signOutAllDevices) resolves via Promise.all.
  (obj as Record<string, unknown>).$transaction = vi.fn(
    async (fn: unknown) =>
      typeof fn === "function" ? fn(obj) : Promise.all(fn as unknown[]),
  );
  return obj;
});

vi.mock("@/lib/db", () => ({ db }));

const getSessionMock = vi.fn();
const getSessionOrThrowMock = vi.fn();
const requirePermissionMock = vi.fn();
const requirePermissionForTargetMock = vi.fn();
vi.mock("@/server-actions/auth-guard", () => ({
  getSession: () => getSessionMock(),
  getSessionOrThrow: () => getSessionOrThrowMock(),
  requirePermission: (...a: unknown[]) => requirePermissionMock(...a),
  requirePermissionForTarget: (...a: unknown[]) => requirePermissionForTargetMock(...a),
  // toResult() instanceof-checks against this class — the mock must export
  // it (same pattern as p2-batch.test.ts / auth-tokens.test.ts).
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

const getMinPasswordLengthMock = vi.fn();
const hashPasswordMock = vi.fn();
const verifyPasswordMock = vi.fn();
vi.mock("@/lib/password", () => ({
  getMinPasswordLength: () => getMinPasswordLengthMock(),
  hashPassword: (...a: unknown[]) => hashPasswordMock(...a),
  verifyPassword: (...a: unknown[]) => verifyPasswordMock(...a),
}));

const assertPasswordNotBreachedMock = vi.fn();
vi.mock("@/lib/breach-check", () => ({
  assertPasswordNotBreached: (...a: unknown[]) => assertPasswordNotBreachedMock(...a),
  checkPasswordBreach: vi.fn(async () => ({ breached: false, checked: false })),
  isBreachCheckEnabled: vi.fn(() => false),
  BREACH_REJECTION_MESSAGE:
    "This password appears in a public data-breach list and cannot be used.",
}));

const revokeUserSessionsIfActiveMock = vi.fn();
vi.mock("@/lib/auth-revoke", () => ({
  revokeUserSessionsIfActive: (...a: unknown[]) => revokeUserSessionsIfActiveMock(...a),
}));

// PR-64 — getMyPermissions (live RBAC) delegates to the config-loader; the
// loader has its own suite (config-loader.test.ts), so mock it here.
const getEffectivePermissionsMock = vi.fn();
vi.mock("@/lib/config-loader", () => ({
  getEffectivePermissions: (...a: unknown[]) => getEffectivePermissionsMock(...a),
}));

import {
  getUserProfile,
  updateUserSettings,
  updateProfile,
  changePassword,
  createUser,
  updateUser,
  deleteUser,
  signOutAllDevices,
  getMyPermissions,
} from "@/server-actions/users";
// The mocked module's class — toResult() instanceof-checks against THIS
// constructor, so rejections must be real instances of it.
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
// Fixtures
// ---------------------------------------------------------------------------

const ADMIN = { userId: "u-admin", name: "Ada", email: "ada@fernly.dev", role: "ADMIN" as const };
const MANAGER = { userId: "u-mgr", name: "Max", email: "max@fernly.dev", role: "MANAGER" as const };
const MEMBER = { userId: "u-mia", name: "Mia", email: "mia@fernly.dev", role: "MEMBER" as const };

/** The updateUser/deleteUser target — a plain managed MEMBER. */
const TARGET_OLI = {
  id: "u-oli", name: "Oli", email: "oli@fernly.dev", role: "MEMBER",
  timezone: "UTC", bio: "", avatarColor: "forest", managerId: null, deletedAt: null,
};

/** The MANAGER fixture's own user row (for self-manager-change tests). */
const TARGET_MAX = { ...TARGET_OLI, id: "u-mgr", name: "Max", email: "max@fernly.dev" };

beforeEach(() => {
  vi.clearAllMocks();
  getSessionMock.mockResolvedValue(MEMBER);
  getSessionOrThrowMock.mockResolvedValue(MEMBER);
  requirePermissionMock.mockResolvedValue(ADMIN);
  requirePermissionForTargetMock.mockResolvedValue(ADMIN);
  getMinPasswordLengthMock.mockResolvedValue(8);
  hashPasswordMock.mockResolvedValue("hashed-password");
  verifyPasswordMock.mockResolvedValue(true);
  assertPasswordNotBreachedMock.mockResolvedValue(undefined);
  revokeUserSessionsIfActiveMock.mockResolvedValue(undefined);
  // Default every user lookup to "not found"; individual tests override
  // with keyed mockImplementation when different queries need different
  // rows (see the updateUser/createUser describes below).
  db.user.findUnique.mockResolvedValue(null);
  db.user.findMany.mockResolvedValue([]);
  db.user.create.mockResolvedValue({ id: "u-new", email: "nina@fernly.dev", name: "Nina", role: "MEMBER" });
  db.user.update.mockResolvedValue({});
  db.teamMember.findUnique.mockResolvedValue(null);
  db.teamMember.create.mockResolvedValue({});
  db.teamMember.updateMany.mockResolvedValue({ count: 0 });
  db.userSettings.upsert.mockResolvedValue({});
  db.passwordResetToken.updateMany.mockResolvedValue({ count: 0 });
});

// ---------------------------------------------------------------------------
// getUserProfile — line 39
// ---------------------------------------------------------------------------

describe("getMyPermissions (PR-64 live RBAC)", () => {
  it("returns the effective set for the signed-in user's role", async () => {
    getSessionOrThrowMock.mockResolvedValue({ userId: "u-1", role: "MEMBER", name: "M", email: "m@x.co" });
    getEffectivePermissionsMock.mockResolvedValue(["task:edit:own", "hr:view"]);
    const perms = expectOk(await getMyPermissions());
    expect(perms).toEqual(["task:edit:own", "hr:view"]);
    expect(getEffectivePermissionsMock).toHaveBeenCalledWith("MEMBER");
  });

  it("anonymous callers get a sign-in error, not a permission list", async () => {
    getSessionOrThrowMock.mockRejectedValue(
      new AuthorizationError("You must be signed in."),
    );
    expectErr(await getMyPermissions(), /signed in/i);
    expect(getEffectivePermissionsMock).not.toHaveBeenCalled();
  });
});

describe("getUserProfile not-found branch", () => {
  it("returns null when the account row is missing (line 39)", async () => {
    // Uncovered branch: `if (!user) return null;` — the SSR loader contract
    // is a null return (not a throw) for a missing profile. Self-access so
    // the hierarchy gate (requirePermissionForTarget) is skipped and the
    // db.user.findUnique null hits the no-op directly.
    getSessionOrThrowMock.mockResolvedValue(ADMIN);
    db.user.findUnique.mockResolvedValue(null);
    await expect(getUserProfile("u-admin")).resolves.toBeNull();
  });

  it("maps an attached settings row into the profile payload (line 49 truthy arm)", async () => {
    // Uncovered branch arm: `settings: user.settings ? { ... } : null` — the
    // main suites' getUserProfile fixtures all return `settings: null`, so
    // the mapping arm never ran. Pin the full serialisable settings shape.
    getSessionOrThrowMock.mockResolvedValue(ADMIN);
    db.user.findUnique.mockResolvedValue({
      id: "u-admin", email: "ada@fernly.dev", name: "Ada", role: "ADMIN",
      timezone: "UTC", bio: "", avatarColor: "forest",
      settings: {
        accent: "ocean", dark: true, notifEmail: false, notifPush: true,
        notifMentions: false, notifDueToday: true, notifWeekly: true, notifProduct: false,
      },
    });
    const profile = await getUserProfile("u-admin");
    expect(profile?.settings).toEqual({
      accent: "ocean", dark: true, notifEmail: false, notifPush: true,
      notifMentions: false, notifDueToday: true, notifWeekly: true, notifProduct: false,
    });
  });
});

// ---------------------------------------------------------------------------
// updateUserSettings — line 117
// ---------------------------------------------------------------------------

describe("updateUserSettings anonymous guard", () => {
  it("rejects with AUTH when the caller has no session (line 117)", async () => {
    // Uncovered branch: `if (!auth) throw new AuthorizationError(...)` —
    // the main suites always call this signed in.
    getSessionMock.mockResolvedValue(null);
    const res = await updateUserSettings("u-mia", { dark: true });
    expectErr(res, "AUTH");
    if (!res.ok) expect(res.error).toMatch(/signed in/i);
    // Rejected before any write.
    expect(db.userSettings.upsert).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// updateProfile — lines 156, 162
// ---------------------------------------------------------------------------

describe("updateProfile guards", () => {
  it("rejects with AUTH when the caller has no session (line 156)", async () => {
    // Uncovered branch: anonymous `if (!auth) throw` — the profile-update
    // path is only exercised signed-in by the main suites.
    getSessionMock.mockResolvedValue(null);
    const res = await updateProfile("u-mia", {
      name: "Mia", timezone: "UTC", bio: "", avatarColor: "forest",
    });
    expectErr(res, "AUTH");
    if (!res.ok) expect(res.error).toMatch(/signed in/i);
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("rejects when the account row vanished mid-session (line 162)", async () => {
    // Uncovered branch: `if (!existing) throw new AuthorizationError("Account not found.")`
    // — the session says u-mia but db.user.findUnique comes back null.
    getSessionMock.mockResolvedValue(MEMBER);
    db.user.findUnique.mockResolvedValue(null);
    const res = await updateProfile("u-mia", {
      name: "Mia", timezone: "UTC", bio: "", avatarColor: "forest",
    });
    expectErr(res, /Account not found/);
    // Aborted before the user + roster transaction.
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(logAuditMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// changePassword — lines 210, 220, 227
// ---------------------------------------------------------------------------

describe("changePassword guards", () => {
  it("rejects with AUTH when the caller has no session (line 210)", async () => {
    // Uncovered branch: anonymous `if (!auth) throw` before any policy check.
    getSessionMock.mockResolvedValue(null);
    const res = await changePassword({
      userId: "u-mia", currentPassword: "old-pass-1", newPassword: "fresh-pass-1",
    });
    expectErr(res, "AUTH");
    if (!res.ok) expect(res.error).toMatch(/signed in/i);
    expect(db.user.findUnique).not.toHaveBeenCalled();
  });

  it("rejects a new password longer than 1024 characters (line 220)", async () => {
    // Uncovered branch: the P2 max-length ceiling (bcrypt silently
    // truncates at 72 bytes; an unbounded pin pins 1MB of memory). The
    // min-length check passes (1025 ≥ 8) so the max-length guard is what fires.
    getSessionMock.mockResolvedValue(MEMBER);
    const res = await changePassword({
      userId: "u-mia", currentPassword: "old-pass-1", newPassword: "x".repeat(1025),
    });
    expectErr(res, /at most 1024 characters/);
    // Rejected before the user lookup / verify — no DoS surface, no writes.
    expect(db.user.findUnique).not.toHaveBeenCalled();
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it("rejects when the account row is missing (line 227)", async () => {
    // Uncovered branch: `if (!user) throw new AuthorizationError("Account not found.")`
    // — all policy checks pass but the lookup comes back null.
    getSessionMock.mockResolvedValue(MEMBER);
    db.user.findUnique.mockResolvedValue(null);
    const res = await changePassword({
      userId: "u-mia", currentPassword: "old-pass-1", newPassword: "fresh-pass-1",
    });
    expectErr(res, /Account not found/);
    expect(verifyPasswordMock).not.toHaveBeenCalled();
    expect(db.user.update).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// createUser — lines 338, 356, 362, 377-378
// ---------------------------------------------------------------------------

describe("createUser validation guards", () => {
  it("rejects a whitespace-only name (line 338)", async () => {
    // Uncovered branch: `if (!name) throw` after input.name.trim() — the
    // email/password/role guards are never reached.
    const res = await createUser({
      name: "   ", email: "nina@fernly.dev", password: "initial-pass-123", role: "MEMBER",
    });
    expectErr(res, /Name is required/);
    expect(db.user.create).not.toHaveBeenCalled();
  });

  it("rejects a MANAGER (even one holding role:manage) minting an ADMIN (line 356)", async () => {
    // Uncovered branch: the F-14 bypass closure — requirePermission passes
    // (DB ceiling granted role:manage to the MANAGER) but only an ADMIN may
    // create ADMIN accounts.
    requirePermissionMock.mockResolvedValue(MANAGER);
    const res = await createUser({
      name: "Eve", email: "eve@fernly.dev", password: "password-123", role: "ADMIN",
    });
    expectErr(res, /Only an admin can grant the ADMIN role/);
    expect(db.user.create).not.toHaveBeenCalled();
  });

  it("rejects a password longer than 1024 characters (line 362)", async () => {
    // Uncovered branch: the P2 max-length ceiling on the admin-create path.
    // Name/email/min-length/role all pass first so THIS guard fires.
    const res = await createUser({
      name: "Eve", email: "eve@fernly.dev", password: "x".repeat(1025), role: "MEMBER",
    });
    expectErr(res, /at most 1024 characters/);
    expect(hashPasswordMock).not.toHaveBeenCalled();
    expect(db.user.create).not.toHaveBeenCalled();
  });

  it("rejects an unknown managerId (line 377-378, not-found arm)", async () => {
    // Uncovered branch: `if (!mgr) throw new AuthorizationError("The selected
    // manager does not exist.")` — the email is free (findUnique → null for
    // every lookup) but the manager lookup misses.
    const res = await createUser({
      name: "Nina", email: "nina@fernly.dev", password: "initial-pass-123",
      role: "MEMBER", managerId: "u-ghost",
    });
    expectErr(res, /selected manager does not exist/);
    expect(db.user.create).not.toHaveBeenCalled();
  });

  it("creates the account reporting to an existing manager (line 377, happy arm)", async () => {
    // Uncovered branch: the managerId lookup with a HIT — the keyed
    // mockImplementation answers the email-uniqueness query with null (free)
    // and the id-keyed manager query with the manager row.
    db.user.findUnique.mockImplementation(
      ({ where }: { where: { id?: string; email?: string } }) => {
        if (where?.email) return Promise.resolve(null); // email free
        if (where?.id === "u-mgr") return Promise.resolve({ id: "u-mgr", managerId: null });
        return Promise.resolve(null);
      },
    );
    const res = await createUser({
      name: "Nina", email: "nina@fernly.dev", password: "initial-pass-123",
      role: "MEMBER", managerId: "u-mgr", department: "DESIGN", jobTitle: "Designer",
    });
    expect(expectOk(res)).toEqual({ id: "u-new" });
    // The manager link is written on the User row...
    expect(db.user.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        email: "nina@fernly.dev",
        managerId: "u-mgr",
        passwordHash: "hashed-password",
        role: "MEMBER",
      }),
    });
    // ...and the audit detail names the manager (vs "no manager").
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({
      action: "user.created",
      detail: expect.stringContaining("reporting to user u-mgr"),
    }));
  });

  it("links an existing roster row instead of creating a duplicate (line 409 false arm)", async () => {
    // Uncovered branch arm: `if (!existingMember)` — the FALSE side. When the
    // email already has a TeamMember row (invite-first flows), the account is
    // created but NO second roster row is minted, and the audit records
    // "(no manager)" (line 430 false arm — managerId omitted).
    db.user.findUnique.mockImplementation(
      ({ where }: { where: { id?: string; email?: string } }) => {
        if (where?.email) return Promise.resolve(null); // account email free
        return Promise.resolve(null);
      },
    );
    db.teamMember.findUnique.mockResolvedValue({ id: "m-existing", email: "nina@fernly.dev" });
    const res = await createUser({
      name: "Nina", email: "nina@fernly.dev", password: "initial-pass-123", role: "MEMBER",
    });
    expectOk(res);
    expect(db.user.create).toHaveBeenCalled();
    expect(db.teamMember.create).not.toHaveBeenCalled();
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({
      detail: expect.stringContaining("(no manager)"),
    }));
  });
});

// ---------------------------------------------------------------------------
// updateUser — lines 459, 476, 493, 511-517, 549-550, 572
// ---------------------------------------------------------------------------

describe("updateUser guards", () => {
  it("rejects when the target row is missing (line 459)", async () => {
    // Uncovered branch: the defence-in-depth re-check after
    // requirePermissionForTarget — db.user.findUnique → null → "User not found."
    const res = await updateUser("u-oli", { name: "Ghost" });
    expectErr(res, /User not found/);
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it("rejects a non-admin changing their own manager (line 476)", async () => {
    // Uncovered branch: self-protection — a MANAGER re-pointing their own
    // managerId would let them escape the hierarchy. requirePermissionForTarget
    // passes (self-target is always hierarchy-allowed) and the target lookup
    // hits, so THIS guard is what fires.
    requirePermissionForTargetMock.mockResolvedValue(MANAGER);
    db.user.findUnique.mockResolvedValue(TARGET_MAX);
    const res = await updateUser("u-mgr", { managerId: "u-admin" });
    expectErr(res, /cannot change your own manager/);
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it("skips the email-uniqueness re-check when the email is unchanged (line 490 false arm)", async () => {
    // Uncovered branch arm: `if (email !== target.email)` — the FALSE side.
    // Re-submitting the SAME email must not run the duplicate-email lookup
    // (which would false-positive on the user's own row) and must not log an
    // "email" change.
    db.user.findUnique.mockImplementation(
      ({ where }: { where: { id?: string; email?: string } }) => {
        // Any email-keyed lookup here would resolve to an "existing" user —
        // the assertion below proves the re-check never fires.
        if (where?.email) return Promise.resolve({ id: "u-taken", email: where.email });
        if (where?.id === "u-oli") return Promise.resolve(TARGET_OLI);
        return Promise.resolve(null);
      },
    );
    const res = await updateUser("u-oli", { email: TARGET_OLI.email });
    expectOk(res);
    const emailLookups = db.user.findUnique.mock.calls.filter(
      (c) => (c[0] as { where?: { email?: string } })?.where?.email,
    );
    expect(emailLookups).toHaveLength(0);
    expect(db.user.update).toHaveBeenCalledWith({
      where: { id: "u-oli" },
      data: { email: "oli@fernly.dev" },
    });
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({
      detail: expect.stringMatching(/Saved user Oli/),
    }));
  });

  it("rejects an email already used by another account (line 493)", async () => {
    // Uncovered branch: the P2 pre-check that turns a would-be Prisma P2002
    // into a friendly AUTH error. The id-keyed lookup returns the target; the
    // email-keyed uniqueness lookup returns an existing row.
    db.user.findUnique.mockImplementation(
      ({ where }: { where: { id?: string; email?: string } }) => {
        if (where?.email === "taken@fernly.dev") {
          return Promise.resolve({ id: "u-taken", email: "taken@fernly.dev" });
        }
        if (where?.id === "u-oli") return Promise.resolve(TARGET_OLI);
        return Promise.resolve(null);
      },
    );
    const res = await updateUser("u-oli", { email: "taken@fernly.dev" });
    expectErr(res, /already exists/);
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it("rejects an unknown new manager (line 514 inside 511-517)", async () => {
    // Uncovered branch: the updateUser-side manager existence check — the
    // target exists but the proposed manager id does not.
    db.user.findUnique.mockImplementation(
      ({ where }: { where: { id?: string; email?: string } }) => {
        if (where?.id === "u-oli") return Promise.resolve(TARGET_OLI);
        return Promise.resolve(null); // u-ghost manager lookup misses
      },
    );
    const res = await updateUser("u-oli", { managerId: "u-ghost" });
    expectErr(res, /selected manager does not exist/);
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it("re-points a user's manager and audits the change (lines 511-517, 572)", async () => {
    // Uncovered branch: the full managerId update path — manager existence
    // lookup (hit), assertNoCycle (real lib/hierarchy walks the chain via
    // db.user.findUnique / db.user.findMany against this mock), the
    // data.managerId write, and the "manager" audit change-detection entry.
    db.user.findUnique.mockImplementation(
      ({ where }: { where: { id?: string; email?: string } }) => {
        // Target lookup (id + deletedAt filter) vs manager lookup vs the
        // getManagerChain walk — all id-keyed, answered by one row each.
        if (where?.id === "u-oli") return Promise.resolve(TARGET_OLI);
        if (where?.id === "u-mgr") return Promise.resolve({ id: "u-mgr", managerId: null });
        return Promise.resolve(null);
      },
    );
    db.user.findMany.mockResolvedValue([]); // getSubtreeUserIds: no reports
    const res = await updateUser("u-oli", { managerId: "u-mgr" });
    expectOk(res);
    // managerId written on the User row (and nothing else — no role/password
    // fields, hence no tokenVersion bump or session revocation).
    expect(db.user.update).toHaveBeenCalledWith({
      where: { id: "u-oli" },
      data: { managerId: "u-mgr" },
    });
    expect(revokeUserSessionsIfActiveMock).not.toHaveBeenCalled();
    // Audit change-detection records the manager move (line 572).
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({
      action: "user.updated",
      detail: expect.stringContaining("manager"),
    }));
  });

  it("clears a user's manager when passed managerId: null (line 511 falsy arm)", async () => {
    // Uncovered branch arm: `const newManagerId = input.managerId || null;`
    // — the falsy side (un-assign, "null = root") skips the manager
    // existence lookup and assertNoCycle entirely and writes null.
    db.user.findUnique.mockResolvedValue({ ...TARGET_OLI, managerId: "u-old" });
    const res = await updateUser("u-oli", { managerId: null });
    expectOk(res);
    expect(db.user.update).toHaveBeenCalledWith({
      where: { id: "u-oli" },
      data: { managerId: null },
    });
    // The un-assign is still audited as a manager change (line 572).
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({
      detail: expect.stringContaining("manager"),
    }));
  });

  it("syncs jobTitle and department to the roster row (lines 549-550)", async () => {
    // Uncovered branch: `if (input.jobTitle !== undefined) memberUpdate.role`
    // and `if (input.department !== undefined) memberUpdate.department` —
    // neither field is touched by the main suites' updateUser calls. The
    // roster row is keyed by the TARGET's email, not the new one.
    db.user.findUnique.mockResolvedValue(TARGET_OLI);
    const res = await updateUser("u-oli", { jobTitle: "Senior Dev", department: "DESIGN" });
    expectOk(res);
    expect(db.teamMember.updateMany).toHaveBeenCalledWith({
      where: { email: "oli@fernly.dev" },
      data: { role: "Senior Dev", department: "DESIGN" },
    });
    // Nothing changed on the account row itself — a plain save is audited.
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({
      detail: expect.stringMatching(/Saved user Oli/),
    }));
  });
});

// ---------------------------------------------------------------------------
// deleteUser — line 597
// ---------------------------------------------------------------------------

describe("deleteUser not-found branch", () => {
  it("rejects when the target row is missing (line 597)", async () => {
    // Uncovered branch: the post-gate target lookup → null. The main suites
    // only delete users that exist; here the gate passes but the row is gone.
    const res = await deleteUser("u-oli");
    expectErr(res, /User not found/);
    // No soft-delete transaction, no revocation, no audit.
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(revokeUserSessionsIfActiveMock).not.toHaveBeenCalled();
    expect(logAuditMock).not.toHaveBeenCalled();
  });

  it("skips the roster soft-delete when the target has no email (line 620 falsy arm)", async () => {
    // Uncovered branch arm: `...(target.email ? [teamMember.updateMany(...)]
    // : [])` — the defensive empty-email arm. The transaction must still
    // soft-delete the account row, revoke sessions and audit.
    db.user.findUnique.mockResolvedValue({ ...TARGET_OLI, email: "" });
    const res = await deleteUser("u-oli");
    expectOk(res);
    expect(db.user.update).toHaveBeenCalledWith({
      where: { id: "u-oli" },
      data: { deletedAt: expect.any(Date) },
    });
    expect(db.teamMember.updateMany).not.toHaveBeenCalled();
    expect(revokeUserSessionsIfActiveMock).toHaveBeenCalledWith("u-oli");
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({
      action: "user.deleted",
    }));
  });
});

// ---------------------------------------------------------------------------
// signOutAllDevices — lines 694-724 (entire action)
// ---------------------------------------------------------------------------

describe("signOutAllDevices (PR-48/PR-49)", () => {
  it("bumps tokenVersion, kills reset tokens + sessions, and audits (lines 694-724)", async () => {
    // Uncovered block: the whole "Sign out all devices" action — no other
    // suite calls it. One atomic transaction bumps tokenVersion (v4 JWTs)
    // and burns pending password-reset tokens; revokeUserSessionsIfActive
    // kills the Better Auth DB sessions; the audit row records the event.
    getSessionOrThrowMock.mockResolvedValue(MEMBER);
    const res = await signOutAllDevices();
    const data = expectOk(res);
    expect(typeof data.revokedAt).toBe("string");
    expect(Number.isNaN(new Date(data.revokedAt).getTime())).toBe(false);

    // Both writes went through the SAME $transaction (atomic by design).
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(db.user.update).toHaveBeenCalledWith({
      where: { id: "u-mia" },
      data: { tokenVersion: { increment: 1 } },
    });
    expect(db.passwordResetToken.updateMany).toHaveBeenCalledWith({
      where: { userId: "u-mia", usedAt: null },
      data: expect.objectContaining({ usedAt: expect.any(Date) }),
    });
    // The Better Auth DB sessions die too (not just the JWTs).
    expect(revokeUserSessionsIfActiveMock).toHaveBeenCalledWith("u-mia");
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({
      action: "user.updated",
      entityType: "USER",
      entityId: "u-mia",
      detail: expect.stringContaining("signed out all devices"),
    }));
  });

  it("maps a missing session to { ok: false, code: AUTH }", async () => {
    // Uncovered block companion: the anonymous caller must get the
    // client-safe ActionResult, never a throw, across the boundary.
    getSessionOrThrowMock.mockRejectedValue(new AuthorizationError("You must be signed in."));
    const res = await signOutAllDevices();
    expectErr(res, "AUTH");
    if (!res.ok) expect(res.error).toMatch(/signed in/i);
    expect(db.user.update).not.toHaveBeenCalled();
    expect(revokeUserSessionsIfActiveMock).not.toHaveBeenCalled();
  });
});
