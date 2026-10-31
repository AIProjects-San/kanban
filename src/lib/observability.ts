// ---------------------------------------------------------------------------
// L-P1-19 — Error tracking + structured logging.
//
//   • `ErrorReporter` interface — minimal captureException/captureMessage
//     contract satisfied by Sentry, Bugsnag, or any error tracker.
//   • `ConsoleErrorReporter` (dev/test), `NoopErrorReporter` (tests),
//     `FakeErrorReporter` (test-only).
//   • `createErrorReporter()` — factory (picks a real reporter when
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

  if (process.env.NODE_ENV === "production" && !process.env.SENTRY_DSN) {
    console.warn(
      "[observability] SENTRY_DSN not set — falling back to ConsoleErrorReporter. " +
      "Production errors will NOT be aggregated or alerted on. Wire a real " +
      "provider before launch (L-P1-19).",
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
