import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// G5 — the push payload parser: the generic envelope, entry-level
// validation (the shared contract no vendor parser can weaken), and the
// vendor fallback (unknown vendors use the generic parser).
// ---------------------------------------------------------------------------

import { parsePushPayload } from "../push-parser";

describe("parsePushPayload — the generic envelope", () => {
  it("normalizes a valid payload (defaults, canonicalization, raw evidence)", () => {
    const res = parsePushPayload("ZKTECO", {
      punches: [
        { deviceUserId: " 1001 ", punchedAt: "2026-11-10T09:05:00+13:00", direction: "in", verifyMethod: "fingerprint", extra: 1 },
        { deviceUserId: "1001", punchedAt: 1794254700 }, // epoch seconds → 2026-11-09T20:05:00Z
      ],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.punches).toHaveLength(2);
    expect(res.punches[0].deviceUserId).toBe("1001");
    expect(res.punches[0].punchedAt.toISOString()).toBe("2026-11-09T20:05:00.000Z");
    expect(res.punches[0].direction).toBe("IN");
    expect(res.punches[0].verifyMethod).toBe("FINGERPRINT");
    expect(res.punches[0].rawPayload).toMatchObject({ extra: 1 });
    // No direction → UNKNOWN; epoch seconds → the same instant.
    expect(res.punches[1].direction).toBe("UNKNOWN");
    expect(res.punches[1].punchedAt.toISOString()).toBe("2026-11-09T20:05:00.000Z");
  });

  it("reads naive ISO as UTC (the deterministic wire contract)", () => {
    const res = parsePushPayload("OTHER", { punches: [{ deviceUserId: "1", punchedAt: "2026-11-10 09:05:00" }] });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.punches[0].punchedAt.toISOString()).toBe("2026-11-10T09:05:00.000Z");
  });

  it("falls back to the generic parser for every unknown vendor", () => {
    const body = { punches: [{ deviceUserId: "1", punchedAt: "2026-11-10T09:05:00Z" }] };
    expect(parsePushPayload("SUPREMA", body).ok).toBe(true);
    expect(parsePushPayload("SOME_FUTURE_VENDOR", body).ok).toBe(true);
  });
});

describe("parsePushPayload — rejections (strict, whole-payload)", () => {
  const cases: Array<[string, unknown, RegExp]> = [
    ["not an object", { nope: true }, /punches/],
    ["bare array", [{}], /punches/],
    ["missing punches", {}, /punches/],
    ["empty punches", { punches: [] }, /empty/],
    ["non-array punches", { punches: {} }, /punches/],
    ["entry not an object", { punches: ["x"] }, /punches\[0\]/],
    ["missing deviceUserId", { punches: [{ punchedAt: "2026-11-10T09:00:00Z" }] }, /deviceUserId/],
    ["blank deviceUserId", { punches: [{ deviceUserId: "  ", punchedAt: "2026-11-10T09:00:00Z" }] }, /deviceUserId/],
    ["bad punchedAt", { punches: [{ deviceUserId: "1", punchedAt: "yesterday" }] }, /punchedAt/],
    ["out-of-range punchedAt", { punches: [{ deviceUserId: "1", punchedAt: 5 }] }, /punchedAt/],
    ["bad direction", { punches: [{ deviceUserId: "1", punchedAt: 1794254700, direction: "SIDEWAYS" }] }, /direction/],
    ["non-string verifyMethod", { punches: [{ deviceUserId: "1", punchedAt: 1794254700, verifyMethod: 9 }] }, /verifyMethod/],
  ];
  for (const [name, body, pattern] of cases) {
    it(`rejects: ${name}`, () => {
      const res = parsePushPayload("ZKTECO", body);
      expect(res).toMatchObject({ ok: false, status: 400 });
      if (res.ok) return;
      expect(res.error).toMatch(pattern);
    });
  }

  it("rejects an over-size push", () => {
    const punches = Array.from({ length: 1001 }, (_, i) => ({ deviceUserId: String(i), punchedAt: 1794254700 }));
    expect(parsePushPayload("OTHER", { punches })).toMatchObject({
      ok: false,
      error: expect.stringContaining("at most 1000"),
    });
  });
});
