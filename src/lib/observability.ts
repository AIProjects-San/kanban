// ---------------------------------------------------------------------------
// L-P1-19 — Error tracking + structured logging.
//
//   • `ErrorReporter` interface — minimal captureException/captureMessage
//     contract satisfied by Sentry, Bugsnag, or any error tracker.
//   • `ConsoleErrorReporter` (dev/test), `NoopErrorReporter` (tests),
//     `FakeErrorReporter` (test-only), `SentryReporter` (production —
//     launch gate 10: posts to Sentry's store endpoint via plain fetch,
//     no SDK dependency, same pattern as the ResendMailer).
//   • `createErrorReporter()` — factory (picks SentryReporter when
//     SENTRY_DSN is set, falls back to ConsoleErrorReporter otherwise).
//   • `structuredLog()` — JSON-line logger with a request-id field.
//   • `getRequestId()` / `withRequestId()` — AsyncLocalStorage-based
//     request-id context.
//
// SERVER-ONLY: imports node:async_hooks. Never import from client components
// (client code uses the `window.__fernlyCaptureError` bridge instead).
// ---------------------------------------------------------------------------

import { AsyncLocalStorage } from "node:async_hooks";

export interface ErrorContext {
  [key: string]: unknown;
}

export interface ErrorReporter {
  captureException(err: unknown, context?: ErrorContext): void;
  captureMessage(msg: string, context?: ErrorContext): void;
}

export class ConsoleErrorReporter implements ErrorReporter {
  captureException(err: unknown, context?: ErrorContext): void {
    console.error("[error:captureException]", err, context ?? {});
  }
  captureMessage(msg: string, context?: ErrorContext): void {
    console.error("[error:captureMessage]", msg, context ?? {});
  }
}

export class NoopErrorReporter implements ErrorReporter {
  captureException(_err?: unknown, _context?: ErrorContext): void { /* noop */ }
  captureMessage(_msg?: string, _context?: ErrorContext): void { /* noop */ }
}

export class FakeErrorReporter implements ErrorReporter {
  readonly exceptions: Array<{ err: unknown; context?: ErrorContext }> = [];
  readonly messages: Array<{ msg: string; context?: ErrorContext }> = [];
  captureException(err: unknown, context?: ErrorContext): void {
    this.exceptions.push({ err, context });
  }
  captureMessage(msg: string, context?: ErrorContext): void {
    this.messages.push({ msg, context });
  }
  clear(): void {
    this.exceptions.length = 0;
    this.messages.length = 0;
  }
}

// ---------------------------------------------------------------------------
// SentryReporter — launch gate 10 ("Observability live: Sentry fed…").
//
// Posts events to Sentry's store endpoint using the DSN's public key — no
// SDK, no new dependency (the DSN public key is designed to be non-secret;
// the ingest endpoint rejects anything else). Fire-and-forget with a 5s
// abort: an outage of the error tracker must never slow a request. All
// failures degrade to console.error so the fallback still leaves a trace.
// ---------------------------------------------------------------------------

/** Parse a Sentry DSN into its store-endpoint pieces. Exported for tests. */
export function parseSentryDsn(dsn: string): {
  endpoint: string;
  publicKey: string;
  projectId: string;
} | null {
  // https://<publicKey>@<host>/<projectId>
  const m = dsn.match(/^https:\/\/([^@]+)@([^/]+)\/(\d+)$/);
  if (!m) return null;
  const [, publicKey, host, projectId] = m;
  return {
    endpoint: `https://${host}/api/${projectId}/store/`,
    publicKey,
    projectId,
  };
}

export class SentryReporter implements ErrorReporter {
  private readonly endpoint: string;
  private readonly publicKey: string;
  private readonly environment: string;
  private readonly release: string | undefined;
  private readonly sampleRate: number;
  private readonly fetchImpl: typeof fetch;

  constructor(
    dsn: string,
    opts?: {
      environment?: string;
      release?: string;
      sampleRate?: number;
      fetchImpl?: typeof fetch;
    },
  ) {
    const parsed = parseSentryDsn(dsn);
    if (!parsed) {
      throw new Error(
        "SentryReporter: invalid SENTRY_DSN (expected https://<key>@<host>/<project-id>)",
      );
    }
    this.endpoint = parsed.endpoint;
    this.publicKey = parsed.publicKey;
    this.environment = opts?.environment ?? process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? "production";
    this.release = opts?.release ?? process.env.SENTRY_RELEASE;
    this.sampleRate = opts?.sampleRate ?? Number(process.env.SENTRY_SAMPLE_RATE ?? "1");
    // Injectable for tests; global fetch in production.
    this.fetchImpl = opts?.fetchImpl ?? fetch;
  }

  captureException(err: unknown, context?: ErrorContext): void {
    const exceptionValue =
      err instanceof Error
        ? { type: err.name, value: err.message, stacktrace: { frames: stackFrames(err.stack) } }
        : { type: "Error", value: String(err) };
    this.send({ exception: { values: [exceptionValue] } }, context);
  }

  captureMessage(msg: string, context?: ErrorContext): void {
    this.send({ message: msg }, context);
  }

  private send(payload: Record<string, unknown>, context?: ErrorContext): void {
    if (this.sampleRate < 1 && Math.random() > this.sampleRate) return;
    const url =
      `${this.endpoint}?sentry_key=${encodeURIComponent(this.publicKey)}` +
      `&sentry_version=7&sentry_client=fernly%2F1.0`;
    const body = JSON.stringify({
      timestamp: new Date().toISOString(),
      platform: "node",
      environment: this.environment,
      ...(this.release ? { release: this.release } : {}),
      ...payload,
      extra: { ...context, request_id: getRequestId() ?? undefined },
      tags: { app: "fernly" },
    });
    void this.fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: AbortSignal.timeout(5_000),
    }).catch((err: unknown) => {
      console.error(
        "[observability] Sentry delivery failed (falling back to console):",
        err instanceof Error ? err.message : err,
      );
      console.error("[error:undelivered]", payload);
    });
  }
}

function stackFrames(stack: string | undefined): Array<Record<string, unknown>> {
  if (!stack) return [];
  // Coarse frames (file:line:col) — enough for grouping + a jump-off point.
  const lines = stack.split("\n").filter((l) => l.trim().startsWith("at "));
  return lines.slice(0, 30).map((line) => ({ filename: line.trim().slice(3) }));
}

let cachedErrorReporter: ErrorReporter | null = null;

export interface ErrorReporterFactoryOptions {
  /** Inject a custom reporter (used by tests + production wiring). */
  reporter?: ErrorReporter;
}

export function createErrorReporter(opts?: ErrorReporterFactoryOptions): ErrorReporter {
  if (cachedErrorReporter) return cachedErrorReporter;

  if (opts?.reporter) {
    cachedErrorReporter = opts.reporter;
    return cachedErrorReporter;
  }

  // Launch gate 10 — a real provider when SENTRY_DSN is configured.
  if (process.env.SENTRY_DSN) {
    try {
      cachedErrorReporter = new SentryReporter(process.env.SENTRY_DSN);
      console.info("[observability] SentryReporter active (SENTRY_DSN set)");
      return cachedErrorReporter;
    } catch (err) {
      console.error(
        "[observability] SENTRY_DSN is set but invalid — falling back to ConsoleErrorReporter:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  if (process.env.NODE_ENV === "production" && !process.env.SENTRY_DSN) {
    console.warn(
      "[observability] SENTRY_DSN not set — falling back to ConsoleErrorReporter. " +
      "Production errors will NOT be aggregated or alerted on. Set SENTRY_DSN " +
      "before launch to close launch gate 10 (L-P1-19).",
    );
  }

  cachedErrorReporter = new ConsoleErrorReporter();
  return cachedErrorReporter;
}

/** Test-only: reset the cached reporter so a new one is created on next call. */
export function _resetErrorReporterCacheForTests(): void {
  cachedErrorReporter = null;
}

// ---------------------------------------------------------------------------
// Request-id context (AsyncLocalStorage)
// ---------------------------------------------------------------------------

const requestIdStorage = new AsyncLocalStorage<string>();

/** Get the current request id, or null if not inside a request context. */
export function getRequestId(): string | null {
  return requestIdStorage.getStore() ?? null;
}

/**
 * Run a handler with a request id in context. All `structuredLog()` calls
 * inside the handler (and any code it calls) automatically stamp the
 * request id without threading it through every function signature.
 */
export function withRequestId<T>(requestId: string, fn: () => T): T {
  return requestIdStorage.run(requestId, fn);
}

/** Generate a new request id (UUID-like, no dependency). */
export function generateRequestId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// ---------------------------------------------------------------------------
// Structured logger
// ---------------------------------------------------------------------------

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function minLevel(): LogLevel {
  const env = (process.env.LOG_LEVEL ?? "").toLowerCase() as LogLevel;
  if (env in LEVEL_PRIORITY) return env;
  return process.env.NODE_ENV === "production" ? "info" : "debug";
}

/**
 * Structured JSON logger. One JSON object per line with `level`, `msg`,
 * `time` (ISO), `requestId` (from AsyncLocalStorage, if set), and any extra
 * context fields. Designed for log aggregators (Loki, Datadog) that parse
 * JSON. warn/error → stderr; info/debug → stdout.
 */
export function structuredLog(level: LogLevel, msg: string, context?: ErrorContext): void {
  if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[minLevel()]) return;

  const entry = {
    level,
    msg,
    time: new Date().toISOString(),
    requestId: getRequestId(),
    ...context,
  };

  if (level === "error" || level === "warn") {
    process.stderr.write(JSON.stringify(entry) + "\n");
  } else {
    process.stdout.write(JSON.stringify(entry) + "\n");
  }
}

export const log = {
  debug: (msg: string, context?: ErrorContext) => structuredLog("debug", msg, context),
  info: (msg: string, context?: ErrorContext) => structuredLog("info", msg, context),
  warn: (msg: string, context?: ErrorContext) => structuredLog("warn", msg, context),
  error: (msg: string, context?: ErrorContext) => structuredLog("error", msg, context),
};

// ---------------------------------------------------------------------------
// Convenience: capture an error/message with the current request id stamped.
// ---------------------------------------------------------------------------

export function captureError(err: unknown, context?: ErrorContext): void {
  const reporter = createErrorReporter();
  const requestId = getRequestId();
  reporter.captureException(err, { ...context, ...(requestId ? { requestId } : {}) });
}

export function captureMessage(msg: string, context?: ErrorContext): void {
  const reporter = createErrorReporter();
  const requestId = getRequestId();
  reporter.captureMessage(msg, { ...context, ...(requestId ? { requestId } : {}) });
}
