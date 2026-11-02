import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  ConsoleErrorReporter,
  NoopErrorReporter,
  FakeErrorReporter,
  SentryReporter,
  parseSentryDsn,
  createErrorReporter,
  _resetErrorReporterCacheForTests,
  structuredLog,
  log,
  getRequestId,
  withRequestId,
  generateRequestId,
  captureError,
  captureMessage,
} from "@/lib/observability";

// L-P1-19 — observability module tests.

describe("L-P1-19 ErrorReporter implementations", () => {
  it("FakeErrorReporter captures exceptions and messages", () => {
    const r = new FakeErrorReporter();
    const err = new Error("boom");
    r.captureException(err, { foo: "bar" });
    r.captureMessage("warning", { level: "warn" });
    expect(r.exceptions.length).toBe(1);
    expect(r.exceptions[0].err).toBe(err);
    expect(r.exceptions[0].context).toEqual({ foo: "bar" });
    expect(r.messages.length).toBe(1);
    expect(r.messages[0].msg).toBe("warning");
  });

  it("FakeErrorReporter.clear() resets both arrays", () => {
    const r = new FakeErrorReporter();
    r.captureException(new Error("x"));
    r.captureMessage("y");
    r.clear();
    expect(r.exceptions.length).toBe(0);
    expect(r.messages.length).toBe(0);
  });

  it("NoopErrorReporter does nothing", () => {
    const r = new NoopErrorReporter();
    r.captureException(new Error("x"));
    r.captureMessage("y");
  });

  it("ConsoleErrorReporter logs to console.error", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = new ConsoleErrorReporter();
    r.captureException(new Error("boom"), { ctx: 1 });
    r.captureMessage("msg", { ctx: 2 });
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });
});

describe("L-P1-19 createErrorReporter factory", () => {
  beforeEach(() => {
    _resetErrorReporterCacheForTests();
  });

  it("returns a ConsoleErrorReporter by default", () => {
    const r = createErrorReporter();
    expect(r).toBeInstanceOf(ConsoleErrorReporter);
  });

  it("returns an injected reporter when one is provided", () => {
    const fake = new FakeErrorReporter();
    const r = createErrorReporter({ reporter: fake });
    expect(r).toBe(fake);
  });

  it("caches the reporter for the process lifetime", () => {
    const a = createErrorReporter();
    const b = createErrorReporter();
    expect(a).toBe(b);
  });
});

describe("L-P1-19 request-id context", () => {
  it("getRequestId returns null outside a withRequestId context", () => {
    expect(getRequestId()).toBeNull();
  });

  it("withRequestId sets the request id for the duration of the handler", () => {
    const id = "req-123";
    withRequestId(id, () => {
      expect(getRequestId()).toBe(id);
    });
    expect(getRequestId()).toBeNull();
  });

  it("nested contexts restore the outer id after the inner completes", () => {
    withRequestId("outer", () => {
      expect(getRequestId()).toBe("outer");
      withRequestId("inner", () => {
        expect(getRequestId()).toBe("inner");
      });
      expect(getRequestId()).toBe("outer");
    });
  });

  it("generateRequestId produces unique ids", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      ids.add(generateRequestId());
    }
    expect(ids.size).toBe(1000);
  });
});

describe("L-P1-19 structuredLog", () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // structuredLog uses console.info (stdout) and console.error (stderr).
    stdoutSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    stderrSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it("writes a JSON line with level, msg, time, and requestId", () => {
    withRequestId("req-abc", () => {
      structuredLog("info", "test message", { extra: "field" });
    });
    expect(stdoutSpy).toHaveBeenCalled();
    const line = stdoutSpy.mock.calls[0][0] as string;
    const entry = JSON.parse(line);
    expect(entry.level).toBe("info");
    expect(entry.msg).toBe("test message");
    expect(entry.requestId).toBe("req-abc");
    expect(entry.extra).toBe("field");
    expect(entry.time).toBeTruthy();
  });

  it("writes warn/error to stderr, info/debug to stdout", () => {
    structuredLog("error", "err");
    structuredLog("warn", "warn");
    structuredLog("info", "info");
    structuredLog("debug", "debug");
    expect(stderrSpy).toHaveBeenCalledTimes(2);
    expect(stdoutSpy).toHaveBeenCalledTimes(2);
  });

  it("log convenience methods delegate to structuredLog", () => {
    log.error("e");
    log.warn("w");
    log.info("i");
    log.debug("d");
    expect(stderrSpy.mock.calls.length + stdoutSpy.mock.calls.length).toBe(4);
  });

  it("omits requestId when not inside a withRequestId context", () => {
    structuredLog("info", "no-request-id");
    const line = stdoutSpy.mock.calls[0][0] as string;
    const entry = JSON.parse(line);
    expect(entry.requestId).toBeNull();
  });
});

describe("L-P1-19 captureError / captureMessage", () => {
  beforeEach(() => {
    _resetErrorReporterCacheForTests();
  });

  it("captureError stamps the current requestId onto the context", () => {
    const fake = new FakeErrorReporter();
    createErrorReporter({ reporter: fake });
    const err = new Error("boom");
    withRequestId("req-xyz", () => {
      captureError(err, { source: "test" });
    });
    expect(fake.exceptions.length).toBe(1);
    expect(fake.exceptions[0].err).toBe(err);
    expect(fake.exceptions[0].context).toEqual({ source: "test", requestId: "req-xyz" });
  });

  it("captureMessage stamps the current requestId onto the context", () => {
    const fake = new FakeErrorReporter();
    createErrorReporter({ reporter: fake });
    withRequestId("req-msg", () => {
      captureMessage("something happened", { severity: "high" });
    });
    expect(fake.messages.length).toBe(1);
    expect(fake.messages[0].msg).toBe("something happened");
    expect(fake.messages[0].context).toEqual({ severity: "high", requestId: "req-msg" });
  });

  it("captureError works without a requestId context", () => {
    const fake = new FakeErrorReporter();
    createErrorReporter({ reporter: fake });
    captureError(new Error("no-ctx"));
    expect(fake.exceptions.length).toBe(1);
    expect(fake.exceptions[0].context).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Launch gate 10 — SentryReporter (fetch-based, no SDK dependency).
// ---------------------------------------------------------------------------

describe("SentryReporter (launch gate 10)", () => {
  it("parses a valid DSN into the store endpoint + public key", () => {
    const parsed = parseSentryDsn("https://abc123@o42.ingest.sentry.io/999888");
    expect(parsed).toEqual({
      endpoint: "https://o42.ingest.sentry.io/api/999888/store/",
      publicKey: "abc123",
      projectId: "999888",
    });
  });

  it("rejects malformed DSNs (no project id / wrong scheme)", () => {
    expect(parseSentryDsn("https://abc@host/notanumber")).toBeNull();
    expect(parseSentryDsn("http://abc@host/123")).toBeNull();
    expect(parseSentryDsn("garbage")).toBeNull();
  });

  it("POSTs exceptions to the store endpoint with type/value/stack", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fakeFetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(url),
        body: JSON.parse(String(init?.body)),
      });
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const reporter = new SentryReporter("https://abc123@o42.ingest.sentry.io/999888", {
      fetchImpl: fakeFetch,
      environment: "test",
    });
    reporter.captureException(new Error("kaboom"), { route: "/x" });
    // Fire-and-forget: let the microtask chain settle.
    await new Promise((r) => setTimeout(r, 10));
    expect(calls.length).toBe(1);
    expect(calls[0].url).toContain("https://o42.ingest.sentry.io/api/999888/store/");
    expect(calls[0].url).toContain("sentry_key=abc123");
    const values = (calls[0].body.exception as { values: Array<{ type: string; value: string }> }).values;
    expect(values[0].type).toBe("Error");
    expect(values[0].value).toBe("kaboom");
    expect(calls[0].body.environment).toBe("test");
    expect((calls[0].body.extra as { route: string }).route).toBe("/x");
  });

  it("POSTs messages with the message field", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const fakeFetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)));
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const reporter = new SentryReporter("https://abc123@o42.ingest.sentry.io/999888", {
      fetchImpl: fakeFetch,
    });
    reporter.captureMessage("watch this");
    await new Promise((r) => setTimeout(r, 10));
    expect(calls.length).toBe(1);
    expect(calls[0].message).toBe("watch this");
  });

  it("never throws when delivery fails — degrades to console.error", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fakeFetch = (async () => { throw new Error("network down"); }) as typeof fetch;
    const reporter = new SentryReporter("https://abc123@o42.ingest.sentry.io/999888", {
      fetchImpl: fakeFetch,
    });
    expect(() => reporter.captureMessage("m")).not.toThrow();
    await new Promise((r) => setTimeout(r, 10));
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("is selected by createErrorReporter when SENTRY_DSN is set", () => {
    _resetErrorReporterCacheForTests();
    process.env.SENTRY_DSN = "https://abc123@o42.ingest.sentry.io/999888";
    try {
      const reporter = createErrorReporter();
      expect(reporter).toBeInstanceOf(SentryReporter);
    } finally {
      delete process.env.SENTRY_DSN;
      _resetErrorReporterCacheForTests();
    }
  });

  it("falls back to ConsoleErrorReporter when SENTRY_DSN is invalid", () => {
    _resetErrorReporterCacheForTests();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.SENTRY_DSN = "not-a-dsn";
    try {
      const reporter = createErrorReporter();
      expect(reporter).toBeInstanceOf(ConsoleErrorReporter);
      expect(errSpy).toHaveBeenCalled();
    } finally {
      delete process.env.SENTRY_DSN;
      errSpy.mockRestore();
      _resetErrorReporterCacheForTests();
    }
  });
});

// ---------------------------------------------------------------------------
// P1 (production-readiness re-audit) — secret / PII redactor tests.
// ---------------------------------------------------------------------------

import { redactSecrets } from "@/lib/observability";

describe("redactSecrets", () => {
  it("redacts Bearer tokens", () => {
    expect(redactSecrets("Authorization: Bearer eyJabc.def.ghi"))
      .toBe("Authorization: Bearer [redacted]");
  });

  it("redacts database URLs with credentials", () => {
    const out = redactSecrets("DATABASE_URL=postgresql://postgres:secretpw@host:5432/db");
    expect(out).toContain("[redacted]@");
    expect(out).not.toContain("secretpw");
  });

  it("redacts email addresses", () => {
    expect(redactSecrets("user contact: ada@fernly.dev please"))
      .toBe("user contact: [email] please");
  });

  it("redacts password= query params", () => {
    const out = redactSecrets("?password=hunter2&api_key=sk_live_abc");
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("sk_live_abc");
    expect(out).toContain("[redacted]");
  });

  it("redacts JWTs", () => {
    const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123def456ghi789";
    const out = redactSecrets(`token=${jwt}`);
    // The JWT value must be gone — scrubbed as either [jwt] or [redacted]
    // (the token= pattern may consume the [jwt] placeholder; both are safe).
    expect(out).not.toContain(jwt);
    expect(out).toMatch(/\[(jwt|redacted)\]/);
  });

  it("redacts long base64 runs (>= 32 chars)", () => {
    const longKey = "sk_live_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789abcdef";
    const out = redactSecrets(`key: ${longKey}`);
    expect(out).not.toContain(longKey);
    expect(out).toContain("[redacted]");
  });

  it("walks objects + arrays recursively", () => {
    const input = {
      url: "postgresql://u:p@h/db",
      list: ["token=secret", { email: "x@y.com" }] as Array<string | { email: string }>,
      nested: { deep: "Bearer xyz123" },
      request_id: "550e8400-e29b-41d4-a716-446655440000",
    };
    const out = redactSecrets(input);
    expect(out.url).toContain("[redacted]@");
    expect(out.list[0]).toBe("[redacted]");
    expect((out.list[1] as { email: string }).email).toBe("[email]");
    expect(out.nested.deep).toBe("Bearer [redacted]");
    // request_id is preserved (it's a UUID, not a secret).
    expect(out.request_id).toBe("550e8400-e29b-41d4-a716-446655440000");
  });

  it("SentryReporter scrubs secrets before sending", () => {
    const calls: Array<{ url: string; body: string }> = [];
    const fakeFetch = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: String(init.body) });
      return new Response("{}", { status: 200 });
    });
    const reporter = new SentryReporter("https://abc@o42.ingest.sentry.io/999", {
      fetchImpl: fakeFetch as unknown as typeof fetch,
      sampleRate: 1,
    });
    reporter.captureException(
      new Error("connect failed: postgresql://postgres:secretpw@host:5432/db"),
      { user: "ada@fernly.dev" },
    );
    expect(fakeFetch).toHaveBeenCalledTimes(1);
    const body = calls[0].body;
    expect(body).not.toContain("secretpw");
    expect(body).not.toContain("ada@fernly.dev");
    expect(body).toContain("[redacted]");
    expect(body).toContain("[email]");
  });
});
