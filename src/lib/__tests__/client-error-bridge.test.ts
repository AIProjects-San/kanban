// ---------------------------------------------------------------------------
// Client error bridge tests (completes L-P1-19).
//
// Covers both halves:
//   1. src/lib/client-error-bridge.ts installs window[ERROR_BRIDGE_KEY] and
//      POSTs a capped, generic payload to /api/client-errors.
//   2. The API route validates + forwards to captureError and never echoes
//      request data back.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Bridge half (jsdom provides window + fetch spy)
// ---------------------------------------------------------------------------

describe("client error bridge (src/lib/client-error-bridge.ts)", () => {
  const KEY = `__fernlyCaptureError`;

  beforeEach(() => {
    vi.resetModules();
    delete (window as unknown as Record<string, unknown>)[KEY];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 204 })),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function importBridge() {
    await import("@/lib/client-error-bridge");
    return (window as unknown as Record<string, unknown>)[KEY] as
      | ((e: unknown, m?: { digest?: string; source?: string }) => void)
      | undefined;
  }

  it("installs the capture function on window", async () => {
    const capture = await importBridge();
    expect(typeof capture).toBe("function");
  });

  it("POSTs a JSON payload with message, digest and source", async () => {
    const capture = await importBridge();
    capture!(new Error("boom"), { digest: "d-1", source: "app/error.tsx" });
    // Fire-and-forget — let the microtask queue drain.
    await new Promise((r) => setTimeout(r, 0));
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/client-errors");
    expect(init.method).toBe("POST");
    expect(init.keepalive).toBe(true);
    const body = JSON.parse(init.body as string);
    expect(body.message).toBe("boom");
    expect(body.digest).toBe("d-1");
    expect(body.source).toBe("app/error.tsx");
    expect(body.url).toContain("http");
  });

  it("stringifies non-Error values instead of crashing", async () => {
    const capture = await importBridge();
    expect(() => capture!("just a string")).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string).message).toBe("just a string");
  });

  it("truncates oversized stacks (payload cap)", async () => {
    const capture = await importBridge();
    const err = new Error("big");
    err.stack = "x".repeat(5000);
    capture!(err);
    await new Promise((r) => setTimeout(r, 0));
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string).stack.length).toBe(2000);
  });

  it("is idempotent — importing twice keeps one bridge", async () => {
    await importBridge();
    const first = (window as unknown as Record<string, unknown>)[KEY];
    await importBridge();
    expect((window as unknown as Record<string, unknown>)[KEY]).toBe(first);
  });

  it("uses the shared ERROR_BRIDGE_KEY constant (matches error.tsx)", async () => {
    const errorTsx = readFileSync(resolve(__dirname, "../../app/error.tsx"), "utf-8");
    expect(errorTsx).toMatch(/ERROR_BRIDGE_KEY/);
    await importBridge();
    expect((window as unknown as Record<string, unknown>)[KEY]).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Route half
// ---------------------------------------------------------------------------

vi.mock("@/lib/observability", () => ({
  captureError: vi.fn(),
}));

describe("POST /api/client-errors (route)", () => {
  it("rejects GET with 405", async () => {
    const { GET } = await import("@/app/api/client-errors/route");
    const res = await GET();
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("POST");
  });

  it("forwards a valid report to captureError and returns 204", async () => {
    const { captureError } = await import("@/lib/observability");
    const { POST } = await import("@/app/api/client-errors/route");
    const req = new Request("http://localhost/api/client-errors", {
      method: "POST",
      body: JSON.stringify({ message: "boom", digest: "d-1", source: "app/error.tsx" }),
    });
    const res = await POST(req as unknown as Parameters<typeof POST>[0]);
    expect(res.status).toBe(204);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(captureError).toHaveBeenCalledTimes(1);
    const [err, ctx] = (captureError as ReturnType<typeof vi.fn>).mock.calls[0];
    expect((err as Error).message).toBe("[client] boom");
    expect(ctx).toMatchObject({ source: "app/error.tsx", digest: "d-1" });
  });

  it("returns 204 (not an error) for malformed JSON — nothing to report", async () => {
    const { captureError } = await import("@/lib/observability");
    const { POST } = await import("@/app/api/client-errors/route");
    const req = new Request("http://localhost/api/client-errors", {
      method: "POST",
      body: "not-json{",
    });
    const res = await POST(req as unknown as Parameters<typeof POST>[0]);
    expect(res.status).toBe(204);
    expect(captureError).not.toHaveBeenCalled();
  });

  it("drops oversized payloads (8 KB cap) without reporting", async () => {
    const { captureError } = await import("@/lib/observability");
    const { POST } = await import("@/app/api/client-errors/route");
    const req = new Request("http://localhost/api/client-errors", {
      method: "POST",
      body: JSON.stringify({ message: "x".repeat(10 * 1024) }),
    });
    const res = await POST(req as unknown as Parameters<typeof POST>[0]);
    expect(res.status).toBe(204);
    expect(captureError).not.toHaveBeenCalled();
  });

  it("P1 re-audit: rejects cross-origin POSTs when APP_URL is set", async () => {
    const { captureError } = await import("@/lib/observability");
    const { POST } = await import("@/app/api/client-errors/route");
    process.env.APP_URL = "https://fernly.app";
    try {
      const req = new Request("https://fernly.app/api/client-errors", {
        method: "POST",
        headers: { origin: "https://evil.example" },
        body: JSON.stringify({ message: "flood" }),
      });
      const res = await POST(req as unknown as Parameters<typeof POST>[0]);
      expect(res.status).toBe(403);
      expect(captureError).not.toHaveBeenCalled();
    } finally {
      delete process.env.APP_URL;
    }
  });

  it("P1 re-audit: accepts same-origin POSTs when APP_URL is set", async () => {
    const { captureError } = await import("@/lib/observability");
    const { POST } = await import("@/app/api/client-errors/route");
    process.env.APP_URL = "https://fernly.app";
    try {
      const req = new Request("https://fernly.app/api/client-errors", {
        method: "POST",
        headers: { origin: "https://fernly.app" },
        body: JSON.stringify({ message: "boom" }),
      });
      const res = await POST(req as unknown as Parameters<typeof POST>[0]);
      expect(res.status).toBe(204);
      expect(captureError).toHaveBeenCalledTimes(1);
    } finally {
      delete process.env.APP_URL;
    }
  });

  // -------------------------------------------------------------------------
  // QA-9 — the no-config fallback. Browsers send `Origin` on EVERY fetch
  // POST (same-origin included), so the old `return !origin` rejected 100%
  // of real browser error reports with 403 whenever APP_URL/NEXTAUTH_URL
  // were unset — the bridge was silently dead in exactly the environments
  // that had never configured a canonical URL. The fallback must instead
  // compare Origin against the request's own Host.
  // -------------------------------------------------------------------------

  it("QA-9: accepts a same-origin POST that carries Origin when nothing is configured", async () => {
    const { captureError } = await import("@/lib/observability");
    const { POST } = await import("@/app/api/client-errors/route");
    // What a real browser sends: fetch POST to the page's own origin always
    // includes an Origin header equal to that origin.
    const req = new Request("http://localhost:3000/api/client-errors", {
      method: "POST",
      headers: { origin: "http://localhost:3000", host: "localhost:3000" },
      body: JSON.stringify({ message: "boom" }),
    });
    const res = await POST(req as unknown as Parameters<typeof POST>[0]);
    expect(res.status).toBe(204);
    expect(captureError).toHaveBeenCalledTimes(1);
  });

  it("QA-9: still rejects a cross-origin POST when nothing is configured", async () => {
    const { captureError } = await import("@/lib/observability");
    const { POST } = await import("@/app/api/client-errors/route");
    const req = new Request("http://localhost:3000/api/client-errors", {
      method: "POST",
      headers: { origin: "https://evil.example", host: "localhost:3000" },
      body: JSON.stringify({ message: "flood" }),
    });
    const res = await POST(req as unknown as Parameters<typeof POST>[0]);
    expect(res.status).toBe(403);
    expect(captureError).not.toHaveBeenCalled();
  });

  it("QA-9: Origin-less probes (curl-style) still pass when nothing is configured", async () => {
    const { captureError } = await import("@/lib/observability");
    const { POST } = await import("@/app/api/client-errors/route");
    const req = new Request("http://localhost:3000/api/client-errors", {
      method: "POST",
      body: JSON.stringify({ message: "boom" }),
    });
    const res = await POST(req as unknown as Parameters<typeof POST>[0]);
    expect(res.status).toBe(204);
    expect(captureError).toHaveBeenCalledTimes(1);
  });
});
