import { describe, it, expect, vi, beforeEach } from "vitest";

// PR-54 — /api/auth/token route tests. getSession + logAudit are mocked at
// the seam; the JWT crypto is REAL (signJwt/verifyJwt round-trip).

const { getSessionMock, logAuditMock, mockHeaderBag } = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  logAuditMock: vi.fn(async (_entry: unknown) => {}),
  mockHeaderBag: { current: new Headers() },
}));

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
  
  };
});
vi.mock("@/server-actions/shared", () => ({
  logAudit: (entry: unknown) => logAuditMock(entry),
}));
vi.mock("next/headers", () => ({
  headers: async () => mockHeaderBag.current,
}));

process.env.BETTER_AUTH_SECRET = "token-route-test-secret-0123456789ab";

const { POST, GET } = await import("../route");
const { verifyJwt } = await import("@/lib/jwt");

const SESSION = {
  userId: "u-mia",
  role: "MEMBER",
  name: "Mia Member",
  email: "mia@fernly.dev",
};

function json(res: Response) {
  return res.json() as Promise<Record<string, unknown>>;
}

describe("POST /api/auth/token (PR-54)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    logAuditMock.mockResolvedValue(undefined);
    mockHeaderBag.current = new Headers({
      "user-agent": "vitest-agent",
      "x-real-ip": "203.0.113.10",
    });
  });

  it("returns 401 when there is no session (no cookie, no bearer)", async () => {
    getSessionMock.mockResolvedValue(null);
    const res = await POST();
    expect(res.status).toBe(401);
    const body = await json(res);
    expect(body.ok).toBe(false);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("mints a verifiable 1-hour bearer token for a signed-in user", async () => {
    getSessionMock.mockResolvedValue(SESSION);
    const res = await POST();
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.ok).toBe(true);
    expect(body.tokenType).toBe("Bearer");
    expect(body.expiresIn).toBe(3600);
    expect(typeof body.token).toBe("string");

    // The returned token must verify against the real secret and carry the
    // user's identity.
    const decoded = verifyJwt(body.token as string);
    expect(decoded).not.toBeNull();
    if (!decoded) return;
    expect(decoded.sub).toBe("u-mia");
    expect(decoded.role).toBe("MEMBER");
    expect(decoded.email).toBe("mia@fernly.dev");
    expect(decoded.exp - decoded.iat).toBe(3600);

    // expiresAt is consistent with the token's own exp claim.
    expect(body.expiresAt).toBe(decoded.exp);
  });

  it("writes an auth.token_issued audit row with IP + user agent", async () => {
    getSessionMock.mockResolvedValue(SESSION);
    await POST();
    expect(logAuditMock).toHaveBeenCalledTimes(1);
    const entry = logAuditMock.mock.calls[0][0] as Record<string, unknown>;
    expect(entry.action).toBe("auth.token_issued");
    expect(entry.entityType).toBe("AUTH");
    expect(entry.entityLabel).toBe("mia@fernly.dev");
    expect(entry.ipAddress).toBe("203.0.113.10");
    expect(entry.userAgent).toBe("vitest-agent");
    expect(entry.actor).toMatchObject({ userId: "u-mia" });
  });

  it("never blocks minting when the audit write fails", async () => {
    getSessionMock.mockResolvedValue(SESSION);
    logAuditMock.mockRejectedValue(new Error("audit db down"));
    const res = await POST();
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.ok).toBe(true);
  });

  it("sets no-store so minted tokens never sit in a cache", async () => {
    getSessionMock.mockResolvedValue(SESSION);
    const res = await POST();
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("accepts a still-valid bearer token for refresh-before-expiry (getSession resolves it)", async () => {
    // getSession() resolves via the bearer path when the Authorization
    // header carries a valid JWT (auth-better.test.ts pins that seam); the
    // route itself just consumes whatever session getSession returns.
    getSessionMock.mockResolvedValue(SESSION);
    // JWTs are deterministic within a second (same iat/exp + payload +
    // secret → identical token), so pin the clock and advance it between
    // mints to observe distinct tokens.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      const first = await json(await POST());
      expect(first.ok).toBe(true);
      vi.setSystemTime(new Date("2026-01-01T00:00:30Z")); // +30s
      const second = await json(await POST());
      expect(second.ok).toBe(true);
      expect(second.token).not.toBe(first.token);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("GET /api/auth/token (PR-54)", () => {
  it("returns 405 with Allow: POST — minting is an explicit POST", async () => {
    const res = await GET();
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await json(res);
    expect(body.ok).toBe(false);
  });
});
