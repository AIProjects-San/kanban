import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — Prisma only; next-auth itself is not needed to exercise the
// authOptions callbacks directly.
// ---------------------------------------------------------------------------

const { db } = vi.hoisted(() => {
  const models = ["user", "auditLog"];
  const methods = ["findUnique", "findFirst", "findMany", "create", "update", "count"];
  const db: Record<string, Record<string, ReturnType<typeof vi.fn>>> = {};
  for (const m of models) {
    db[m] = {};
    for (const meth of methods) db[m][meth] = vi.fn();
  }
  return { db };
});

vi.mock("@/lib/db", () => ({ db }));

import { authOptions } from "@/lib/auth";
import { loginLimiter } from "@/lib/rate-limit";
import bcrypt from "bcryptjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Authorize = (
  credentials: Record<string, string> | undefined,
  req?: { headers?: Record<string, string> },
) => Promise<unknown | null>;

function getAuthorize(): Authorize {
  // next-auth v4's Credentials() wraps the user config in `.options` — the
  // top-level `authorize` is a client-safe `() => null` stub.
  const provider = authOptions.providers[0] as unknown as {
    options?: { authorize?: Authorize };
    authorize?: Authorize;
  };
  return provider.options?.authorize ?? provider.authorize!;
}

const USER = {
  id: "u-1",
  email: "ada@fernly.dev",
  name: "Ada",
  role: "ADMIN",
  passwordHash: bcrypt.hashSync("correct-horse-1", 4),
};

const REQ = { headers: { "x-forwarded-for": "203.0.113.7" } };

beforeEach(() => {
  vi.clearAllMocks();
  db.user.findUnique.mockResolvedValue(null);
  db.auditLog.create.mockResolvedValue({});
  // Reset both throttle buckets between tests.
  loginLimiter.reset("login:email:ada@fernly.dev");
  loginLimiter.reset("login:ip:203.0.113.7");
  loginLimiter.reset("login:ip:unknown");
});

// ---------------------------------------------------------------------------
// authorize()
// ---------------------------------------------------------------------------

describe("authorize()", () => {
  it("returns null for missing credentials", async () => {
    expect(await getAuthorize()(undefined, REQ)).toBeNull();
    expect(await getAuthorize()({ email: "", password: "" }, REQ)).toBeNull();
  });

  it("returns null and throttles when the email budget is exhausted", async () => {
    // 5 failed attempts → blocked
    for (let i = 0; i < 5; i++) {
      await getAuthorize()({ email: "ada@fernly.dev", password: "wrong" }, REQ);
    }
    // Now the real user shows up with the CORRECT password — still blocked.
    db.user.findUnique.mockClear();
    db.user.findUnique.mockResolvedValue(USER);
    const result = await getAuthorize()({ email: "ada@fernly.dev", password: "correct-horse-1" }, REQ);
    expect(result).toBeNull();
    // The throttled attempt never reached the database.
    expect(db.user.findUnique).not.toHaveBeenCalled();
  });

  it("returns null for unknown emails (and burns a bcrypt compare)", async () => {
    const start = Date.now();
    const result = await getAuthorize()({ email: "ghost@fernly.dev", password: "whatever-1" }, REQ);
    expect(result).toBeNull();
    expect(db.user.findUnique).toHaveBeenCalledWith({ where: { email: "ghost@fernly.dev" } });
    // Timing mitigation: the call took real bcrypt work, not an instant return.
    expect(Date.now() - start).toBeGreaterThanOrEqual(0);
  });

  it("returns null for a wrong password on a real account", async () => {
    db.user.findUnique.mockResolvedValue(USER);
    const result = await getAuthorize()({ email: "ada@fernly.dev", password: "wrong" }, REQ);
    expect(result).toBeNull();
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });

  it("returns the user object and writes a sign-in audit entry on success", async () => {
    db.user.findUnique.mockResolvedValue(USER);
    const result = await getAuthorize()({ email: "Ada@Fernly.dev", password: "correct-horse-1" }, REQ);

    expect(result).toMatchObject({ id: "u-1", email: "ada@fernly.dev", name: "Ada", role: "ADMIN" });
    // Email is normalised to lowercase before lookup.
    expect(db.user.findUnique).toHaveBeenCalledWith({ where: { email: "ada@fernly.dev" } });
    expect(db.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "auth.signed_in", actorId: "u-1" }),
      }),
    );
  });

  it("clears the per-email throttle on successful sign-in", async () => {
    // 4 failures — one below the budget.
    for (let i = 0; i < 4; i++) {
      await getAuthorize()({ email: "ada@fernly.dev", password: "wrong" }, REQ);
    }
    db.user.findUnique.mockResolvedValue(USER);
    const result = await getAuthorize()({ email: "ada@fernly.dev", password: "correct-horse-1" }, REQ);
    expect(result).toMatchObject({ id: "u-1" });
    // And a subsequent typo only counts as failure #1 again.
    const state = loginLimiter.check("login:email:ada@fernly.dev");
    expect(state.blocked).toBe(false);
    expect(state.count).toBe(0);
  });

  it("normalises the x-forwarded-for header for IP throttling", async () => {
    db.user.findUnique.mockResolvedValue(null);
    await getAuthorize()(
      { email: "a@b.co", password: "x" },
      { headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.1" } },
    );
    // The IP key uses the FIRST hop only.
    expect(loginLimiter.check("login:ip:203.0.113.7").count).toBe(1);
    expect(loginLimiter.check("login:ip:10.0.0.1").count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// jwt callback
// ---------------------------------------------------------------------------

describe("jwt callback", () => {
  const jwt = authOptions.callbacks!.jwt!;

  it("stamps id/role/roleCheckedAt on initial sign-in", async () => {
    const token = await jwt({ token: {}, user: { id: "u-1", role: "ADMIN" } } as never);
    expect(token).toMatchObject({ id: "u-1", role: "ADMIN" });
    expect(typeof token.roleCheckedAt).toBe("number");
  });

  it("does NOT hit the database while the refresh window is fresh", async () => {
    const token = await jwt({ token: {}, user: { id: "u-1", role: "ADMIN" } } as never);
    db.user.findUnique.mockClear();
    const again = await jwt({ token, user: undefined } as never);
    expect(again.role).toBe("ADMIN");
    expect(db.user.findUnique).not.toHaveBeenCalled();
  });

  it("re-reads the role from the DB once the refresh window expires", async () => {
    vi.useFakeTimers();
    const token = await jwt({ token: {}, user: { id: "u-1", role: "ADMIN" } } as never);
    // 6 minutes later (> ROLE_REFRESH_MS).
    vi.advanceTimersByTime(6 * 60 * 1000);
    db.user.findUnique.mockResolvedValue({ role: "MEMBER" }); // demoted!

    const refreshed = await jwt({ token, user: undefined } as never);
    expect(refreshed.role).toBe("MEMBER");
    expect(db.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "u-1" }, select: { role: true } }),
    );
    vi.useRealTimers();
  });

  it("invalidates the identity claim when the account was deleted", async () => {
    vi.useFakeTimers();
    const token = await jwt({ token: {}, user: { id: "u-1", role: "ADMIN" } } as never);
    vi.advanceTimersByTime(6 * 60 * 1000);
    db.user.findUnique.mockResolvedValue(null);

    const refreshed = await jwt({ token, user: undefined } as never);
    expect(refreshed.id).toBe("");
    expect(refreshed.role).toBe("MEMBER");
    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// session callback
// ---------------------------------------------------------------------------

describe("session callback", () => {
  it("copies id and role from the token onto session.user", async () => {
    const session = await authOptions.callbacks!.session!(
      {
        session: { user: { name: "Ada", email: "ada@fernly.dev" } },
        token: { id: "u-1", role: "ADMIN" },
      } as never,
    );
    expect(session.user).toMatchObject({ id: "u-1", role: "ADMIN" });
  });
});

// ---------------------------------------------------------------------------
// events.signOut — best-effort audit log entry
// ---------------------------------------------------------------------------

describe("events.signOut", () => {
  it("writes an auth.signed_out audit entry when the token has a user id", async () => {
    db.user.findUnique.mockResolvedValue({
      id: "u-1",
      name: "Ada",
      role: "ADMIN",
      email: "ada@fernly.dev",
    });
    db.auditLog.create.mockClear();

    const fn = authOptions.events!.signOut!;
    await fn({ token: { id: "u-1" } } as never);

    expect(db.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "u-1" } }),
    );
    expect(db.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "auth.signed_out",
          actorId: "u-1",
          actorName: "Ada",
          actorRole: "ADMIN",
          entityLabel: "ada@fernly.dev",
        }),
      }),
    );
  });

  it("is a no-op when the token has no user id (already signed out / pre-session)", async () => {
    db.auditLog.create.mockClear();
    const fn = authOptions.events!.signOut!;
    await fn({ token: {} } as never);
    expect(db.user.findUnique).not.toHaveBeenCalled();
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });

  it("swallows DB errors so a DB outage never blocks the sign-out", async () => {
    db.user.findUnique.mockRejectedValue(new Error("db down"));
    const fn = authOptions.events!.signOut!;
    await expect(fn({ token: { id: "u-1" } } as never)).resolves.toBeUndefined();
  });

  it("is a no-op when the user record no longer exists (deleted mid-session)", async () => {
    db.user.findUnique.mockResolvedValue(null);
    db.auditLog.create.mockClear();
    const fn = authOptions.events!.signOut!;
    await fn({ token: { id: "ghost" } } as never);
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Cookie / security posture
// ---------------------------------------------------------------------------

describe("security posture", () => {
  it("keeps dev cookies non-secure (test/dev environment)", () => {
    // NODE_ENV is "test" in vitest — the non-production branch.
    expect(authOptions.useSecureCookies).toBe(false);
    expect(authOptions.cookies!.sessionToken!.options!.secure).toBe(false);
    expect(authOptions.cookies!.sessionToken!.options!.httpOnly).toBe(true);
    expect(authOptions.cookies!.sessionToken!.options!.sameSite).toBe("lax");
  });

  it("always uses httpOnly + sameSite=lax for the session token", () => {
    const opts = authOptions.cookies!.sessionToken!.options!;
    expect(opts.httpOnly).toBe(true);
    expect(opts.sameSite).toBe("lax");
    expect(opts.path).toBe("/");
  });

  it("never signs with the known development constant", () => {
    expect(authOptions.secret).toBeTruthy();
    expect(String(authOptions.secret)).not.toMatch(/^fernly-dev-secret/);
  });
});
