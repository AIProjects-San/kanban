import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// G5 — /api/biometric/punch: the push endpoint. Per-device token auth
// (constant-time, active devices only), strict payload validation, PENDING
// ingest with the duplicate count, and the 400/401/413/500 contract.
// ---------------------------------------------------------------------------

const db = vi.hoisted(() => ({
  biometricDevice: {
    findMany: vi.fn(),
    update: vi.fn(),
  },
  punch: { create: vi.fn() },
}));
vi.mock("@/lib/infra/db", () => ({ db }));

const captureErrorMock = vi.fn();
vi.mock("@/lib/infra/observability", () => ({
  captureError: (...a: unknown[]) => captureErrorMock(...a),
}));

import { POST } from "../route";

const TOKEN = "tok_9f3ab2c1de4567ef";

function deviceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "dev1",
    name: "Front door scanner",
    vendor: "ZKTECO",
    protocol: "ADMS_PUSH",
    serial: null,
    location: null,
    lastSyncAt: null,
    isActive: true,
    config: { pushToken: TOKEN, breakMinutes: 30 },
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function post(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return POST(
    new Request("http://localhost:3000/api/biometric/punch", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  db.biometricDevice.findMany.mockResolvedValue([deviceRow()]);
  db.biometricDevice.update.mockResolvedValue(deviceRow());
  db.punch.create.mockResolvedValue({ id: "p1" });
});

describe("/api/biometric/punch — authentication", () => {
  it("accepts a valid Bearer token and writes PENDING punches", async () => {
    const res = await post(
      {
        punches: [
          { deviceUserId: "1001", punchedAt: "2026-11-10T09:05:00+13:00", direction: "IN", verifyMethod: "fingerprint" },
          { deviceUserId: "1001", punchedAt: "2026-11-10T17:35:00+13:00" },
        ],
      },
      { authorization: `Bearer ${TOKEN}` },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; accepted: number; duplicates: number };
    expect(body).toEqual({ ok: true, accepted: 2, duplicates: 0 });
    expect(db.punch.create).toHaveBeenCalledTimes(2);
    const first = db.punch.create.mock.calls[0][0].data;
    expect(first.deviceId).toBe("dev1");
    expect(first.deviceUserId).toBe("1001");
    expect(first.punchedAt.toISOString()).toBe("2026-11-09T20:05:00.000Z");
    expect(first.direction).toBe("IN");
    expect(first.verifyMethod).toBe("FINGERPRINT");
    expect(first.rawPayload).toMatchObject({ deviceUserId: "1001" });
    // No reconciliation on the ingest path — the engine owns that.
    expect(first.reconciliationStatus).toBeUndefined();
    expect(db.biometricDevice.update).toHaveBeenCalledWith({
      where: { id: "dev1" },
      data: { lastSyncAt: expect.any(Date) },
    });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("accepts the x-device-token header variant", async () => {
    const res = await post({ punches: [{ deviceUserId: "1", punchedAt: 1794254700 }] }, { "x-device-token": TOKEN });
    expect(res.status).toBe(200);
  });

  it("rejects a bad token with 401 (and writes nothing)", async () => {
    const res = await post({ punches: [{ deviceUserId: "1", punchedAt: 1794254700 }] }, { authorization: "Bearer wrong-token-abcdef" });
    expect(res.status).toBe(401);
    expect(db.punch.create).not.toHaveBeenCalled();
  });

  it("rejects a missing token with 401", async () => {
    const res = await post({ punches: [{ deviceUserId: "1", punchedAt: 1794254700 }] });
    expect(res.status).toBe(401);
  });

  it("never matches an inactive or tokenless device", async () => {
    db.biometricDevice.findMany.mockResolvedValue([
      deviceRow({ id: "dev-inactive", isActive: false }),
      deviceRow({ id: "dev-notoken", config: {} }),
    ]);
    const res = await post({ punches: [{ deviceUserId: "1", punchedAt: 1794254700 }] }, { authorization: `Bearer ${TOKEN}` });
    expect(res.status).toBe(401);
    expect(db.punch.create).not.toHaveBeenCalled();
  });
});

describe("/api/biometric/punch — payload validation", () => {
  it("rejects non-JSON bodies with 400", async () => {
    const res = await post("this is not json", { authorization: `Bearer ${TOKEN}` });
    expect(res.status).toBe(400);
  });

  it("rejects malformed payloads with 400 (envelope + entries)", async () => {
    const auth = { authorization: `Bearer ${TOKEN}` };
    expect((await post({ nope: true }, auth)).status).toBe(400);
    expect((await post({ punches: [] }, auth)).status).toBe(400);
    expect((await post({ punches: "no" }, auth)).status).toBe(400);
    expect((await post({ punches: [{ deviceUserId: "1", punchedAt: "whenever" }] }, auth)).status).toBe(400);
    expect((await post({ punches: [{ deviceUserId: "1", punchedAt: 1794254700, direction: "SIDEWAYS" }] }, auth)).status).toBe(400);
    expect((await post({ punches: [{ punchedAt: 1794254700 }] }, auth)).status).toBe(400);
    // nothing was written by any of the rejected pushes
    expect(db.punch.create).not.toHaveBeenCalled();
  });

  it("rejects an over-cap body with 413", async () => {
    const res = await post("x".repeat(64 * 1024 + 1), { authorization: `Bearer ${TOKEN}` });
    expect(res.status).toBe(413);
  });
});

describe("/api/biometric/punch — ingest semantics", () => {
  it("counts exact re-deliveries as duplicates (200, never an error)", async () => {
    db.punch.create
      .mockResolvedValueOnce({ id: "p1" })
      .mockRejectedValueOnce(Object.assign(new Error("unique"), { code: "P2002" }));
    const res = await post({ punches: [{ deviceUserId: "1", punchedAt: 1794254700 }, { deviceUserId: "1", punchedAt: 1794254700 }] }, { authorization: `Bearer ${TOKEN}` });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { accepted: number; duplicates: number };
    expect(body).toEqual({ ok: true, accepted: 1, duplicates: 1 });
  });

  it("maps unexpected ingest failures to 500 + the error bridge", async () => {
    db.punch.create.mockRejectedValue(new Error("db down"));
    const res = await post({ punches: [{ deviceUserId: "1", punchedAt: 1794254700 }] }, { authorization: `Bearer ${TOKEN}` });
    expect(res.status).toBe(500);
    expect(captureErrorMock).toHaveBeenCalledTimes(1);
  });
});
