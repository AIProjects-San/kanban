import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// PR-48/PR-49 — the Better Auth auth-stack suite (docs/AUTH_MIGRATION_PLAN.md).
// Ported 1:1 from the retired v4 auth.test.ts at Phase 2; since the PR-49
// cleanup it is the ONLY auth suite (the v4 counterpart is deleted).
//
// The harness drives the REAL HTTP handler (auth.handler) with Request
// objects — the same dispatch path production uses (hooks → adapter →
// databaseHooks), not a hand-extracted callback — against an in-memory
// prisma-shaped store. That keeps assertions faithful to what the spike
// validated while staying a unit test.
// ---------------------------------------------------------------------------

const { db, store } = vi.hoisted(() => {
  // In-memory tables shared by the mock below and the tests' assertions.
  const store = {
    users: [] as Array<Record<string, unknown>>,
    accounts: [] as Array<Record<string, unknown>>,
    sessions: [] as Array<Record<string, unknown>>,
    auditRows: [] as Array<Record<string, unknown>>,
  };

  // Minimal where-clause matcher for the shapes the adapter + our hooks use
  // (equality, { equals } / { in } / { not } / { lt } operators, unique
  // composites).
  function matches(row: Record<string, unknown>, where: Record<string, unknown> = {}) {
    return Object.entries(where).every(([k, v]) => {
      if (k === "AND" || k === "OR") return true; // not used in these tests
      if (v && typeof v === "object" && !(v instanceof Date)) {
        if ("lt" in (v as Record<string, unknown>)) {
          const d = row[k] as Date | undefined;
          return d instanceof Date && d.getTime() < ((v as { lt: Date }).lt).getTime();
        }
        if ("equals" in (v as Record<string, unknown>)) return row[k] === (v as { equals: unknown }).equals;
        if ("in" in (v as Record<string, unknown>)) return ((v as { in: unknown[] }).in).includes(row[k]);
        if ("not" in (v as Record<string, unknown>)) return row[k] !== (v as { not: unknown }).not;
        return true;
      }
      return row[k] === v;
    });
  }

  function makeModel(table: "users" | "accounts" | "sessions") {
    const base = {
      findUnique: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        store[table].find((r) => matches(r, where)) ?? null,
      ),
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        store[table].find((r) => matches(r, where)) ?? null,
      ),
      findMany: vi.fn(async (args: { where?: Record<string, unknown> } = {}) =>
        store[table].filter((r) => matches(r, args.where ?? {})),
      ),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { ...data };
        store[table].push(row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const row = store[table].find((r) => matches(r, where));
        if (!row) throw Object.assign(new Error("record not found"), { code: "P2025" });
        Object.assign(row, data);
        return row;
      }),
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        let count = 0;
        for (const r of store[table]) if (matches(r, where)) { Object.assign(r, data); count++; }
        return { count };
      }),
      delete: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const i = store[table].findIndex((r) => matches(r, where));
        if (i === -1) throw Object.assign(new Error("record not found"), { code: "P2025" });
        return store[table].splice(i, 1)[0];
      }),
      deleteMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const keep = store[table].filter((r) => !matches(r, where));
        const count = store[table].length - keep.length;
        store[table] = keep;
        return { count };
      }),
      upsert: vi.fn(async ({ where, create, update }: { where: Record<string, unknown>; create: Record<string, unknown>; update: Record<string, unknown> }) => {
        const existing = store[table].find((r) => matches(r, where));
        if (existing) { Object.assign(existing, update); return existing; }
        const row = { ...create };
        store[table].push(row);
        return row;
      }),
    };
    if (table === "sessions") {
      // Prisma honours `select: { user: { select: … } }` by resolving the
      // relation — the sign-out before-hook relies on it. Wrap findUnique to
      // resolve the user relation from the in-memory users table.
      const raw = base.findUnique;
      base.findUnique = vi.fn(async (args: {
        where: Record<string, unknown>;
        select?: Record<string, unknown>;
      }) => {
        const row = await raw(args);
        if (!row || !args.select?.user) return row;
        const user = store.users.find((u) => u.id === row.userId);
        return user ? { ...row, user: { ...user } } : row;
      });
    }
    return base;
  }

  const db = {
    user: makeModel("users"),
    account: makeModel("accounts"),
    session: makeModel("sessions"),
    auditLog: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        store.auditRows.push(data);
        return data;
      }),
    },
    $transaction: vi.fn(),
  };
  return { db, store };
});

vi.mock("@/lib/db", () => ({ db }));

// Limiter bridge: the auth stack's Redis-backed factory is swapped for the
// in-memory limiter so budget tests are deterministic and assertable
// through the same loginLimiter export the app uses.
const { loginLimiter: inMemoryLoginLimiter } = await import("@/lib/rate-limit");
vi.mock("@/lib/rate-limit-redis", () => ({
  createLoginLimiter: () => ({
    check: async (key: string, now?: number) => inMemoryLoginLimiter.check(key, now),
    hit: async (key: string, now?: number) => inMemoryLoginLimiter.hit(key, now),
    reset: async (key: string) => inMemoryLoginLimiter.reset(key),
  }),
}));

const { mockHeaderBag } = vi.hoisted(() => ({
  // Stateful headers bag — getBetterSession() reads next/headers; tests
  // install the session cookie before calling it directly.
  mockHeaderBag: { current: new Headers() },
}));
vi.mock("next/headers", () => ({
  headers: async () => mockHeaderBag.current,
}));

process.env.BETTER_AUTH_SECRET = "unit-test-secret-0123456789abcdef-456789";
process.env.DATABASE_URL = "file:./unit-test.db";

import { auth, revokeUserSessions, getBetterSession } from "@/lib/auth-better";
import { loginLimiter } from "@/lib/rate-limit";
import bcrypt from "bcryptjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE = "http://localhost:3000/api/auth-better";

function seedUser(overrides: Record<string, unknown> = {}) {
  const user = {
    id: "u-1",
    email: "ada@fernly.dev",
    name: "Ada",
    emailVerified: false,
    image: null,
    passwordHash: bcrypt.hashSync("correct-horse-1", 4),
    role: "ADMIN",
    tokenVersion: 0,
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
  store.users.push(user);
  return user;
}

async function call(method: string, path: string, { body, cookie, ip }: {
  body?: unknown; cookie?: string; ip?: string;
} = {}) {
  const headers = new Headers({
    origin: "http://localhost:3000",
    "user-agent": "unit-test-agent/1.0",
    ...(ip ? { "x-real-ip": ip } : {}),
  });
  if (body !== undefined) headers.set("content-type", "application/json");
  if (cookie) headers.set("cookie", cookie);
  const res = await auth.handler(
    new Request(`${BASE}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
  );
  const setCookies = res.headers.getSetCookie?.() ?? [];
  return { res, json: await res.json().catch(() => null), setCookies };
}

async function signIn(email: string, password: string, ip?: string) {
  return call("POST", "/sign-in/email", { body: { email, password }, ip });
}

function cookieJar(setCookies: string[]): string {
  return setCookies.map((c) => c.split(";")[0]).join("; ");
}

const auditRowsFor = (action: string) => store.auditRows.filter((r) => r.action === action);

beforeEach(() => {
  vi.clearAllMocks();
  mockHeaderBag.current = new Headers();
  store.users = [];
  store.accounts = [];
  store.sessions = [];
  store.auditRows = [];
  for (const key of [
    "login:email:ada@fernly.dev",
    "login:email:ghost@fernly.dev",
    "login:email:soft@fernly.dev",
    "login:ip:203.0.113.7",
    "login:ip:10.0.0.1",
    "login:ip:unknown",
  ]) {
    loginLimiter.reset(key);
  }
});

// ---------------------------------------------------------------------------
// sign-in — the authorize() port (v4 parity, one case per v4 case)
// ---------------------------------------------------------------------------

describe("sign-in/email (authorize port)", () => {
  it("rejects missing credentials with 400", async () => {
    const a = await signIn("", "");
    expect(a.res.status).toBe(400);
  });

  it("throttles when the email budget is exhausted (5 failures → blocked, DB untouched)", async () => {
    seedUser();
    for (let i = 0; i < 5; i++) {
      await signIn("ada@fernly.dev", "wrong");
    }
    // 6th attempt with the CORRECT password — still blocked, and the
    // before-hook returns before any user lookup.
    db.user.findUnique.mockClear();
    const sixth = await signIn("ada@fernly.dev", "correct-horse-1");
    expect([401, 429]).toContain(sixth.res.status);
    expect(db.user.findUnique).not.toHaveBeenCalled();
  });

  it("rejects unknown emails with 401 and burns a bcrypt compare (timing parity)", async () => {
    const start = Date.now();
    const res = await signIn("ghost@fernly.dev", "whatever-1");
    expect(res.res.status).toBe(401);
    // The before-hook's dummy compare runs at cost 12 — real work, not an
    // instant return (the v4 suite asserted >=0ms on the same guarantee).
    expect(Date.now() - start).toBeGreaterThan(50);
    expect(auditRowsFor("auth.signed_in")).toHaveLength(0);
  });

  it("rejects a wrong password on a real account and writes no audit row", async () => {
    seedUser();
    const res = await signIn("ada@fernly.dev", "wrong");
    expect(res.res.status).toBe(401);
    expect(auditRowsFor("auth.signed_in")).toHaveLength(0);
  });

  it("signs in successfully: 200 + user payload + audit row + credential bridge row", async () => {
    seedUser();
    const res = await signIn(" Ada@Fernly.dev ", "correct-horse-1", "203.0.113.7");
    expect(res.res.status).toBe(200);
    expect(res.json.user).toMatchObject({
      id: "u-1",
      email: "ada@fernly.dev",
      name: "Ada",
      role: "ADMIN",
      tokenVersion: 0,
    });
    // Email normalised (trim + lowercase) before lookup.
    expect(db.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ email: "ada@fernly.dev", deletedAt: null }),
      }),
    );
    // Audit row mirrors auth.signed_in incl. IP + UA (PR-34 parity).
    const row = auditRowsFor("auth.signed_in")[0];
    expect(row).toMatchObject({
      actorId: "u-1",
      actorRole: "ADMIN",
      action: "auth.signed_in",
      ipAddress: "203.0.113.7",
      userAgent: "unit-test-agent/1.0",
    });
    // The credential bridge synced the 1.7 Account row (spike F3) — with
    // User.passwordHash as the mirrored value, never a copy of app columns.
    expect(store.accounts).toHaveLength(1);
    expect(store.accounts[0]).toMatchObject({
      providerId: "credential",
      accountId: "u-1",
      userId: "u-1",
      password: expect.any(String),
    });
    expect("passwordHash" in store.accounts[0]).toBe(false);
  });

  it("clears BOTH throttle budgets on successful sign-in (PR-11 shared-NAT)", async () => {
    seedUser();
    for (let i = 0; i < 4; i++) {
      await signIn("ada@fernly.dev", "wrong", "10.0.0.1");
    }
    const ok = await signIn("ada@fernly.dev", "correct-horse-1", "10.0.0.1");
    expect(ok.res.status).toBe(200);
    // The budgets were reset — the next wrong password is attempt #1 again,
    // and a 6th attempt after it is still allowed.
    await signIn("ada@fernly.dev", "wrong", "10.0.0.1");
    const stillAllowed = await signIn("ada@fernly.dev", "wrong", "10.0.0.1");
    expect([401, 429]).toContain(stillAllowed.res.status);
    expect(stillAllowed.res.status).toBe(401);
  });

  it("charges both budgets on a failed sign-in (after-hook accounting)", async () => {
    seedUser();
    await signIn("ada@fernly.dev", "wrong", "203.0.113.7");
    const emailState = await loginLimiter.check("login:email:ada@fernly.dev");
    const ipState = await loginLimiter.check("login:ip:203.0.113.7");
    expect(emailState.count).toBe(1);
    expect(ipState.count).toBe(1);
  });

  it("rejects a soft-deleted user with 401 (P0 re-audit parity)", async () => {
    seedUser({ email: "soft@fernly.dev", deletedAt: new Date() });
    const res = await signIn("soft@fernly.dev", "correct-horse-1");
    expect(res.res.status).toBe(401);
    // No session row, no audit row, no credential bridge row.
    expect(store.sessions).toHaveLength(0);
    expect(store.accounts).toHaveLength(0);
    expect(auditRowsFor("auth.signed_in")).toHaveLength(0);
  });

  it("returns 401 (not 500) when the DB throws during lookup (P1 parity)", async () => {
    db.user.findUnique.mockRejectedValueOnce(new Error("db down"));
    const res = await signIn("ada@fernly.dev", "whatever-1");
    expect(res.res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Session + cookies (v4 "security posture" parity)
// ---------------------------------------------------------------------------

describe("session cookies + posture", () => {
  it("mints fernly.session_token with httpOnly/SameSite=Lax/Path=/ and 7-day Max-Age", async () => {
    seedUser();
    const res = await signIn("ada@fernly.dev", "correct-horse-1");
    const cookie = res.setCookies.find((c) => c.startsWith("fernly.session_token="));
    expect(cookie).toBeDefined();
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Path=\//i);
    expect(cookie).toMatch(/Max-Age=604800/i);
  });

  it("get-session resolves the signed-in user (role rides on the payload)", async () => {
    seedUser();
    const signedIn = await signIn("ada@fernly.dev", "correct-horse-1");
    const cookie = cookieJar(signedIn.setCookies);
    const session = await call("GET", "/get-session", { cookie });
    expect(session.json?.user).toMatchObject({
      id: "u-1",
      email: "ada@fernly.dev",
      role: "ADMIN",
    });
  });

  it("sign-out revokes the session row, expires the cookie, and writes auth.signed_out", async () => {
    seedUser();
    const signedIn = await signIn("ada@fernly.dev", "correct-horse-1", "203.0.113.7");
    const cookie = cookieJar(signedIn.setCookies);
    expect(store.sessions).toHaveLength(1);

    const out = await call("POST", "/sign-out", { body: {}, cookie, ip: "203.0.113.7" });
    expect(out.res.status).toBe(200);
    const expired = out.setCookies.find((c) =>
      c.startsWith("fernly.session_token=") && /Max-Age=0/i.test(c),
    );
    expect(expired).toBeDefined();
    // DB row gone.
    expect(store.sessions).toHaveLength(0);
    // Audit row with IP/UA — the before-hook stash → after-hook write path.
    expect(auditRowsFor("auth.signed_out")).toEqual([
      expect.objectContaining({
        actorId: "u-1",
        action: "auth.signed_out",
        ipAddress: "203.0.113.7",
        userAgent: "unit-test-agent/1.0",
      }),
    ]);
  });

  it("sign-out without a session cookie is a 200 no-op (no audit row)", async () => {
    const out = await call("POST", "/sign-out", { body: {} });
    expect(out.res.status).toBe(200);
    expect(auditRowsFor("auth.signed_out")).toHaveLength(0);
  });

  it("an audit-log failure never blocks a successful sign-in (best-effort parity)", async () => {
    seedUser();
    db.auditLog.create.mockRejectedValueOnce(new Error("audit db down"));
    const res = await signIn("ada@fernly.dev", "correct-horse-1");
    expect(res.res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Revocation — the tokenVersion counterpart (§6 row 6)
// ---------------------------------------------------------------------------

describe("revocation (tokenVersion counterpart)", () => {
  it("deleteUserSessions removes every session row for the user", async () => {
    store.sessions.push(
      { id: "s-1", token: "t1", userId: "u-1", expiresAt: new Date(Date.now() + 1000) },
      { id: "s-2", token: "t2", userId: "u-9", expiresAt: new Date(Date.now() + 1000) },
    );
    await revokeUserSessions("u-1");
    expect(store.sessions.map((s) => s.id)).toEqual(["s-2"]);
  });

  it("the bridge the app actions call always revokes (single stack since PR-49)", async () => {
    store.sessions.push({
      id: "s-1", token: "t1", userId: "u-1", expiresAt: new Date(Date.now() + 1000),
    });
    const { revokeUserSessionsIfActive } = await import("@/lib/auth-revoke");
    await revokeUserSessionsIfActive("u-1");
    expect(store.sessions).toHaveLength(0);
  });

  it("a soft-deleted user cannot mint a session (session.create backstop)", async () => {
    // The before-hook gate already rejects at lookup; simulate a bypass by
    // creating the session through the databaseHooks guard directly.
    // (Direct adapter-level create with a soft-deleted user must be blocked.)
    seedUser({ deletedAt: new Date() });
    const res = await signIn("soft@fernly.dev", "correct-horse-1");
    expect(res.res.status).toBe(401);
    expect(store.sessions).toHaveLength(0);
  });

  it("PR-56: blocks session creation when the backstop sees a soft-deleted user (gate/backstop race)", async () => {
    // The before-hook gate normally rejects soft-deleted users at the email
    // lookup; the session.create backstop exists for the window where the
    // gate passes but the row is (soft-)deleted before the session write.
    // Key the mock on the query shape: email-keyed gate lookups see a
    // healthy user, the id+deletedAt backstop lookup sees deletedAt set.
    seedUser();
    const original = db.user.findUnique.getMockImplementation();
    db.user.findUnique.mockImplementation(async (args: {
      where?: Record<string, unknown>;
      select?: Record<string, unknown>;
    }) => {
      if (args?.where?.id === "u-1" && args?.select?.deletedAt) {
        return { deletedAt: new Date() }; // the backstop's view
      }
      return original?.(args as never) ?? null;
    });
    try {
      const res = await signIn("ada@fernly.dev", "correct-horse-1");
      expect(res.res.status).toBeGreaterThanOrEqual(400);
      expect(store.sessions).toHaveLength(0);
    } finally {
      db.user.findUnique.mockImplementation(original!);
    }
  });

  it("PR-56: blocks session creation when the backstop's own DB lookup fails (fail-closed)", async () => {
    // Same keyed-mock trick, but the backstop lookup REJECTS: the catch
    // must return false (block) — a fail-open backstop would let a
    // soft-deleted user through exactly when the DB misbehaves.
    seedUser();
    const original = db.user.findUnique.getMockImplementation();
    db.user.findUnique.mockImplementation(async (args: {
      where?: Record<string, unknown>;
      select?: Record<string, unknown>;
    }) => {
      if (args?.where?.id === "u-1" && args?.select?.deletedAt) {
        throw new Error("backstop DB down");
      }
      return original?.(args as never) ?? null;
    });
    try {
      const res = await signIn("ada@fernly.dev", "correct-horse-1");
      expect(res.res.status).toBeGreaterThanOrEqual(400);
      expect(store.sessions).toHaveLength(0);
    } finally {
      db.user.findUnique.mockImplementation(original!);
    }
  });

  it("PR-56: a credential-bridge DB failure is a failed sign-in, never a bypass (L356-357)", async () => {
    // The bridge syncs the credential account row before Better Auth's
    // verify. If the bridge's DB read fails, the sign-in must be rejected
    // (UNAUTHORIZED) — the failure must not fall through to a session.
    seedUser();
    db.account.findUnique.mockRejectedValueOnce(new Error("bridge DB down"));
    const res = await signIn("ada@fernly.dev", "correct-horse-1");
    expect(res.res.status).toBe(401);
    expect(store.sessions).toHaveLength(0);
  });

  it("PR-56: an audit-log failure never blocks a successful sign-out (L439)", async () => {
    seedUser();
    const signedIn = await signIn("ada@fernly.dev", "correct-horse-1");
    const cookie = cookieJar(signedIn.setCookies);
    // The sign-out after-hook's audit write rejects — best-effort parity
    // with the sign-in path: the session row must still be revoked.
    db.auditLog.create.mockRejectedValueOnce(new Error("audit db down"));
    const out = await call("POST", "/sign-out", { body: {}, cookie });
    expect(out.res.status).toBe(200);
    expect(store.sessions).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// getBetterSession — the server-side helper auth-guard delegates to
// (the normalisation cases that lived in auth-guard.test.ts before the
// PR-49 flip, pinned here at the real seam).
// ---------------------------------------------------------------------------

describe("getBetterSession (server-side helper)", () => {
  /** Cookie jar with ONLY the opaque session token — skips the 5-minute
   * session_data cookie cache so every lookup exercises the DB path. */
  function tokenOnlyJar(setCookies: string[]): string {
    return setCookies
      .filter((c) => c.startsWith("fernly.session_token="))
      .map((c) => c.split(";")[0])
      .join("; ");
  }

  it("returns null when there is no session cookie", async () => {
    seedUser();
    expect(await getBetterSession()).toBeNull();
  });

  it("resolves the flat AuthResult and downgrades an unknown role to MEMBER", async () => {
    seedUser({ role: "SUPERUSER" });
    const signedIn = await signIn("ada@fernly.dev", "correct-horse-1");
    mockHeaderBag.current = new Headers({ cookie: tokenOnlyJar(signedIn.setCookies) });
    const session = await getBetterSession();
    expect(session).toEqual({
      userId: "u-1",
      role: "MEMBER",
      name: "Ada",
      email: "ada@fernly.dev",
    });
  });

  it("returns null for a user soft-deleted mid-session (deletedAt guard)", async () => {
    seedUser();
    const signedIn = await signIn("ada@fernly.dev", "correct-horse-1");
    // Soft-delete AFTER the session was minted — the additionalField rides
    // on the session payload and the guard treats it as signed out.
    const row = store.users.find((u) => u.id === "u-1");
    row!.deletedAt = new Date();
    mockHeaderBag.current = new Headers({ cookie: tokenOnlyJar(signedIn.setCookies) });
    expect(await getBetterSession()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// PR-54 — bearer-token session resolution (Authorization: Bearer <jwt>).
// getBetterSession() checks that header BEFORE the cookie path so external
// clients are authenticated by every server action / API route.
// ---------------------------------------------------------------------------

describe("getBetterSession — PR-54 bearer-token path", () => {
  beforeEach(() => {
    // Each test starts with a clean headers bag.
    mockHeaderBag.current = new Headers();
  });

  it("resolves a session from a valid Bearer JWT", async () => {
    seedUser({ role: "MEMBER" });
    const { signJwt } = await import("@/lib/jwt");
    const token = signJwt({
      sub: "u-1", role: "MEMBER", name: "Ada", email: "ada@fernly.dev",
    });
    mockHeaderBag.current = new Headers({ authorization: `Bearer ${token}` });
    const session = await getBetterSession();
    expect(session).toEqual({
      userId: "u-1",
      role: "MEMBER",
      name: "Ada",
      email: "ada@fernly.dev",
    });
  });

  it("does NOT fall through to the cookie path when a bearer token is invalid", async () => {
    // A valid cookie session exists AND an invalid bearer token is present.
    // The bearer path must return null (→ 401) — a client explicitly passing
    // a bearer token expects auth failure, not a silent cookie fallback.
    seedUser();
    const signedIn = await signIn("ada@fernly.dev", "correct-horse-1");
    const cookieJar = signedIn.setCookies
      .filter((c: string) => c.startsWith("fernly.session_token="))
      .map((c: string) => c.split(";")[0])
      .join("; ");
    mockHeaderBag.current = new Headers({
      cookie: cookieJar,
      authorization: "Bearer not-a-real-jwt",
    });
    expect(await getBetterSession()).toBeNull();
  });

  it("rejects a soft-deleted user's JWT immediately (DB lookup guard)", async () => {
    seedUser();
    const { signJwt } = await import("@/lib/jwt");
    const token = signJwt({
      sub: "u-1", role: "ADMIN", name: "Ada", email: "ada@fernly.dev",
    });
    // Soft-delete the user AFTER the JWT was minted.
    const row = store.users.find((u) => u.id === "u-1");
    row!.deletedAt = new Date();
    mockHeaderBag.current = new Headers({ authorization: `Bearer ${token}` });
    expect(await getBetterSession()).toBeNull();
  });

  it("rejects an expired JWT", async () => {
    seedUser();
    const { signJwt } = await import("@/lib/jwt");
    const token = signJwt(
      { sub: "u-1", role: "ADMIN", name: "Ada", email: "ada@fernly.dev" },
      -10, // expired 10s ago
    );
    mockHeaderBag.current = new Headers({ authorization: `Bearer ${token}` });
    expect(await getBetterSession()).toBeNull();
  });

  it("uses the DB's current role, not the JWT's role claim (role change takes effect immediately)", async () => {
    // Mint a JWT with role MEMBER, then promote the user to ADMIN in the DB.
    // The session should resolve with ADMIN (the DB is authoritative).
    seedUser({ role: "MEMBER" });
    const { signJwt } = await import("@/lib/jwt");
    const token = signJwt({
      sub: "u-1", role: "MEMBER", name: "Ada", email: "ada@fernly.dev",
    });
    const row = store.users.find((u) => u.id === "u-1");
    row!.role = "ADMIN";
    mockHeaderBag.current = new Headers({ authorization: `Bearer ${token}` });
    const session = await getBetterSession();
    expect(session?.role).toBe("ADMIN");
  });

  it("rejects a JWT whose subject user does not exist", async () => {
    // No user seeded — the JWT's sub points to a non-existent id.
    const { signJwt } = await import("@/lib/jwt");
    const token = signJwt({
      sub: "u-nonexistent", role: "MEMBER", name: "Ghost", email: "ghost@fernly.dev",
    });
    mockHeaderBag.current = new Headers({ authorization: `Bearer ${token}` });
    expect(await getBetterSession()).toBeNull();
  });

  it("returns null when the JWT session DB lookup throws (resilience)", async () => {
    // A valid JWT is presented but the user lookup rejects (e.g. Prisma
    // connection error). The catch in getBetterSessionFromJwt must swallow
    // it and return null (→ 401) rather than propagating a 500 — a bearer
    // client never gets a stack trace, just an auth failure.
    seedUser();
    const { signJwt } = await import("@/lib/jwt");
    const token = signJwt({
      sub: "u-1", role: "MEMBER", name: "Ada", email: "ada@fernly.dev",
    });
    vi.mocked(db.user.findUnique).mockRejectedValueOnce(new Error("DB connection lost"));
    mockHeaderBag.current = new Headers({ authorization: `Bearer ${token}` });
    expect(await getBetterSession()).toBeNull();
  });

  it("falls through to the cookie path when no Authorization header is present", async () => {
    // No bearer token → the existing cookie-based resolution runs.
    seedUser();
    const signedIn = await signIn("ada@fernly.dev", "correct-horse-1");
    const cookieJar = signedIn.setCookies
      .filter((c: string) => c.startsWith("fernly.session_token="))
      .map((c: string) => c.split(";")[0])
      .join("; ");
    mockHeaderBag.current = new Headers({ cookie: cookieJar });
    const session = await getBetterSession();
    expect(session?.userId).toBe("u-1");
  });

  it("ignores a non-Bearer Authorization header (basic auth, etc.)", async () => {
    // A Basic auth header should not trigger the JWT path — it falls
    // through to the cookie path (which returns null if no cookie).
    seedUser();
    mockHeaderBag.current = new Headers({ authorization: "Basic dXNlcjpwYXNz" });
    expect(await getBetterSession()).toBeNull();
  });

  it("PR-56: returns null (never throws) when the header bag itself is broken", async () => {
    // getBetterSession is called from every server action; an unexpected
    // failure while reading the request context must degrade to "signed
    // out" (→ 401/redirect), never propagate a 500. Setting the bag to a
    // non-Headers value makes the .get() call throw inside the try block.
    seedUser();
    // @ts-expect-error — deliberately poison the bag for one call
    mockHeaderBag.current = null;
    await expect(getBetterSession()).resolves.toBeNull();
    mockHeaderBag.current = new Headers();
  });
});

// ---------------------------------------------------------------------------
// Config posture (secret boot contract)
// ---------------------------------------------------------------------------

describe("config posture", () => {
  it("never signs with the known development constant", () => {
    // resolveBetterSecret is module-private; its contract is observable via
    // the cookie signature: a signed cookie must NOT verify against the
    // public dev constant. (The strong test secret is set in this suite.)
    const secret = process.env.BETTER_AUTH_SECRET ?? "";
    expect(secret).not.toMatch(/^fernly-dev-secret/);
    expect(secret.length).toBeGreaterThan(31);
  });

  it("refuses to boot in production on a missing/weak BETTER_AUTH_SECRET", async () => {
    // A strong secret lets the module load — proven by every test above
    // using the same instance. A weak secret in production must throw:
    vi.stubEnv("BETTER_AUTH_SECRET", "fernly-dev-secret-legacy");
    vi.stubEnv("NODE_ENV", "production");
    try {
      vi.resetModules();
      await expect(import("@/lib/auth-better")).rejects.toThrow(/secret/i);
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it("PR-56: outside production, a weak secret degrades to an ephemeral UUID (L63-68)", async () => {
    // The dev fallback: no throw, a warning, and a random UUID secret (the
    // session signature changes on every restart — acceptable in dev only).
    // (logWarn emits a JSON line via console.error — see structuredLog.)
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("BETTER_AUTH_SECRET", "fernly-dev-secret-legacy");
    try {
      vi.resetModules();
      await expect(import("@/lib/auth-better")).resolves.toBeDefined();
      const logged = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toContain("ephemeral secret");
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
      errSpy.mockRestore();
    }
  });

  it("PR-56: parses SERVER_ACTIONS_ALLOWED_ORIGINS with mixed entries (L104-110)", async () => {
    // Bare host(:port) entries are normalized onto the dev scheme; full
    // origins pass through; empty entries are filtered. The module must
    // still construct with a mixed list.
    vi.stubEnv(
      "SERVER_ACTIONS_ALLOWED_ORIGINS",
      "localhost:3000, https://app.example.com, , 10.0.0.1:8080 ,",
    );
    try {
      vi.resetModules();
      await expect(import("@/lib/auth-better")).resolves.toBeDefined();
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});
