import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// G5 — the pure punch kernel: normalization, NZ projection (DST-exact),
// per-day pairing with duplicate detection, and the break-deducted hours.
// ---------------------------------------------------------------------------

import {
  normalizeDirection,
  normalizeVerifyMethod,
  parsePunchedAt,
  nzDayKey,
  nzHm,
  nzLocalToInstant,
  nzDayBounds,
  isValidDayKey,
  pairDayPunches,
  deriveWorkedHours,
  punchBreakMinutes,
  devicePushToken,
  DUPLICATE_WINDOW_MS,
  type DayPunchInput,
} from "../punches";

function p(id: string, iso: string, direction: DayPunchInput["direction"], deviceUserId = "1001"): DayPunchInput {
  return { id, deviceUserId, punchedAt: new Date(iso), direction };
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

describe("normalizeDirection", () => {
  it("maps case-insensitive IN/OUT", () => {
    expect(normalizeDirection("in")).toBe("IN");
    expect(normalizeDirection("OUT")).toBe("OUT");
    expect(normalizeDirection(" Out ")).toBe("OUT");
  });
  it("absent or empty → UNKNOWN", () => {
    expect(normalizeDirection(undefined)).toBe("UNKNOWN");
    expect(normalizeDirection(null)).toBe("UNKNOWN");
    expect(normalizeDirection("")).toBe("UNKNOWN");
    expect(normalizeDirection("unknown")).toBe("UNKNOWN");
  });
  it("rejects anything else", () => {
    expect(normalizeDirection("SIDEWAYS")).toBeNull();
    expect(normalizeDirection(7)).toBeNull();
  });
});

describe("normalizeVerifyMethod", () => {
  it("upper-cases the known methods", () => {
    expect(normalizeVerifyMethod("fingerprint")).toBe("FINGERPRINT");
    expect(normalizeVerifyMethod("Face")).toBe("FACE");
  });
  it("keeps unknown vendor values, trimmed + capped", () => {
    expect(normalizeVerifyMethod("  retina-scan  ")).toBe("retina-scan");
    expect(normalizeVerifyMethod("x".repeat(50))).toHaveLength(32);
  });
  it("null for absent/empty/non-string", () => {
    expect(normalizeVerifyMethod(null)).toBeNull();
    expect(normalizeVerifyMethod("")).toBeNull();
    expect(normalizeVerifyMethod(42)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Timestamp parsing
// ---------------------------------------------------------------------------

describe("parsePunchedAt", () => {
  it("accepts epoch seconds and millis", () => {
    const t = Date.UTC(2026, 10, 9, 20, 5); // 2026-11-09T20:05:00Z
    expect(parsePunchedAt(t / 1000)?.getTime()).toBe(t);
    expect(parsePunchedAt(t)?.getTime()).toBe(t);
  });
  it("accepts zoned ISO strings (Z and offset, T and space)", () => {
    expect(parsePunchedAt("2026-11-09T20:05:00Z")?.getTime()).toBe(Date.UTC(2026, 10, 9, 20, 5));
    expect(parsePunchedAt("2026-11-10 09:05:00+13:00")?.getTime()).toBe(Date.UTC(2026, 10, 9, 20, 5));
    expect(parsePunchedAt("2026-11-10T09:05:30.250+13:00")?.getTime()).toBe(Date.UTC(2026, 10, 9, 20, 5, 30, 250));
  });
  it("reads naive strings per naiveZone (UTC default, NZ for CSV)", () => {
    expect(parsePunchedAt("2026-11-10 09:05")?.getTime()).toBe(Date.UTC(2026, 10, 10, 9, 5));
    // NZ summer = UTC+13: 09:05 NZ wall time is 20:05Z the previous day.
    expect(parsePunchedAt("2026-11-10 09:05", { naiveZone: "NZ" })?.getTime()).toBe(Date.UTC(2026, 10, 9, 20, 5));
  });
  it("rejects malformed + non-calendar + out-of-range values", () => {
    expect(parsePunchedAt("garbage")).toBeNull();
    expect(parsePunchedAt("2026-13-01T00:00")).toBeNull();
    expect(parsePunchedAt("2026-02-30T10:00")).toBeNull();
    expect(parsePunchedAt("2026-11-10T25:00")).toBeNull();
    expect(parsePunchedAt(Number.NaN)).toBeNull();
    expect(parsePunchedAt(5)).toBeNull(); // 1970-01-01 — before the 1990 floor
    expect(parsePunchedAt(true)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// NZ projection
// ---------------------------------------------------------------------------

describe("nzDayKey / nzHm (DST-correct projection)", () => {
  it("summer (NZDT, UTC+13)", () => {
    // 2026-11-10T09:00Z → 22:00 the same NZ day.
    expect(nzDayKey(new Date("2026-11-10T09:00:00Z"))).toBe("2026-11-10");
    expect(nzHm(new Date("2026-11-10T09:00:00Z"))).toBe("22:00");
  });
  it("winter (NZST, UTC+12)", () => {
    expect(nzHm(new Date("2026-06-10T09:00:00Z"))).toBe("21:00");
  });
  it("day rollover: a UTC instant can be the NEXT NZ day", () => {
    expect(nzDayKey(new Date("2026-11-10T14:30:00Z"))).toBe("2026-11-11");
    expect(nzHm(new Date("2026-11-10T14:30:00Z"))).toBe("03:30");
  });
});

describe("nzLocalToInstant / nzDayBounds", () => {
  it("inverts the projection (NZ wall time → UTC instant)", () => {
    expect(nzLocalToInstant(2026, 11, 10, 9, 5).toISOString()).toBe("2026-11-09T20:05:00.000Z");
    expect(nzLocalToInstant(2026, 6, 10, 9, 5).toISOString()).toBe("2026-06-09T21:05:00.000Z");
  });
  it("bounds a normal day at 24h", () => {
    const b = nzDayBounds("2026-11-10");
    expect(b.start.toISOString()).toBe("2026-11-09T11:00:00.000Z");
    expect(b.end.getTime() - b.start.getTime()).toBe(24 * 3_600_000);
  });
  it("bounds the 25h DST-back day (2026-04-05) and the 23h DST-forward day (2026-09-27)", () => {
    expect(nzDayBounds("2026-04-05").end.getTime() - nzDayBounds("2026-04-05").start.getTime()).toBe(25 * 3_600_000);
    expect(nzDayBounds("2026-09-27").end.getTime() - nzDayBounds("2026-09-27").start.getTime()).toBe(23 * 3_600_000);
  });
  it("throws on a malformed day key", () => {
    expect(() => nzDayBounds("2026-02-30")).toThrow();
    expect(() => nzDayBounds("not-a-day")).toThrow();
  });
});

describe("isValidDayKey", () => {
  it("accepts real calendar days and rejects the rest", () => {
    expect(isValidDayKey("2026-11-10")).toBe(true);
    expect(isValidDayKey("2026-02-29")).toBe(false); // 2026 is not a leap year
    expect(isValidDayKey("2028-02-29")).toBe(true);
    expect(isValidDayKey("2026/11/10")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Device config readers
// ---------------------------------------------------------------------------

describe("device config readers", () => {
  it("punchBreakMinutes clamps garbage to a safe value", () => {
    expect(punchBreakMinutes(null)).toBe(0);
    expect(punchBreakMinutes({})).toBe(0);
    expect(punchBreakMinutes({ breakMinutes: "30" })).toBe(0);
    expect(punchBreakMinutes({ breakMinutes: 30 })).toBe(30);
    expect(punchBreakMinutes({ breakMinutes: 999 })).toBe(480);
    expect(punchBreakMinutes({ breakMinutes: -5 })).toBe(0);
  });
  it("devicePushToken reads the secret, null when unset", () => {
    expect(devicePushToken(null)).toBeNull();
    expect(devicePushToken({})).toBeNull();
    expect(devicePushToken({ pushToken: "  " })).toBeNull();
    expect(devicePushToken({ pushToken: "tok_abc123" })).toBe("tok_abc123");
  });
});

// ---------------------------------------------------------------------------
// Per-day pairing
// ---------------------------------------------------------------------------

describe("pairDayPunches", () => {
  it("derives IN = earliest, OUT = latest", () => {
    const r = pairDayPunches([
      p("p3", "2026-11-10T04:35:00Z", "OUT"),
      p("p1", "2026-11-09T20:00:00Z", "IN"),
      p("p2", "2026-11-09T20:45:00Z", "IN"),
      p("p4", "2026-11-10T02:00:00Z", "OUT"),
    ]);
    expect(r.inAt?.toISOString()).toBe("2026-11-09T20:00:00.000Z");
    expect(r.outAt?.toISOString()).toBe("2026-11-10T04:35:00.000Z");
    expect(r.duplicateIds).toEqual([]);
    expect(r.missingOut).toBe(false);
    expect(r.missingIn).toBe(false);
    expect(r.contributingIds).toEqual(["p1", "p2", "p4", "p3"]);
  });

  it("collapses same-direction punches inside the duplicate window", () => {
    const r = pairDayPunches([
      p("p1", "2026-11-09T20:00:00Z", "IN"), // 09:00 NZ
      p("p2", "2026-11-09T20:01:00Z", "IN"), // 09:01 NZ — double-tap
      p("p3", "2026-11-10T04:00:00Z", "OUT"),
    ]);
    expect(r.duplicateIds).toEqual(["p2"]);
    expect(r.inAt?.toISOString()).toBe("2026-11-09T20:00:00.000Z");
    expect(r.contributingIds).toEqual(["p1", "p3"]);
  });

  it("keeps same-direction punches beyond the window (a real re-entry)", () => {
    const beyond = DUPLICATE_WINDOW_MS + 60_000;
    const r = pairDayPunches([
      p("p1", "2026-11-09T20:00:00Z", "IN"),
      p("p2", new Date(Date.parse("2026-11-09T20:00:00Z") + beyond).toISOString(), "IN"),
    ]);
    expect(r.duplicateIds).toEqual([]);
  });

  it("collapses exact-instant re-reports across flapping directions", () => {
    const r = pairDayPunches([
      p("p1", "2026-11-09T20:00:00Z", "IN"),
      p("p2", "2026-11-09T20:00:00Z", "UNKNOWN"),
    ]);
    expect(r.duplicateIds).toEqual(["p2"]);
    expect(r.inAt?.toISOString()).toBe("2026-11-09T20:00:00.000Z");
  });

  it("does NOT near-collapse UNKNOWN pairs (directionless IN→OUT can be minutes apart)", () => {
    const r = pairDayPunches([
      p("p1", "2026-11-09T20:00:00Z", "UNKNOWN"),
      p("p2", "2026-11-09T20:01:00Z", "UNKNOWN"),
    ]);
    expect(r.duplicateIds).toEqual([]);
    expect(r.inAt).not.toBeNull();
    expect(r.outAt).not.toBeNull();
  });

  it("dedupes per device user — two users punching together never collapse", () => {
    const r = pairDayPunches([
      p("p1", "2026-11-09T20:00:00Z", "IN", "1001"),
      p("p2", "2026-11-09T20:00:30Z", "IN", "1002"),
    ]);
    expect(r.duplicateIds).toEqual([]);
  });

  it("positional pairing: two UNKNOWNs → first IN, last OUT; a lone UNKNOWN → IN-only", () => {
    const two = pairDayPunches([
      p("p1", "2026-11-09T20:00:00Z", "UNKNOWN"),
      p("p2", "2026-11-10T04:30:00Z", "UNKNOWN"),
    ]);
    expect(two.inAt?.toISOString()).toBe("2026-11-09T20:00:00.000Z");
    expect(two.outAt?.toISOString()).toBe("2026-11-10T04:30:00.000Z");

    const one = pairDayPunches([p("p1", "2026-11-09T20:00:00Z", "UNKNOWN")]);
    expect(one.inAt).not.toBeNull();
    expect(one.outAt).toBeNull();
    expect(one.missingOut).toBe(true);
  });

  it("promotes an UNKNOWN to the missing side when explicit punches exist", () => {
    const r = pairDayPunches([
      p("p1", "2026-11-09T20:00:00Z", "UNKNOWN"), // no explicit IN → promoted
      p("p2", "2026-11-10T04:30:00Z", "OUT"),
    ]);
    expect(r.inAt?.toISOString()).toBe("2026-11-09T20:00:00.000Z");
    expect(r.outAt?.toISOString()).toBe("2026-11-10T04:30:00.000Z");

    const mirrored = pairDayPunches([
      p("p1", "2026-11-09T20:00:00Z", "IN"),
      p("p2", "2026-11-10T04:30:00Z", "UNKNOWN"), // no explicit OUT → promoted
    ]);
    expect(mirrored.outAt?.toISOString()).toBe("2026-11-10T04:30:00.000Z");
  });

  it("flags missingOut (IN only) and missingIn (OUT only)", () => {
    const inOnly = pairDayPunches([p("p1", "2026-11-09T20:00:00Z", "IN")]);
    expect(inOnly.missingOut).toBe(true);
    expect(inOnly.missingIn).toBe(false);
    const outOnly = pairDayPunches([p("p1", "2026-11-10T04:30:00Z", "OUT")]);
    expect(outOnly.missingIn).toBe(true);
    expect(outOnly.missingOut).toBe(false);
  });

  it("sorts deterministically (unsorted input, stable contributing ids)", () => {
    const r = pairDayPunches([
      p("p2", "2026-11-10T04:00:00Z", "OUT"),
      p("p1", "2026-11-09T20:00:00Z", "IN"),
    ]);
    expect(r.contributingIds).toEqual(["p1", "p2"]);
  });
});

// ---------------------------------------------------------------------------
// Hours
// ---------------------------------------------------------------------------

describe("deriveWorkedHours", () => {
  const inAt = new Date("2026-11-09T20:05:00Z"); // 09:05 NZ
  const outAt = new Date("2026-11-10T04:35:00Z"); // 17:35 NZ — 8h30m later
  it("subtracts the unpaid break, 2 decimals", () => {
    expect(deriveWorkedHours(inAt, outAt, 30)).toBe(8);
    expect(deriveWorkedHours(inAt, outAt, 15)).toBe(8.25);
    expect(deriveWorkedHours(inAt, outAt, 0)).toBe(8.5);
  });
  it("clamps at zero when the break exceeds the span", () => {
    expect(deriveWorkedHours(inAt, outAt, 600)).toBe(0);
  });
  it("null when unpaired or inverted", () => {
    expect(deriveWorkedHours(inAt, null, 0)).toBeNull();
    expect(deriveWorkedHours(null, outAt, 0)).toBeNull();
    expect(deriveWorkedHours(outAt, inAt, 0)).toBeNull();
  });
});
