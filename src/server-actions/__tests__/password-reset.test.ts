import { describe, it, expect, vi, beforeEach } from "vitest";

// L-P0-11 — password reset flow tests.

const db = vi.hoisted(() => {
  const obj = {
    user: {} as Record<string, ReturnType<typeof vi.fn>>,
    passwordResetToken: {} as Record<string, ReturnType<typeof vi.fn>>,
    $transaction: vi.fn(),
  };
  for (const meth of ["findUnique", "findFirst", "findMany", "create", "update", "updateMany", "delete", "deleteMany", "count"]) {
    obj.user[meth] = vi.fn();
    obj.passwordResetToken[meth] = vi.fn();
  }
  return obj;
});

vi.mock("@/lib/db", () => ({ db }));

const hashPasswordMock = vi.fn();
const getMinPasswordLengthMock = vi.fn();
vi.mock("@/lib/password", () => ({
  hashPassword: (...a: unknown[]) => hashPasswordMock(...a),
  getMinPasswordLength: () => getMinPasswordLengthMock(),
}));

// Deep-dive review F-05 — control the reset-request limiter per test.
const limiterState = vi.hoisted(() => ({
  blocked: false,
  count: 0,
  hits: 0,
}));
vi.mock("@/lib/rate-limit-redis", () => {
  const makeLimiter = () => ({
    check: vi.fn(async () => ({ blocked: limiterState.blocked, count: limiterState.count, retryAfterSec: 0 })),
    hit: vi.fn(async () => {
      limiterState.hits++;
      return { blocked: false, count: limiterState.hits, retryAfterSec: 0 };
    }),
    reset: vi.fn(),
  });
  return {
    createLoginLimiter: makeLimiter,
    createPasswordResetLimiter: makeLimiter,
  };
});

// F-05 — the action reads the caller's IP from request headers.
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.9" }),
}));

const { FakeMailer, _resetMailerCacheForTests } = await import("@/lib/mailer");
const fakeMailer = new FakeMailer();
const createMailerMock = vi.fn(() => fakeMailer);
vi.mock("@/lib/mailer", async () => {
  const actual = await vi.importActual<typeof import("@/lib/mailer")>("@/lib/mailer");
  return {
    ...actual,
    createMailer: (...a: unknown[]) => createMailerMock(...(a as [])),
  };
});

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

import { requestPasswordReset, validateResetToken, resetPassword } from "../password-reset";

beforeEach(() => {
  vi.clearAllMocks();
  fakeMailer.clear();
  _resetMailerCacheForTests();
  limiterState.blocked = false;
  limiterState.count = 0;
  limiterState.hits = 0;
  getMinPasswordLengthMock.mockResolvedValue(8);
  db.user.findUnique.mockResolvedValue(null);
  db.passwordResetToken.findUnique.mockResolvedValue(null);
  db.passwordResetToken.create.mockResolvedValue({});
  // P2 (edge-case audit) — updateMany now returns { count } for the
  // conditional single-use enforcement. Mock it so resetPassword's
  // `result[1].count === 0` check passes (count = 1 = token consumed).
  db.passwordResetToken.updateMany.mockResolvedValue({ count: 1 });
  db.passwordResetToken.update.mockResolvedValue({});
  db.user.update.mockResolvedValue({});
  db.$transaction.mockResolvedValue([{}, { count: 1 }]);
  hashPasswordMock.mockResolvedValue("hashed-new-password");
});

const USER = { id: "u-1", name: "Ada", email: "ada@fernly.app", deletedAt: null };

describe("L-P0-11 requestPasswordReset", () => {
  it("sends a reset email when the user exists", async () => {
    db.user.findUnique.mockResolvedValue(USER);
    const res = await requestPasswordReset("ada@fernly.app");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.sent).toBe(true);
    expect(fakeMailer.sent.length).toBe(1);
    expect(fakeMailer.sent[0].to).toBe("ada@fernly.app");
    expect(fakeMailer.sent[0].subject).toMatch(/reset your password/i);
    expect(fakeMailer.sent[0].text).toMatch(/reset-password\?token=/);
  });

  it("returns sent:true even when the user does NOT exist (anti-enumeration)", async () => {
    db.user.findUnique.mockResolvedValue(null);
    const res = await requestPasswordReset("nobody@fernly.app");
    if (!res.ok) throw new Error("expected ok");
    expect(res.data.sent).toBe(true);
    expect(fakeMailer.sent.length).toBe(0);
  });

  it("returns sent:true when the user is soft-deleted (L-P0-14) — no email sent", async () => {
    db.user.findUnique.mockResolvedValue({ ...USER, deletedAt: new Date() });
    const res = await requestPasswordReset("ada@fernly.app");
    if (!res.ok) throw new Error("expected ok");
    expect(res.data.sent).toBe(true);
    expect(fakeMailer.sent.length).toBe(0);
  });

  it("invalidates existing unused tokens before creating a new one", async () => {
    db.user.findUnique.mockResolvedValue(USER);
    await requestPasswordReset("ada@fernly.app");
    expect(db.passwordResetToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: USER.id, usedAt: null },
        data: { usedAt: expect.any(Date) },
      }),
    );
    expect(db.passwordResetToken.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: USER.id,
          tokenHash: expect.any(String),
          expiresAt: expect.any(Date),
        }),
      }),
    );
  });

  it("stores the SHA-256 hash, never the raw token (DB-leak safety)", async () => {
    db.user.findUnique.mockResolvedValue(USER);
    await requestPasswordReset("ada@fernly.app");
    const createCall = db.passwordResetToken.create.mock.calls[0][0];
    expect(createCall.data.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(fakeMailer.sent[0].text).toMatch(/token=[A-Za-z0-9_-]{43}/);
  });

  it("continues gracefully if the mail send fails (best-effort)", async () => {
    db.user.findUnique.mockResolvedValue(USER);
    const errorMailer = { sendMail: vi.fn().mockRejectedValue(new Error("SMTP down")) };
    createMailerMock.mockReturnValueOnce(errorMailer as never);
    const res = await requestPasswordReset("ada@fernly.app");
    expect(res.ok).toBe(true);
  });

  // Deep-dive review F-05 — throttling must short-circuit BEFORE the DB and
  // still return sent:true (no oracle).
  it("returns sent:true WITHOUT touching the DB when throttled (F-05)", async () => {
    limiterState.blocked = true;
    limiterState.count = 5;
    db.user.findUnique.mockResolvedValue(USER);
    const res = await requestPasswordReset("ada@fernly.app");
    if (!res.ok) throw new Error("expected ok");
    expect(res.data.sent).toBe(true);
    expect(db.user.findUnique).not.toHaveBeenCalled();
    expect(db.passwordResetToken.create).not.toHaveBeenCalled();
    expect(fakeMailer.sent.length).toBe(0);
  });

  // Deep-dive review F-07 — the display name is user-editable and must be
  // HTML-escaped before landing in the email body.
  it("escapes the user's display name in the HTML email body (F-07)", async () => {
    db.user.findUnique.mockResolvedValue({
      ...USER,
      name: 'Ada <img src=x onerror="alert(1)">',
    });
    await requestPasswordReset("ada@fernly.app");
    expect(fakeMailer.sent.length).toBe(1);
    expect(fakeMailer.sent[0].html).not.toContain("<img src=x");
    expect(fakeMailer.sent[0].html).toContain("&lt;img src=x");
  });
});

describe("L-P0-11 validateResetToken", () => {
  it("returns valid:true for a fresh, unused, unexpired token", async () => {
    db.passwordResetToken.findUnique.mockResolvedValue({
      expiresAt: new Date(Date.now() + 60_000),
      usedAt: null,
    });
    const res = await validateResetToken("some-token");
    if (!res.ok) throw new Error("expected ok");
    expect(res.data).toEqual({ valid: true, expired: false, used: false });
  });

  it("returns expired:true when expiresAt is in the past", async () => {
    db.passwordResetToken.findUnique.mockResolvedValue({
      expiresAt: new Date(Date.now() - 60_000),
      usedAt: null,
    });
    const res = await validateResetToken("some-token");
    if (!res.ok) throw new Error("expected ok");
    expect(res.data.expired).toBe(true);
    expect(res.data.valid).toBe(false);
  });

  it("returns used:true when the token was already consumed", async () => {
    db.passwordResetToken.findUnique.mockResolvedValue({
      expiresAt: new Date(Date.now() + 60_000),
      usedAt: new Date(),
    });
    const res = await validateResetToken("some-token");
    if (!res.ok) throw new Error("expected ok");
    expect(res.data.used).toBe(true);
  });

  it("returns all-false when the token doesn't exist", async () => {
    db.passwordResetToken.findUnique.mockResolvedValue(null);
    const res = await validateResetToken("bogus");
    if (!res.ok) throw new Error("expected ok");
    expect(res.data).toEqual({ valid: false, expired: false, used: false });
  });
});

describe("L-P0-11 resetPassword", () => {
  const VALID_TOKEN_RECORD = {
    id: "t-1",
    userId: "u-1",
    expiresAt: new Date(Date.now() + 60_000),
    usedAt: null,
  };

  it("sets the new password + bumps tokenVersion + marks the token as used", async () => {
    db.passwordResetToken.findUnique.mockResolvedValue(VALID_TOKEN_RECORD);
    const res = await resetPassword({ token: "good-token", newPassword: "brand-new-pass" });
    expect(res.ok).toBe(true);
    expect(hashPasswordMock).toHaveBeenCalledWith("brand-new-pass");
    expect(db.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "u-1" },
        data: expect.objectContaining({
          passwordHash: "hashed-new-password",
          tokenVersion: { increment: 1 },
        }),
      }),
    );
    // P2 (edge-case audit) — resetPassword now uses updateMany (conditional
    // on usedAt: null) for single-use atomicity, not update.
    expect(db.passwordResetToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "t-1", usedAt: null },
        data: expect.objectContaining({ usedAt: expect.any(Date) }),
      }),
    );
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Array));
  });

  it("rejects when the token doesn't exist", async () => {
    db.passwordResetToken.findUnique.mockResolvedValue(null);
    const res = await resetPassword({ token: "bogus", newPassword: "brand-new-pass" });
    expect(res.ok).toBe(false);
  });

  it("rejects when the token was already used (single-use enforcement)", async () => {
    db.passwordResetToken.findUnique.mockResolvedValue({
      ...VALID_TOKEN_RECORD,
      usedAt: new Date(),
    });
    const res = await resetPassword({ token: "reused", newPassword: "brand-new-pass" });
    expect(res.ok).toBe(false);
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("rejects when the token has expired", async () => {
    db.passwordResetToken.findUnique.mockResolvedValue({
      ...VALID_TOKEN_RECORD,
      expiresAt: new Date(Date.now() - 60_000),
    });
    const res = await resetPassword({ token: "expired", newPassword: "brand-new-pass" });
    expect(res.ok).toBe(false);
  });

  it("rejects when the new password is too short", async () => {
    db.passwordResetToken.findUnique.mockResolvedValue(VALID_TOKEN_RECORD);
    const res = await resetPassword({ token: "good-token", newPassword: "short" });
    expect(res.ok).toBe(false);
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  // Deep-dive review F-06 — the reset flow must honour the workspace policy,
  // not a hardcoded 8.
  it("enforces the workspace-configured minimum length (F-06)", async () => {
    getMinPasswordLengthMock.mockResolvedValue(12);
    db.passwordResetToken.findUnique.mockResolvedValue(VALID_TOKEN_RECORD);
    // 11 characters — fine under the hardcoded-8 policy, too short for 12.
    const res = await resetPassword({ token: "good-token", newPassword: "elevenchars" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/at least 12/i);
    expect(db.$transaction).not.toHaveBeenCalled();
  });
});

describe("L-P1-11 mailer factory", () => {
  it("FakeMailer captures sent emails", async () => {
    const m = new FakeMailer();
    await m.sendMail({ to: "a@b.co", subject: "S", html: "<p>h</p>", text: "t" });
    expect(m.sent.length).toBe(1);
  });

  it("ConsoleMailer does not throw", async () => {
    const { ConsoleMailer } = await import("@/lib/mailer");
    const m = new ConsoleMailer();
    await expect(m.sendMail({ to: "a@b.co", subject: "S", html: "<p>h</p>", text: "t" })).resolves.toBeUndefined();
  });
});
