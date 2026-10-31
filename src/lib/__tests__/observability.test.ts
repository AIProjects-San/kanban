import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  ConsoleErrorReporter,
  NoopErrorReporter,
  FakeErrorReporter,
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
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
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
