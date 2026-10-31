import { describe, it, expect, vi, beforeEach } from "vitest";

// L-P0-4 regression — the health endpoint.
vi.mock("@/lib/db", () => ({
  db: { $queryRaw: vi.fn() },
}));

const { db } = await import("@/lib/db");
const { GET } = await import("../route");

function mockRequest(query = "", headers: Record<string, string> = {}): Request {
  const url = query ? `http://localhost/api/health?${query}` : "http://localhost/api/health";
  return new Request(url, { headers });
}

// P2 (production-readiness re-audit) — the detailed db/redis breakdown is
// gated behind `?detail=1` + `Authorization: Bearer <CRON_SECRET>`. The
// public endpoint returns only `{ status, timestamp }`. These helpers build
// authorized requests for the detailed-field tests.
const TEST_SECRET = "test-cron-secret-0123456789abcdef";

function authorizedRequest(query = ""): Request {
  return mockRequest(query ? `${query}&detail=1` : "detail=1", {
    authorization: `Bearer ${TEST_SECRET}`,
  });
}

describe("/api/health (L-P0-4)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Set CRON_SECRET so the authorized helper works.
    process.env.CRON_SECRET = TEST_SECRET;
  });

  it("returns 200 ok when the DB probe succeeds", async () => {
    (db.$queryRaw as ReturnType<typeof vi.fn>).mockResolvedValue([{ "?column?": 1 }]);
    const res = await GET(authorizedRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.db).toBe("up");
    expect(body.timestamp).toBeTruthy();
  });

  it("returns 503 down when the DB probe rejects", async () => {
    (db.$queryRaw as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("connection refused"));
    const res = await GET(authorizedRequest());
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.status).toBe("down");
    expect(body.db).toBe("down");
  });

  it("sets Cache-Control: no-store so LBs always re-probe", async () => {
    (db.$queryRaw as ReturnType<typeof vi.fn>).mockResolvedValue([{ "?column?": 1 }]);
    const res = await GET(mockRequest());
    expect(res.headers.get("cache-control")).toMatch(/no-store/i);
  });

  it("honours the ready=1 readiness flag without changing the probe logic", async () => {
    (db.$queryRaw as ReturnType<typeof vi.fn>).mockResolvedValue([{ "?column?": 1 }]);
    const res = await GET(authorizedRequest("ready=1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.readiness).toBe(true);
  });

  it("reports redis: 'unconfigured' when REDIS_URL is unset (authorized)", async () => {
    delete process.env.REDIS_URL;
    (db.$queryRaw as ReturnType<typeof vi.fn>).mockResolvedValue([{ "?column?": 1 }]);
    const res = await GET(authorizedRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.redis).toBe("unconfigured");
    // App is still "ok" — Redis being unset doesn't take us down (fail-open).
    expect(body.status).toBe("ok");
  });

  it("reports redis: 'down' when REDIS_URL is set but the client can't ping", async () => {
    const previous = process.env.REDIS_URL;
    process.env.REDIS_URL = "redis://localhost:6379";
    try {
      (db.$queryRaw as ReturnType<typeof vi.fn>).mockResolvedValue([{ "?column?": 1 }]);
      // getSharedRedisClient returns undefined when construction fails —
      // simulate by mocking the dynamic import.
      vi.doMock("@/lib/redis-client", () => ({
        getSharedRedisClient: () => undefined,
      }));
      // Re-import the route so it picks up the doMock.
      vi.resetModules();
      const { GET: freshGet } = await import("../route");
      const res = await freshGet(authorizedRequest());
      expect(res.status).toBe(200); // DB up → app still ok
      const body = await res.json();
      expect(body.redis).toBe("down");
      expect(body.status).toBe("ok");
    } finally {
      process.env.REDIS_URL = previous;
      vi.doUnmock("@/lib/redis-client");
      vi.resetModules();
    }
  });

  // -------------------------------------------------------------------------
  // P2 (production-readiness re-audit) — public endpoint hides db/redis.
  // -------------------------------------------------------------------------

  it("P2 re-audit: public (no auth) response hides db/redis status", async () => {
    (db.$queryRaw as ReturnType<typeof vi.fn>).mockResolvedValue([{ "?column?": 1 }]);
    const res = await GET(mockRequest()); // no auth header, no detail=1
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.db).toBeUndefined();
    expect(body.redis).toBeUndefined();
    expect(body.readiness).toBeUndefined();
    expect(body.timestamp).toBeTruthy();
  });

  it("P2 re-audit: detail=1 without auth still hides db/redis", async () => {
    (db.$queryRaw as ReturnType<typeof vi.fn>).mockResolvedValue([{ "?column?": 1 }]);
    const res = await GET(mockRequest("detail=1")); // detail but no auth
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.db).toBeUndefined();
    expect(body.redis).toBeUndefined();
  });

  it("P2 re-audit: detail=1 with wrong auth still hides db/redis", async () => {
    (db.$queryRaw as ReturnType<typeof vi.fn>).mockResolvedValue([{ "?column?": 1 }]);
    const res = await GET(mockRequest("detail=1", { authorization: "Bearer wrong-secret" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.db).toBeUndefined();
    expect(body.redis).toBeUndefined();
  });
});
