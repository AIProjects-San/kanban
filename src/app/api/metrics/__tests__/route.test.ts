import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// PR-32 (production-readiness round 2) — the Prometheus metrics endpoint.
//
// Contract under test:
//   • 503 (visibly disabled) when CRON_SECRET is unset/too short — a metrics
//     endpoint must never silently appear.
//   • 401 for missing/wrong bearer tokens.
//   • 200 + the Prometheus text format (0.0.4) for authorized callers, with
//     infrastructure gauges only (no business data).
//   • fernly_redis_up / maintenance freshness appear only when configured.
//   • The endpoint still reports (200, app_up 0) when the DB is DOWN — a
//     monitoring target that reports its own death beats one that vanishes.
// ---------------------------------------------------------------------------

vi.mock("@/lib/infra/health-probes", () => ({
  probeDb: vi.fn(),
  probeRedis: vi.fn(),
  measureEventLoopLagMs: vi.fn(async () => 1.5),
}));

vi.mock("@/lib/infra/maintenance-lock", () => ({
  getMaintenanceLastRun: vi.fn(),
}));

const { probeDb, probeRedis } = await import("@/lib/infra/health-probes");
const { getMaintenanceLastRun } = await import("@/lib/infra/maintenance-lock");
const { GET } = await import("../route");

const SECRET = "metrics-cron-secret-0123456789"; // ≥16 chars

function mockRequest(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/metrics", { headers });
}

describe("/api/metrics (PR-32)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CRON_SECRET = SECRET;
    delete process.env.REDIS_URL;
    (probeDb as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    (probeRedis as ReturnType<typeof vi.fn>).mockResolvedValue("unconfigured");
    (getMaintenanceLastRun as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  });
  afterEach(() => {
    delete process.env.CRON_SECRET;
  });

  it("returns 503 (visibly disabled) when CRON_SECRET is not configured", async () => {
    delete process.env.CRON_SECRET;
    const res = await GET(mockRequest());
    expect(res.status).toBe(503);
    expect((await res.json()).ok).toBe(false);
  });

  it("returns 503 when CRON_SECRET is too short to be safe", async () => {
    process.env.CRON_SECRET = "short";
    const res = await GET(mockRequest({ authorization: "Bearer short" }));
    expect(res.status).toBe(503);
  });

  it("rejects requests without a bearer token (401)", async () => {
    const res = await GET(mockRequest());
    expect(res.status).toBe(401);
  });

  it("rejects a wrong bearer token (401)", async () => {
    const res = await GET(
      mockRequest({ authorization: `Bearer ${"z".repeat(SECRET.length)}` }),
    );
    expect(res.status).toBe(401);
  });

  it("serves the Prometheus text format with the core gauges", async () => {
    const res = await GET(mockRequest({ authorization: `Bearer ${SECRET}` }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(res.headers.get("cache-control")).toMatch(/no-store/i);
    const text = await res.text();
    // Core families present with HELP/TYPE headers (required by the format).
    for (const metric of [
      "fernly_app_up",
      "fernly_db_up",
      "fernly_process_uptime_seconds",
      "fernly_process_memory_resident_bytes",
      "fernly_process_memory_heap_used_bytes",
      "fernly_nodejs_eventloop_lag_ms",
    ]) {
      expect(text).toContain(`# HELP ${metric} `);
      expect(text).toContain(`# TYPE ${metric} gauge`);
      expect(text).toMatch(new RegExp(`^${metric} [0-9]`, "m"));
    }
    expect(text).toContain("fernly_app_up 1");
    expect(text).toContain("fernly_nodejs_eventloop_lag_ms 1.5");
    // Redis unconfigured → the family is omitted entirely.
    expect(text).not.toContain("fernly_redis_up");
    expect(text).not.toContain("fernly_maintenance_last_run");
    // Infrastructure only — no business/workspace data leaks.
    expect(text).not.toMatch(/email|user_count|@/i);
  });

  it("reports fernly_redis_up when Redis is configured", async () => {
    (probeRedis as ReturnType<typeof vi.fn>).mockResolvedValue("up");
    const res = await GET(mockRequest({ authorization: `Bearer ${SECRET}` }));
    const text = await res.text();
    expect(text).toContain("fernly_redis_up 1");
  });

  it("reports redis 0 (fail-open degradation) when Redis is down", async () => {
    (probeRedis as ReturnType<typeof vi.fn>).mockResolvedValue("down");
    const res = await GET(mockRequest({ authorization: `Bearer ${SECRET}` }));
    const text = await res.text();
    expect(text).toContain("fernly_redis_up 0");
  });

  it("reports maintenance freshness when a last-run timestamp exists", async () => {
    const iso = "2026-11-03T03:00:00.000Z";
    (getMaintenanceLastRun as ReturnType<typeof vi.fn>).mockResolvedValue(iso);
    const res = await GET(mockRequest({ authorization: `Bearer ${SECRET}` }));
    const text = await res.text();
    expect(text).toContain(
      `fernly_maintenance_last_run_timestamp_seconds ${(Date.parse(iso) / 1000).toFixed(3)}`,
    );
  });

  it("still serves 200 with app_up 0 when the DB is down", async () => {
    (probeDb as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    const res = await GET(mockRequest({ authorization: `Bearer ${SECRET}` }));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("fernly_app_up 0");
    expect(text).toContain("fernly_db_up 0");
  });
});
