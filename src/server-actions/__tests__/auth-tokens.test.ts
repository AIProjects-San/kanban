import { describe, it, expect, vi, beforeEach } from "vitest";

// PR-54/PR-56 — the issueAuthToken SERVER ACTION. The /api/auth/token route
// has its own suite (route.test.ts); this one pins the action seam that
// browser clients call: the cookie-session requirement, the minted token's
// verifiability, and the ActionResult error mapping.

const { getSessionOrThrowMock } = vi.hoisted(() => ({
  getSessionOrThrowMock: vi.fn(),
}));

vi.mock("@/server-actions/auth-guard", () => ({
  getSessionOrThrow: () => getSessionOrThrowMock(),
  // toResult() instanceof-checks against this class — the mock must export
  // it (same pattern as p2-batch-2.test.ts).
  AuthorizationError: class AuthorizationError extends Error {
    readonly digest = "AuthorizationError";
    constructor(m: string) { super(m); this.name = "AuthorizationError"; }
  },
}));

process.env.BETTER_AUTH_SECRET = "auth-tokens-test-secret-0123456789a";

const { issueAuthToken } = await import("../auth-tokens");
const { verifyJwt } = await import("@/lib/jwt");
// The mocked module's class — toResult() instanceof-checks against THIS
// constructor, so the rejection must be a real instance of it.
const { AuthorizationError } = await import("@/server-actions/auth-guard");

const SESSION = {
  userId: "u-ada",
  role: "ADMIN" as const,
  name: "Ada Admin",
  email: "ada@fernly.dev",
};

describe("issueAuthToken (server action, PR-54)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("mints a verifiable 1-hour bearer token for the signed-in user", async () => {
    getSessionOrThrowMock.mockResolvedValue(SESSION);
    const res = await issueAuthToken();
    if (!res.ok) throw new Error("expected ok");
    expect(res.data.tokenType).toBe("Bearer");
    expect(res.data.expiresIn).toBe(3600);

    // The JWT crypto is real — round-trip the minted token.
    const decoded = verifyJwt(res.data.token);
    expect(decoded).not.toBeNull();
    if (!decoded) return;
    expect(decoded.sub).toBe("u-ada");
    expect(decoded.role).toBe("ADMIN");
    expect(decoded.name).toBe("Ada Admin");
    expect(decoded.email).toBe("ada@fernly.dev");
    expect(decoded.exp - decoded.iat).toBe(3600);
    // expiresAt in the payload is consistent with the token's own exp.
    expect(res.data.expiresAt).toBe(decoded.exp);
  });

  it("encodes the CALLER's identity — tokens are personal, not workspace keys", async () => {
    const member = { ...SESSION, userId: "u-mia", role: "MEMBER" as const, name: "Mia", email: "mia@fernly.dev" };
    getSessionOrThrowMock.mockResolvedValue(member);
    const res = await issueAuthToken();
    if (!res.ok) throw new Error("expected ok");
    const decoded = verifyJwt(res.data.token);
    expect(decoded?.sub).toBe("u-mia");
    expect(decoded?.role).toBe("MEMBER");
  });

  it("maps a missing session to { ok: false, code: AUTH } (never a throw)", async () => {
    // getSessionOrThrow throws AuthorizationError when unauthenticated —
    // toResult must convert it into the client-safe ActionResult shape.
    getSessionOrThrowMock.mockRejectedValue(
      new AuthorizationError("You must be signed in."),
    );
    const res = await issueAuthToken();
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("AUTH");
    expect(res.error).toContain("signed in");
  });
});
