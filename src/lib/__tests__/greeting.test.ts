import { describe, it, expect } from "vitest";
import { getGreeting, getTodayDateStr } from "@/lib/greeting";

describe("getGreeting", () => {
  it("returns one of the three greetings for a valid timezone", () => {
    const g = getGreeting("Pacific/Auckland");
    expect(["Good morning", "Good afternoon", "Good evening"]).toContain(g);
  });

  it("returns Hello for an invalid timezone", () => {
    expect(getGreeting("Not/ARealZone")).toBe("Hello");
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
