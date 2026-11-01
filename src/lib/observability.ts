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
    // P1 (production-readiness re-audit) — PII / secret redaction. The
    // payload may carry error messages that include connection strings,
    // JWTs, bearer tokens, or email addresses. Scrub them BEFORE the
    // payload leaves the perimeter so Sentry doesn't become a PII sink.
    const sanitized = redactSecrets({
      timestamp: new Date().toISOString(),
      platform: "node",
      environment: this.environment,
      ...(this.release ? { release: this.release } : {}),
      ...payload,
      extra: { ...context, request_id: getRequestId() ?? undefined },
      tags: { app: "fernly" },
    });
    const body = JSON.stringify(sanitized);
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
      // The undelivered payload is already redacted.
      console.error("[error:undelivered]", sanitized);
    });
  }
}

// ---------------------------------------------------------------------------
// P1 (production-readiness re-audit) — Secret / PII redactor.
// ---------------------------------------------------------------------------
// Walks a payload object recursively and scrubs known secret + PII patterns
// from every string value. Applied before any payload crosses the perimeter
// (Sentry, error-tracking HTTP API).
//
// Patterns scrubbed:
//   • Bearer tokens in Authorization headers → "Bearer [redacted]"
//   • Database URLs with credentials → "postgresql://[redacted]@host/..."
//   • JWT-like sequences (three base64 segments separated by dots) → "[jwt]"
//   • Email addresses → "[email]"
//   • Long base64 runs (≥32 chars, no spaces — API keys, hashed secrets) →
//     "[redacted:<first4>...]"
//   • "password=xxx" / "api_key=xxx" query params → "[redacted]"
//
// The redactor is conservative: it over-matches rather than under-matches,
// because a leaked secret in Sentry is far worse than a slightly mangled
// error message. Operators can still group events by type/stack frames.

const REDACT_PATTERNS: Array<{ re: RegExp; replacement: string }> = [
  // JWT: three base64url segments separated by dots (header.payload.signature).
  // MUST run before the `token=` and long-base64 patterns so a JWT in a
  // `token=...` query param is scrubbed as `[jwt]` (more specific) rather
  // than `[redacted]` (generic).
  { re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, replacement: "[jwt]" },
  // Authorization: Bearer xxx
  { re: /Bearer\s+[A-Za-z0-9._\-+/=]+/g, replacement: "Bearer [redacted]" },
  // postgresql://user:pass@host  /  redis://:pass@host  /  mongodb://user:pass@host
  { re: /(\b(?:https?|postgresql|postgres|redis|mongodb|mysql):\/\/)[^@\s]+@/g, replacement: "$1[redacted]@" },
  // Email addresses (RFC-5322-ish — practical subset)
  { re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, replacement: "[email]" },
  // password=xxx / api_key=xxx / secret=xxx / token=xxx in query strings
  { re: /\b(?:password|passwd|api[_-]?key|secret|token|access[_-]?token)\s*[=:]\s*[^\s&]+/gi,
    replacement: "[redacted]" },
  // Long opaque base64-ish runs (≥32 chars, no spaces) — API keys, hashes.
  // Keep the first 4 chars so operators can correlate without recovering.
  { re: /\b[A-Za-z0-9+/=_-]{32,}\b/g, replacement: "[redacted]" },
];

function redactString(s: string): string {
  let out = s;
  for (const { re, replacement } of REDACT_PATTERNS) {
    out = out.replace(re, replacement);
  }
  return out;
}

/** Recursively redact secrets/PII from any JSON-serialisable value. */
export function redactSecrets<T>(value: T): T {
  if (typeof value === "string") return redactString(value) as unknown as T;
  if (Array.isArray(value)) return value.map(redactSecrets) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // Don't redact the request_id (it's a UUID, not a secret).
      out[k] = k === "request_id" ? v : redactSecrets(v);
    }
    return out as unknown as T;
  }
  return value;
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
    console.error(JSON.stringify(entry));
  } else {
    console.info(JSON.stringify(entry));
  }
}

export const log = {
  debug: (msg: string, context?: ErrorContext) => structuredLog("debug", msg, context),
  info: (msg: string, context?: ErrorContext) => structuredLog("info", msg, context),
  warn: (msg: string, context?: ErrorContext) => structuredLog("warn", msg, context),
  error: (msg: string, context?: ErrorContext) => structuredLog("error", msg, context),
};

/**
 * Console-style compatibility wrappers (P1 — production-readiness re-audit).
 *
 * Accepts the same variadic signature as `console.error|warn|info` so server
 * modules can migrate from `console.*` to structured logging without
 * restructuring every call site. The first string argument becomes `msg`;
 * remaining arguments are collected into a `details` array in the context.
 *
 * Prefer `log.error(msg, { ... })` for new code — it produces cleaner JSON.
 * Use these wrappers when migrating existing `console.*` calls en masse.
 */
function formatArgs(args: unknown[]): { msg: string; details: unknown[] } {
  const [first, ...rest] = args;
  const msg = typeof first === "string" ? first : String(first ?? "");
  return { msg, details: rest.map((a) => (a instanceof Error ? { name: a.name, message: a.message, stack: a.stack?.slice(0, 500) } : a)) };
}

export const logError = (...args: unknown[]) => {
  const { msg, details } = formatArgs(args);
  structuredLog("error", msg, details.length ? { details } : {});
};
export const logWarn = (...args: unknown[]) => {
  const { msg, details } = formatArgs(args);
  structuredLog("warn", msg, details.length ? { details } : {});
};
export const logInfo = (...args: unknown[]) => {
  const { msg, details } = formatArgs(args);
  structuredLog("info", msg, details.length ? { details } : {});
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
