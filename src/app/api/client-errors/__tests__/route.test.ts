import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// PR-13 (production-readiness audit) — /api/client-errors rate limiting.
//
// The endpoint is unauthenticated by design (error bridges must report
// without a session) and accepts Origin-less probes (QA-9), so a scripted
// client could flood the operator's error tracker. The route now enforces a
// per-IP budget (20 / 5 min via the shared limiter factory) before parsing.
// These tests pin that contract with a controllable limiter mock.
// ---------------------------------------------------------------------------

const { checkMock, hitMock } = vi.hoisted(() => ({
  checkMock: vi.fn(),
  hitMock: vi.fn(),
}));

vi.mock("@/lib/rate-limit-redis", () => ({
  createClientErrorLimiter: () => ({
    check: (...a: unknown[]) => checkMock(...(a as [])),
    hit: (...a: unknown[]) => hitMock(...(a as [])),
    reset: vi.fn(),
  }),
}));

const captureErrorMock = vi.fn();
vi.mock("@/lib/observability", () => ({
  captureError: (...a: unknown[]) => captureErrorMock(...(a as [])),
}));

import { POST } from "../route";

function post(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return POST(
    new Request("http://localhost:3000/api/client-errors", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }) as never,
  );
}

describe("/api/client-errors rate limit (PR-13)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: under budget.
    checkMock.mockResolvedValue({ blocked: false, count: 0, retryAfterSec: 0 });
    hitMock.mockResolvedValue({ blocked: false, count: 1, retryAfterSec: 0 });
  });

  it("accepts a same-origin report and forwards it to the reporter", async () => {
    const res = await post({ message: "boom", source: "test" });
    expect(res.status).toBe(204);
    expect(hitMock).toHaveBeenCalledTimes(1);
    expect(hitMock).toHaveBeenCalledWith(expect.stringMatching(/^ip:/));
    expect(captureErrorMock).toHaveBeenCalledTimes(1);
  });

  it("records the budget BEFORE parsing and rejects over-budget IPs with 429", async () => {
    checkMock.mockResolvedValue({ blocked: true, count: 20, retryAfterSec: 300 });
    const res = await post({ message: "flood" });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("300");
    // Over-budget requests never reach the reporter or count as hits.
    expect(hitMock).not.toHaveBeenCalled();
    expect(captureErrorMock).not.toHaveBeenCalled();
  });

  it("still enforces the origin check before the budget (cross-site 403)", async () => {
    const res = await post({ message: "x" }, { origin: "https://evil.example.com" });
    expect(res.status).toBe(403);
    expect(checkMock).not.toHaveBeenCalled();
  });

  it("keys the budget on the LAST x-forwarded-for hop (proxy parity with auth.ts)", async () => {
    await post({ message: "x" }, { "x-forwarded-for": "1.2.3.4, 10.0.0.9" });
    expect(hitMock).toHaveBeenCalledWith("ip:10.0.0.9");
  });
});
