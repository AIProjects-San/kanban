import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mailer suite — covers every branch of src/lib/mailer.ts:
//   • ConsoleMailer / NoopMailer / FakeMailer behaviour (incl. the F-04
//     guarantee that NoopMailer never logs the body — reset tokens can't leak)
//   • ResendMailer success + provider-error paths (fetch mocked; the thrown
//     error must carry the status + hashed recipient, never the mail body)
//   • createMailer() factory wiring for all four environments, incl. caching
//
// Without this suite src/lib/** sits ~0.03pp under the 90% statement gate
// (see vitest.config.ts thresholds) — mailer.ts was the largest uncovered
// file in the layer.

const logInfoSpy = vi.fn();
const logErrorSpy = vi.fn();
vi.mock("@/lib/infra/observability", () => ({
  logInfo: (...args: unknown[]) => logInfoSpy(...args),
  logError: (...args: unknown[]) => logErrorSpy(...args),
}));

// hashPii is mocked so assertions on the scrubbed recipient are exact.
vi.mock("@/lib/infra/pii", () => ({
  hashPii: (value: string | undefined | null) =>
    value ? `h(${value})` : "unknown",
}));

import {
  ConsoleMailer,
  NoopMailer,
  ResendMailer,
  FakeMailer,
  createMailer,
  _resetMailerCacheForTests,
} from "@/lib/email/mailer";

const BASE = {
  to: "user@example.com",
  subject: "Reset your password",
  html: "<p>token SECRET-TOKEN</p>",
  text: "token SECRET-TOKEN",
};

describe("ConsoleMailer", () => {
  it("logs the full envelope + body (dev workflow for testing flows)", async () => {
    logInfoSpy.mockClear();
    const res = await new ConsoleMailer().sendMail(BASE);
    expect(res).toEqual({ delivered: false, messageId: null }); // not really sent
    expect(logInfoSpy).toHaveBeenCalledTimes(1);
    const line = logInfoSpy.mock.calls[0][0] as string;
    expect(line).toContain("[mail:console]");
    expect(line).toContain("user@example.com");
    expect(line).toContain("Reset your password");
    expect(line).toContain("SECRET-TOKEN"); // dev only — body IS logged
  });
});

describe("NoopMailer", () => {
  it("drops the mail and logs only the hashed recipient — never the body", async () => {
    logErrorSpy.mockClear();
    const res = await new NoopMailer().sendMail(BASE);
    expect(res).toEqual({ delivered: false, messageId: null }); // dropped
    expect(logErrorSpy).toHaveBeenCalledTimes(1);
    const line = logErrorSpy.mock.calls[0][0] as string;
    expect(line).toContain("[mail:noop]");
    expect(line).toContain("h(user@example.com)"); // PII scrubbed
    expect(line).not.toContain("SECRET-TOKEN"); // F-04: body never logged
    expect(line).toContain("RESEND_API_KEY"); // operator hint present
  });
});

describe("FakeMailer", () => {
  it("records sends and clears; reports delivered with a fake provider id", async () => {
    const mailer = new FakeMailer();
    const r1 = await mailer.sendMail(BASE);
    const r2 = await mailer.sendMail({ ...BASE, to: "second@example.com" });
    expect(r1).toEqual({ delivered: true, messageId: "fake-1" });
    expect(r2).toEqual({ delivered: true, messageId: "fake-2" });
    expect(mailer.sent).toHaveLength(2);
    expect(mailer.sent[0].to).toBe("user@example.com");
    expect(mailer.sent[1].to).toBe("second@example.com");
    mailer.clear();
    expect(mailer.sent).toHaveLength(0);
  });
});

describe("ResendMailer", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs the envelope to Resend with bearer auth on success", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(null, { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const mailer = new ResendMailer("re_test_key", "Fernly <noreply@fernly.app>");
    // 200 with an empty body: delivered, but no provider id to surface (the
    // .catch(() => null) branch in the R3 result parsing).
    await expect(mailer.sendMail(BASE)).resolves.toEqual({
      delivered: true,
      messageId: null,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [
      string,
      RequestInit & { body: string },
    ];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer re_test_key",
    );
    const body = JSON.parse(init.body) as Record<string, unknown>;
    expect(body.from).toBe("Fernly <noreply@fernly.app>");
    expect(body.to).toEqual(["user@example.com"]);
    expect(body.subject).toBe("Reset your password");
    expect(init.signal).toBeDefined(); // hard 10s timeout wired
  });

  it("surfaces the Resend message id for the MailOutbox audit trail (R3)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "re-abc-123" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const mailer = new ResendMailer("re_test_key", "Fernly <noreply@fernly.app>");
    await expect(mailer.sendMail(BASE)).resolves.toEqual({
      delivered: true,
      messageId: "re-abc-123",
    });
  });

  it("throws a status + hashed-recipient error on provider failure and never includes the mail body", async () => {
    // Response bodies are single-use — return a FRESH response per call.
    const fetchMock = vi.fn().mockImplementation(async () =>
      new Response("provider says: quota exceeded", { status: 422 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const mailer = new ResendMailer("re_test_key", "Fernly <noreply@fernly.app>");
    await expect(mailer.sendMail(BASE)).rejects.toThrow(
      /Resend API error 422 .*h\(user@example\.com\)/,
    );
    // The provider detail (first 300 chars) is included for ops, but the
    // mail BODY (which may contain single-use tokens) must not be.
    try {
      await mailer.sendMail(BASE);
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain("quota exceeded");
      expect(msg).not.toContain("SECRET-TOKEN");
    }
  });

  it("falls back to an empty detail string when reading the error body itself fails", async () => {
    const failing = new Response("x", { status: 500 });
    // Replace .text() with a rejecting version to exercise the `.catch(() => "")` branch.
    Object.defineProperty(failing, "text", {
      value: () => Promise.reject(new Error("stream consumed")),
    });
    const fetchMock = vi.fn().mockResolvedValue(failing);
    vi.stubGlobal("fetch", fetchMock);

    const mailer = new ResendMailer("re_test_key", "Fernly <noreply@fernly.app>");
    await expect(mailer.sendMail(BASE)).rejects.toThrow(
      /Resend API error 500/,
    );
  });
});

describe("createMailer factory", () => {
  beforeEach(() => {
    _resetMailerCacheForTests();
    logErrorSpy.mockClear();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    _resetMailerCacheForTests();
  });

  it("returns the injected mailer and caches it", () => {
    const injected = new FakeMailer();
    const first = createMailer({ mailer: injected });
    const second = createMailer();
    expect(first).toBe(injected);
    expect(second).toBe(injected);
  });

  it("uses ResendMailer when RESEND_API_KEY is set (MAIL_FROM respected)", () => {
    vi.stubEnv("RESEND_API_KEY", "re_env_key");
    vi.stubEnv("MAIL_FROM", "Custom <hello@custom.dev>");
    const mailer = createMailer();
    expect(mailer).toBeInstanceOf(ResendMailer);
    // Same instance on the next call (process-wide cache).
    expect(createMailer()).toBe(mailer);
  });

  it("falls back to DEFAULT_MAIL_FROM when MAIL_FROM is unset", () => {
    vi.stubEnv("RESEND_API_KEY", "re_env_key");
    vi.stubEnv("MAIL_FROM", "");
    expect(() => createMailer()).not.toThrow();
    expect(createMailer()).toBeInstanceOf(ResendMailer);
  });

  it("uses NoopMailer in production without a key — and warns at error level", () => {
    vi.stubEnv("RESEND_API_KEY", "");
    vi.stubEnv("NODE_ENV", "production");
    const mailer = createMailer();
    expect(mailer).toBeInstanceOf(NoopMailer);
    expect(logErrorSpy).toHaveBeenCalledTimes(1);
    expect(logErrorSpy.mock.calls[0][0] as string).toContain(
      "No transactional mail provider configured",
    );
  });

  it("uses ConsoleMailer outside production without a key", () => {
    vi.stubEnv("RESEND_API_KEY", "");
    vi.stubEnv("NODE_ENV", "test");
    expect(createMailer()).toBeInstanceOf(ConsoleMailer);
    expect(logErrorSpy).not.toHaveBeenCalled();
  });
});
