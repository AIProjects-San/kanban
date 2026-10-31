import { describe, it, expect, vi, beforeEach } from "vitest";

// L-P0-4 regression — the health endpoint.
vi.mock("@/lib/db", () => ({
  db: { $queryRaw: vi.fn() },
}));

const { db } = await import("@/lib/db");
const { GET } = await import("../route");

function mockRequest(query = ""): Request {
  const url = query ? `http://localhost/api/health?${query}` : "http://localhost/api/health";
  return new Request(url);
}

describe("/api/health (L-P0-4)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 200 ok when the DB probe succeeds", async () => {
    (db.$queryRaw as ReturnType<typeof vi.fn>).mockResolvedValue([{ "?column?": 1 }]);
    const res = await GET(mockRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.db).toBe("up");
    expect(body.timestamp).toBeTruthy();
  });

  it("returns 503 down when the DB probe rejects", async () => {
    (db.$queryRaw as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("connection refused"));
    const res = await GET(mockRequest());
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
    const res = await GET(mockRequest("ready=1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.readiness).toBe(true);
  });
});
