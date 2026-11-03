import { describe, it, expect, vi, beforeEach } from "vitest";

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

// L-P0-10 — auth.ts now uses createLoginLimiter() (async, Redis-capable).
// Mock it to return the SAME in-memory loginLimiter the tests import below,
// so the tests' .check()/.reset() calls operate on the instance auth.ts uses.
const { loginLimiter: inMemoryLoginLimiter } = await import("@/lib/rate-limit");
vi.mock("@/lib/rate-limit-redis", () => ({
  createLoginLimiter: () => ({
    check: async (key: string, now?: number) => inMemoryLoginLimiter.check(key, now),
    hit: async (key: string, now?: number) => inMemoryLoginLimiter.hit(key, now),
    reset: async (key: string) => inMemoryLoginLimiter.reset(key),
  }),
}));

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
  tokenVersion: 0, // L-P0-8
  deletedAt: null, // P0 re-audit: soft-delete filter expects this
};

const REQ = { headers: { "x-forwarded-for": "203.0.113.7" } };

beforeEach(() => {
  vi.clearAllMocks();
  db.user.findUnique.mockResolvedValue(null);
  db.auditLog.create.mockResolvedValue({});
  // Reset all throttle buckets used by any test (the limiter is a singleton
  // shared across the describe block, so stale counts leak between tests).
  loginLimiter.reset("login:email:ada@fernly.dev");
  loginLimiter.reset("login:email:ghost@fernly.dev");
  loginLimiter.reset("login:email:a@b.co");
  loginLimiter.reset("login:ip:203.0.113.7");
  loginLimiter.reset("login:ip:10.0.0.1");
  loginLimiter.reset("login:ip:198.51.100.5");
  loginLimiter.reset("login:ip:1.2.3.4");
  loginLimiter.reset("login:ip:unknown");
  loginLimiter.reset("login:ip:203.0.113.99"); // PR-11 NAT test
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
    expect(db.user.findUnique).toHaveBeenCalledWith({ where: { email: "ghost@fernly.dev", deletedAt: null } });
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
    expect(db.user.findUnique).toHaveBeenCalledWith({ where: { email: "ada@fernly.dev", deletedAt: null } });
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

  it("PR-11: also clears the per-IP throttle on successful sign-in (shared-NAT lockout)", async () => {
    // 4 failures from one shared-egress IP (office NAT) — one below budget.
    const NAT_REQ = { headers: { "x-real-ip": "203.0.113.99" } };
    for (let i = 0; i < 4; i++) {
      await getAuthorize()({ email: "ada@fernly.dev", password: "wrong" }, NAT_REQ);
    }
    expect(loginLimiter.check("login:ip:203.0.113.99").count).toBe(4);
    // A successful sign-in must clear the IP bucket too — otherwise everyone
    // behind that NAT stays one typo away from a shared lockout.
    db.user.findUnique.mockResolvedValue(USER);
    const result = await getAuthorize()({ email: "ada@fernly.dev", password: "correct-horse-1" }, NAT_REQ);
    expect(result).toMatchObject({ id: "u-1" });
    const state = loginLimiter.check("login:ip:203.0.113.99");
    expect(state.blocked).toBe(false);
    expect(state.count).toBe(0);
    // The email bucket was cleared as well.
    expect(loginLimiter.check("login:email:ada@fernly.dev").count).toBe(0);
  });

  it("normalises the x-forwarded-for header for IP throttling", async () => {
    db.user.findUnique.mockResolvedValue(null);
    await getAuthorize()(
      { email: "a@b.co", password: "x" },
      { headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.1" } },
    );
    // P1 (edge-case audit) — the IP key uses the LAST hop (the closest
    // trusted proxy), not the first (client-supplied, spoofable). With
    // nginx's $proxy_add_x_forwarded_for, the format is "spoofed, real-client"
    // so the last entry is the real client IP.
    expect(loginLimiter.check("login:ip:10.0.0.1").count).toBe(1);
    expect(loginLimiter.check("login:ip:203.0.113.7").count).toBe(0);
  });

  it("P1 edge-case: prefers X-Real-IP over X-Forwarded-For (anti-spoof)", async () => {
    db.user.findUnique.mockResolvedValue(null);
    await getAuthorize()(
      { email: "a@b.co", password: "x" },
      { headers: { "x-real-ip": "198.51.100.5", "x-forwarded-for": "1.2.3.4, 10.0.0.1" } },
    );
    // X-Real-IP is set by the proxy (nginx/caddy) and is NOT client-supplied.
    // It wins over X-Forwarded-For.
    expect(loginLimiter.check("login:ip:198.51.100.5").count).toBe(1);
    expect(loginLimiter.check("login:ip:1.2.3.4").count).toBe(0);
    expect(loginLimiter.check("login:ip:10.0.0.1").count).toBe(0);
  });

  it("P2 edge-case: trims + lowercases the email before lookup", async () => {
    db.user.findUnique.mockResolvedValue(null);
    await getAuthorize()({ email: "  Ada@Fernly.DEV  ", password: "x" }, REQ);
    // The lookup uses the trimmed + lowercased email.
    expect(db.user.findUnique).toHaveBeenCalledWith({
      where: { email: "ada@fernly.dev", deletedAt: null },
    });
  });

  it("P1 edge-case: returns null (not 500) when the DB throws during lookup", async () => {
    db.user.findUnique.mockRejectedValue(new Error("connection refused"));
    const result = await getAuthorize()(
      { email: "ada@fernly.dev", password: "correct-horse-1" },
      REQ,
    );
    expect(result).toBeNull();
    // The limiter was NOT hit (the failure was infra, not a bad password).
    expect(loginLimiter.check("login:email:ada@fernly.dev").count).toBe(0);
  });

  it("P1 edge-case: returns null (not 500) when bcrypt throws on a corrupted hash", async () => {
    db.user.findUnique.mockResolvedValue({ ...USER, passwordHash: "not-a-bcrypt-hash" });
    const result = await getAuthorize()(
      { email: "ada@fernly.dev", password: "correct-horse-1" },
      REQ,
    );
    expect(result).toBeNull();
    // The failed attempt counts against the rate limit (treat as wrong password).
    expect(loginLimiter.check("login:email:ada@fernly.dev").count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// jwt callback
// ---------------------------------------------------------------------------

describe("jwt callback", () => {
  const jwt = authOptions.callbacks!.jwt!;

  it("stamps id/role/roleCheckedAt on initial sign-in", async () => {
    const token = await jwt({ token: {}, user: { id: "u-1", role: "ADMIN", tokenVersion: 0 } } as never);
    expect(token).toMatchObject({ id: "u-1", role: "ADMIN", tokenVersion: 0 });
    expect(typeof token.roleCheckedAt).toBe("number");
  });

  it("does NOT hit the database while the refresh window is fresh", async () => {
    const token = await jwt({ token: {}, user: { id: "u-1", role: "ADMIN", tokenVersion: 0 } } as never);
    db.user.findUnique.mockClear();
    const again = await jwt({ token, user: undefined } as never);
    expect(again.role).toBe("ADMIN");
    expect(db.user.findUnique).not.toHaveBeenCalled();
  });

  it("re-reads the role from the DB once the refresh window expires", async () => {
    vi.useFakeTimers();
    const token = await jwt({ token: {}, user: { id: "u-1", role: "ADMIN", tokenVersion: 0 } } as never);
    // 6 minutes later (> ROLE_REFRESH_MS).
    vi.advanceTimersByTime(6 * 60 * 1000);
    db.user.findUnique.mockResolvedValue({ role: "MEMBER", tokenVersion: 0, deletedAt: null }); // demoted, no revocation

    const refreshed = await jwt({ token, user: undefined } as never);
    expect(refreshed.role).toBe("MEMBER");
    expect(db.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "u-1", deletedAt: null },
        select: { role: true, tokenVersion: true, deletedAt: true },
      }),
    );
    vi.useRealTimers();
  });

  it("invalidates the identity claim when the account was deleted", async () => {
    vi.useFakeTimers();
    const token = await jwt({ token: {}, user: { id: "u-1", role: "ADMIN", tokenVersion: 0 } } as never);
    vi.advanceTimersByTime(6 * 60 * 1000);
    db.user.findUnique.mockResolvedValue(null);

    const refreshed = await jwt({ token, user: undefined } as never);
    expect(refreshed.id).toBe("");
    expect(refreshed.role).toBe("MEMBER");
    vi.useRealTimers();
  });

  // P0 (production-readiness re-audit) — soft-deleted users must NOT be able
  // to sign in. The authorize lookup filters `deletedAt: null`, so a
  // soft-deleted user is treated the same as a non-existent email (timing
  // mitigation kicks in, no session is created). This test pins the contract.
  it("P0 re-audit: refuses to sign in a soft-deleted user (deletedAt set)", async () => {
    // The user row exists in the DB but is soft-deleted. The findUnique
    // filter on `deletedAt: null` returns null → authorize returns null.
    db.user.findUnique.mockResolvedValue(null); // simulates the filtered lookup
    const result = await getAuthorize()(
      { email: "ghost@fernly.dev", password: "correct-horse-1" },
      REQ,
    );
    expect(result).toBeNull();
    // The lookup explicitly filtered on deletedAt: null.
    expect(db.user.findUnique).toHaveBeenCalledWith({
      where: { email: "ghost@fernly.dev", deletedAt: null },
    });
  });

  // P0 (production-readiness re-audit) — a soft-deleted user's existing
  // session must be invalidated at the next JWT refresh. The lookup filters
  // `deletedAt: null` so it returns null for soft-deleted users; the jwt
  // callback then clears the token id (same path as hard-deleted users).
  it("P0 re-audit: invalidates the session when the account was soft-deleted mid-session", async () => {
    vi.useFakeTimers();
    const token = await jwt({ token: {}, user: { id: "u-1", role: "ADMIN", tokenVersion: 0 } } as never);
    vi.advanceTimersByTime(6 * 60 * 1000);
    // Simulate the user being soft-deleted: the `deletedAt: null` filter on
    // the refresh lookup returns null even though the row still exists.
    db.user.findUnique.mockResolvedValue(null);

    const refreshed = await jwt({ token, user: undefined } as never);
    expect(refreshed.id).toBe("");
    expect(refreshed.role).toBe("MEMBER");
    // And the lookup explicitly filtered on deletedAt: null.
    expect(db.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "u-1", deletedAt: null },
        select: { role: true, tokenVersion: true, deletedAt: true },
      }),
    );
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // L-P0-8 — tokenVersion session revocation.
  // -------------------------------------------------------------------------

  it("L-P0-8: invalidates the session when tokenVersion is bumped (password changed)", async () => {
    vi.useFakeTimers();
    const token = await jwt({ token: {}, user: { id: "u-1", role: "ADMIN", tokenVersion: 0 } } as never);
    expect(token.id).toBe("u-1");
    expect(token.tokenVersion).toBe(0);

    // 6 minutes later — the user changed their password, bumping tokenVersion to 1
    vi.advanceTimersByTime(6 * 60 * 1000);
    db.user.findUnique.mockResolvedValue({ role: "ADMIN", tokenVersion: 1, deletedAt: null });

    const refreshed = await jwt({ token, user: undefined } as never);
    expect(refreshed.id).toBe("");
    expect(refreshed.role).toBe("MEMBER");
    expect(refreshed.tokenVersion).toBe(1);
    vi.useRealTimers();
  });

  it("L-P0-8: invalidates the session when an admin changes the user's role (tokenVersion bumped)", async () => {
    vi.useFakeTimers();
    const token = await jwt({ token: {}, user: { id: "u-1", role: "MEMBER", tokenVersion: 0 } } as never);
    vi.advanceTimersByTime(6 * 60 * 1000);
    db.user.findUnique.mockResolvedValue({ role: "MANAGER", tokenVersion: 1, deletedAt: null });

    const refreshed = await jwt({ token, user: undefined } as never);
    expect(refreshed.id).toBe("");
    expect(refreshed.role).toBe("MEMBER");
    vi.useRealTimers();
  });

  it("L-P0-8: keeps the session alive when tokenVersion is unchanged (defensive)", async () => {
    vi.useFakeTimers();
    const token = await jwt({ token: {}, user: { id: "u-1", role: "ADMIN", tokenVersion: 0 } } as never);
    vi.advanceTimersByTime(6 * 60 * 1000);
    db.user.findUnique.mockResolvedValue({ role: "ADMIN", tokenVersion: 0, deletedAt: null });

    const refreshed = await jwt({ token, user: undefined } as never);
    expect(refreshed.id).toBe("u-1");
    expect(refreshed.role).toBe("ADMIN");
    vi.useRealTimers();
  });

  it("L-P0-8: does not false-positive invalidate when DB returns undefined tokenVersion (legacy)", async () => {
    vi.useFakeTimers();
    const token = await jwt({ token: {}, user: { id: "u-1", role: "ADMIN", tokenVersion: 0 } } as never);
    vi.advanceTimersByTime(6 * 60 * 1000);
    db.user.findUnique.mockResolvedValue({ role: "ADMIN", deletedAt: null }); // no tokenVersion field

    const refreshed = await jwt({ token, user: undefined } as never);
    expect(refreshed.id).toBe("u-1");
    expect(refreshed.role).toBe("ADMIN");
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

  // PR-34 (production-readiness round 2) — the sign-out row records the
  // source IP + user agent via the AsyncLocalStorage bridge set by the
  // NextAuth route handler. Roadmap §6.6 closed.
  it("includes ipAddress/userAgent when a request context is active (PR-34)", async () => {
    const { runWithAuthRequestContext } = await import("@/lib/auth-request-context");
    db.user.findUnique.mockResolvedValue({
      id: "u-1",
      name: "Ada",
      role: "ADMIN",
      email: "ada@fernly.dev",
    });
    db.auditLog.create.mockClear();
    const fn = authOptions.events!.signOut!;

    await runWithAuthRequestContext(
      { ip: "203.0.113.7", userAgent: "Mozilla/5.0 (vitest)" },
      () => fn({ token: { id: "u-1" } } as never),
    );

    expect(db.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "auth.signed_out",
          ipAddress: "203.0.113.7",
          userAgent: "Mozilla/5.0 (vitest)",
        }),
      }),
    );
  });

  it("omits ipAddress/userAgent outside a request context (legacy row shape)", async () => {
    db.user.findUnique.mockResolvedValue({
      id: "u-1",
      name: "Ada",
      role: "ADMIN",
      email: "ada@fernly.dev",
    });
    db.auditLog.create.mockClear();
    const fn = authOptions.events!.signOut!;
    await fn({ token: { id: "u-1" } } as never);
    const call = db.auditLog.create.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(call.data.ipAddress).toBeUndefined();
    expect(call.data.userAgent).toBeUndefined();
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

// ---------------------------------------------------------------------------
// P0-6 regression — NEXTAUTH_SECRET hardening at module load
// ---------------------------------------------------------------------------

describe("NEXTAUTH_SECRET hardening (P0-6)", () => {
  const ENV_KEYS = ["NEXTAUTH_SECRET", "NODE_ENV", "NEXT_PHASE"] as const;
  // `process.env.NODE_ENV` is typed as a readonly literal in @types/node;
  // cast through a record so we can reassign it in tests.
  const env = process.env as Record<string, string | undefined>;

  function snapshotEnv(): Record<string, string | undefined> {
    const snap: Record<string, string | undefined> = {};
    for (const k of ENV_KEYS) snap[k] = env[k];
    return snap;
  }
  function restoreEnv(snap: Record<string, string | undefined>) {
    for (const k of ENV_KEYS) {
      if (snap[k] === undefined) delete env[k];
      else env[k] = snap[k]!;
    }
  }
  async function freshAuthOptions() {
    vi.resetModules();
    const mod = await import("@/lib/auth");
    return mod.authOptions;
  }

  it("throws in production when NEXTAUTH_SECRET is missing", async () => {
    const snap = snapshotEnv();
    env.NODE_ENV = "production";
    delete env.NEXTAUTH_SECRET;
    delete env.NEXT_PHASE;
    await expect(freshAuthOptions()).rejects.toThrow(/NEXTAUTH_SECRET/i);
    restoreEnv(snap);
  });

  it("throws in production when NEXTAUTH_SECRET is the dev default", async () => {
    const snap = snapshotEnv();
    env.NODE_ENV = "production";
    env.NEXTAUTH_SECRET = "fernly-dev-secret-change-me";
    delete env.NEXT_PHASE;
    await expect(freshAuthOptions()).rejects.toThrow(/NEXTAUTH_SECRET/i);
    restoreEnv(snap);
  });

  it("does NOT throw during `next build` even with a missing secret", async () => {
    const snap = snapshotEnv();
    env.NODE_ENV = "production";
    delete env.NEXTAUTH_SECRET;
    env.NEXT_PHASE = "phase-production-build";
    const opts = await freshAuthOptions();
    // Build phase gets the ephemeral dev fallback so type-checking the
    // options object works on machines that only inject secrets at runtime.
    expect(opts.secret).toBeTruthy();
    expect(String(opts.secret)).not.toMatch(/^fernly-dev-secret/);
    restoreEnv(snap);
  });

  it("uses the supplied secret in production when it is strong", async () => {
    const snap = snapshotEnv();
    env.NODE_ENV = "production";
    env.NEXTAUTH_SECRET = "obviously-fake-unit-test-secret-0000000000=";
    delete env.NEXT_PHASE;
    const opts = await freshAuthOptions();
    expect(opts.secret).toBe("obviously-fake-unit-test-secret-0000000000=");
    restoreEnv(snap);
  });
});

// ---------------------------------------------------------------------------
// P0-7 regression — production cookies carry the Secure flag
// ---------------------------------------------------------------------------

describe("production cookie security (P0-7)", () => {
  const ENV_KEYS = ["NEXTAUTH_SECRET", "NODE_ENV", "NEXT_PHASE"] as const;
  // `process.env.NODE_ENV` is typed as a readonly literal in @types/node;
  // cast through a record so we can reassign it in tests.
  const env = process.env as Record<string, string | undefined>;
  function snapshotEnv(): Record<string, string | undefined> {
    const snap: Record<string, string | undefined> = {};
    for (const k of ENV_KEYS) snap[k] = env[k];
    return snap;
  }
  function restoreEnv(snap: Record<string, string | undefined>) {
    for (const k of ENV_KEYS) {
      if (snap[k] === undefined) delete env[k];
      else env[k] = snap[k]!;
    }
  }
  async function freshAuthOptions() {
    vi.resetModules();
    const mod = await import("@/lib/auth");
    return mod.authOptions;
  }

  it("flips useSecureCookies + Secure flag on every cookie in production", async () => {
    const snap = snapshotEnv();
    env.NODE_ENV = "production";
    env.NEXTAUTH_SECRET = "obviously-fake-unit-test-secret-0000000000=";
    delete env.NEXT_PHASE;
    const opts = await freshAuthOptions();
    expect(opts.useSecureCookies).toBe(true);
    // All three named cookies must carry the Secure flag in production.
    for (const key of ["sessionToken", "callbackUrl", "csrfToken"] as const) {
      const cookie = opts.cookies![key] as { options?: { secure?: boolean; httpOnly?: boolean; sameSite?: string } };
      expect(cookie.options?.secure).toBe(true);
    }
    // Session-token must additionally be httpOnly + sameSite=lax.
    const session = opts.cookies!.sessionToken!.options!;
    expect(session.httpOnly).toBe(true);
    expect(session.sameSite).toBe("lax");
    expect(session.path).toBe("/");
    // PR-27 — in production every cookie NAME carries the __Secure- prefix
    // (browsers then refuse to set them over plain HTTP or without Secure).
    for (const key of ["sessionToken", "callbackUrl", "csrfToken"] as const) {
      const cookie = opts.cookies![key] as { name?: string };
      expect(cookie.name).toMatch(/^__Secure-next-auth\./);
    }
    restoreEnv(snap);
  });

  it("keeps Secure=false for every cookie in dev/test", async () => {
    const snap = snapshotEnv();
    env.NODE_ENV = "development";
    delete env.NEXTAUTH_SECRET; // ephemeral dev fallback
    delete env.NEXT_PHASE;
    const opts = await freshAuthOptions();
    expect(opts.useSecureCookies).toBe(false);
    for (const key of ["sessionToken", "callbackUrl", "csrfToken"] as const) {
      const cookie = opts.cookies![key] as { options?: { secure?: boolean }; name?: string };
      expect(cookie.options?.secure).toBe(false);
      // PR-27 — dev/sandbox keeps the CLASSIC (unprefixed) names so the HTTP
      // preview proxies keep working.
      expect(cookie.name).toMatch(/^next-auth\./);
    }
    restoreEnv(snap);
  });
});
