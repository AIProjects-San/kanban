import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Launch gate 12 regression — the audit-retention cron endpoint.
//
// The route must: refuse to run when CRON_SECRET is unset (503, so a
// misconfigured scheduler fails visibly), reject wrong/missing bearer
// tokens (401), and invoke the prune core with the synthetic cron actor on
// success. It must never leak audit contents.
// ---------------------------------------------------------------------------

vi.mock("@/lib/db", () => ({
  db: {
    workspace: { findUnique: vi.fn().mockResolvedValue({ auditRetentionDays: 180 }) },
    $executeRaw: vi.fn().mockResolvedValue(0),
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    // PR-17 — maintenance purges (deleteMany returns a count object).
    passwordResetToken: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    notification: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    messageRead: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
  },
}));

vi.mock("@/server-actions/shared", () => ({
  logAudit: vi.fn(),
}));

vi.mock("@/lib/observability", () => ({
  captureError: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const SECRET = "x".repeat(32); // meets the ≥16-char minimum

function mockRequest(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/cron/prune-audit", { headers });
}

describe("/api/cron/prune-audit (launch gate 12)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CRON_SECRET = SECRET;
    // PR-30 — force the in-memory lock backend so the overlap-guard tests
    // are deterministic (no REDIS_URL → no shared-client construction).
    delete process.env.REDIS_URL;
  });
  afterEach(() => {
    delete process.env.CRON_SECRET;
    delete process.env.REDIS_URL;
    vi.resetModules();
  });

  it("returns 503 (not 404) when CRON_SECRET is not configured", async () => {
    delete process.env.CRON_SECRET;
    const { GET } = await import("../route");
    const res = await GET(mockRequest());
    expect(res.status).toBe(503);
    expect((await res.json()).ok).toBe(false);
  });

  it("returns 503 when CRON_SECRET is too short to be safe", async () => {
    process.env.CRON_SECRET = "short";
    const { GET } = await import("../route");
    const res = await GET(mockRequest());
    expect(res.status).toBe(503);
  });

  it("rejects requests without a bearer token (401)", async () => {
    const { GET } = await import("../route");
    const res = await GET(mockRequest());
    expect(res.status).toBe(401);
  });

  it("rejects a wrong bearer token (401)", async () => {
    const { GET } = await import("../route");
    const res = await GET(mockRequest({ authorization: `Bearer ${"y".repeat(32)}` }));
    expect(res.status).toBe(401);
  });

  it("runs the prune and returns counters for a valid token", async () => {
    const { GET } = await import("../route");
    const res = await GET(mockRequest({ authorization: `Bearer ${SECRET}` }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.retentionDays).toBe(180);
    expect(body.deletedCount).toBe(0);
    // PR-17 — the maintenance purge counters are present.
    expect(body.purgedResetTokens).toBe(0);
    expect(body.purgedReadNotifications).toBe(0);
    expect(body.purgedStaleMessageReads).toBe(0);
    // The prune result only carries counters — never audit contents.
    expect(JSON.stringify(body)).not.toMatch(/actorName|detail/);
    // PR-30 — the response reports which lock backend guarded the run.
    expect(body.lockBackend).toBe("memory");
    expect(res.headers.get("cache-control")).toMatch(/no-store/i);
  });

  it("supports POST as well as GET (system crontabs)", async () => {
    const { POST } = await import("../route");
    const res = await POST(mockRequest({ authorization: `Bearer ${SECRET}` }));
    expect(res.status).toBe(200);
  });

  it("skips a second run within the one-hour window (overlap guard)", async () => {
    const { GET } = await import("../route");
    const first = await GET(mockRequest({ authorization: `Bearer ${SECRET}` }));
    expect(first.status).toBe(200);
    const second = await GET(mockRequest({ authorization: `Bearer ${SECRET}` }));
    expect(second.status).toBe(200);
    const body = await second.json();
    expect(body.skipped).toBe(true);
    expect(body.lockBackend).toBe("memory");
    // PR-30 — the skip reason names the window for operators reading logs.
    expect(body.reason).toMatch(/less than 60 minutes ago/);
  });

  it("returns 500 and captures the error when the prune throws", async () => {
    const { db } = await import("@/lib/db");
    (db.$executeRaw as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("db gone"));
    const { captureError } = await import("@/lib/observability");
    const { GET } = await import("../route");
    const res = await GET(mockRequest({ authorization: `Bearer ${SECRET}` }));
    expect(res.status).toBe(500);
    expect(captureError).toHaveBeenCalled();
  });
});
