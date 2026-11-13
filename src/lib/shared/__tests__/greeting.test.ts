import { describe, it, expect, vi, afterEach } from "vitest";
import { getGreeting, getTodayDateStr } from "@/lib/shared/greeting";

describe("getGreeting", () => {
  it("returns one of the three greetings for a valid timezone", () => {
    const g = getGreeting("Pacific/Auckland");
    expect(["Good morning", "Good afternoon", "Good evening"]).toContain(g);
  });

  it("returns Hello for an invalid timezone", () => {
    expect(getGreeting("Not/ARealZone")).toBe("Hello");
  });

  it("PR-56: returns Hello when the formatted hour is not parseable (isNaN guard)", () => {
    // Defensive guard for an Intl implementation that formats the hour with
    // non-Latin digits or an unexpected glyph — parseInt yields NaN and the
    // greeting must degrade to the neutral "Hello" rather than crash.
    // NOTE: a vi.spyOn mock can't be used here — `new` on a vitest spy
    // discards the implementation's explicit object return, so .format
    // would be missing and the catch path (not the isNaN path) would
    // answer. A plain constructable function whose `new` result carries a
    // working format() pins the isNaN branch itself.
    const Original = Intl.DateTimeFormat;
    const Stub = function () {
      return { format: () => "twenty-four" };
    } as unknown as typeof Intl.DateTimeFormat;
    Intl.DateTimeFormat = Stub;
    try {
      expect(getGreeting("UTC")).toBe("Hello");
    } finally {
      Intl.DateTimeFormat = Original;
    }
  });

  it("treats empty/undefined timezone as UTC instead of throwing", () => {
    expect(["Good morning", "Good afternoon", "Good evening"]).toContain(getGreeting(""));
    expect(["Good morning", "Good afternoon", "Good evening"]).toContain(getGreeting(undefined));
    expect(["Good morning", "Good afternoon", "Good evening"]).toContain(getGreeting(null));
  });

  it("handles timezones where the same instant maps to a different day", () => {
    // Both calls must succeed even though the two zones are ~21h apart.
    expect(typeof getGreeting("Pacific/Auckland")).toBe("string");
    expect(typeof getGreeting("America/Los_Angeles")).toBe("string");
  });
});

// --- Deterministic branch coverage -------------------------------------------
// The tests above only assert membership in the three-greeting set, so the
// covered branch depends on the wall-clock hour at the moment CI runs — which
// made src/lib/** statement coverage flaky right at the 90% gate (a run at
// 03:35 UTC covered "afternoon"; a run at 11:19 UTC covered only "morning",
// dropping below the threshold). Fake timers pin the hour so every branch is
// exercised deterministically.
describe("getGreeting — deterministic branches (fake timers)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns Good morning before 12:00 in the target zone", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T09:00:00Z"));
    expect(getGreeting("UTC")).toBe("Good morning");
  });

  it("returns Good afternoon from 12:00 (inclusive) to 18:00", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T12:00:00Z"));
    expect(getGreeting("UTC")).toBe("Good afternoon");
    vi.setSystemTime(new Date("2026-06-01T17:59:00Z"));
    expect(getGreeting("UTC")).toBe("Good afternoon");
  });

  it("returns Good evening at/after 18:00 (and late-night hours)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T18:00:00Z"));
    expect(getGreeting("UTC")).toBe("Good evening");
    vi.setSystemTime(new Date("2026-06-01T23:59:00Z"));
    expect(getGreeting("UTC")).toBe("Good evening");
  });

  it("pins branches per-zone: 14:00 UTC is morning in Auckland (UTC+12)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T14:00:00Z"));
    expect(getGreeting("UTC")).toBe("Good afternoon");
    expect(getGreeting("Pacific/Auckland")).toBe("Good morning");
  });

  it("getTodayDateStr respects the pinned date in the target zone", () => {
    vi.useFakeTimers();
    // 2026-06-01T14:00:00Z is 2026-06-02 in Auckland (UTC+12) but 06-01 in UTC.
    vi.setSystemTime(new Date("2026-06-01T14:00:00Z"));
    expect(getTodayDateStr("UTC")).toBe("2026-06-01");
    expect(getTodayDateStr("Pacific/Auckland")).toBe("2026-06-02");
  });
});

describe("getTodayDateStr", () => {
  it("produces a YYYY-MM-DD string", () => {
    expect(getTodayDateStr("UTC")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("falls back to UTC for invalid timezones", () => {
    // Invalid zone → falls back to ISO UTC date; must still be YYYY-MM-DD.
    expect(getTodayDateStr("Bogus/Zone")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("treats empty timezone as UTC", () => {
    expect(getTodayDateStr("")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(getTodayDateStr(undefined)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
