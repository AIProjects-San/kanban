import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// F1.1 — holiday-aware working-day math (lib/working-days.ts).
// Pins the exact semantics: weekends never count; holiday entries remove
// weekdays (half-days 0.5); kind is irrelevant to the count; entries on
// weekends change nothing; periods read only their own days.
// ---------------------------------------------------------------------------

import {
  dayKey,
  holidayLookupFrom,
  workingDaysBetween,
  workingDaysInPeriod,
} from "../working-days";

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

describe("dayKey", () => {
  it("formats a UTC-midnight date as yyyy-mm-dd", () => {
    expect(dayKey(d("2026-11-06"))).toBe("2026-11-06");
  });
});

describe("holidayLookupFrom", () => {
  it("keys by yyyy-mm-dd from Date rows", () => {
    const map = holidayLookupFrom([{ date: d("2026-12-25"), isHalfDay: false }]);
    expect(map.get("2026-12-25")).toEqual({ isHalfDay: false });
    expect(map.size).toBe(1);
  });

  it("accepts string dates (client-shaped rows)", () => {
    const map = holidayLookupFrom([{ date: "2026-12-25", isHalfDay: true }]);
    expect(map.get("2026-12-25")).toEqual({ isHalfDay: true });
  });
});

describe("workingDaysBetween", () => {
  it("counts Mon–Fri across one week (no holidays)", () => {
    // 2026-11-02 is a Monday.
    expect(workingDaysBetween(d("2026-11-02"), d("2026-11-08"))).toBe(5);
  });

  it("a single Saturday is zero days", () => {
    expect(workingDaysBetween(d("2026-11-07"), d("2026-11-07"))).toBe(0);
  });

  it("a single Wednesday is one day", () => {
    expect(workingDaysBetween(d("2026-11-04"), d("2026-11-04"))).toBe(1);
  });

  it("a full-day holiday removes the weekday from the count", () => {
    const hol = holidayLookupFrom([{ date: "2026-11-04", isHalfDay: false }]);
    expect(workingDaysBetween(d("2026-11-02"), d("2026-11-06"), hol)).toBe(4);
  });

  it("a half-day holiday counts 0.5", () => {
    const hol = holidayLookupFrom([{ date: "2026-11-04", isHalfDay: true }]);
    expect(workingDaysBetween(d("2026-11-02"), d("2026-11-06"), hol)).toBe(4.5);
  });

  it("a holiday on a weekend changes nothing (no double discount)", () => {
    const hol = holidayLookupFrom([{ date: "2026-11-07", isHalfDay: false }]);
    expect(workingDaysBetween(d("2026-11-02"), d("2026-11-08"), hol)).toBe(5);
  });

  it("an all-weekdays-holiday range drops to zero (weekend-only rule parity)", () => {
    const hol = holidayLookupFrom([
      { date: "2026-11-02", isHalfDay: false },
      { date: "2026-11-03", isHalfDay: false },
      { date: "2026-11-04", isHalfDay: false },
      { date: "2026-11-05", isHalfDay: false },
      { date: "2026-11-06", isHalfDay: false },
    ]);
    expect(workingDaysBetween(d("2026-11-02"), d("2026-11-06"), hol)).toBe(0);
  });

  it("spans a year boundary correctly (Dec 2026 → Jan 2027)", () => {
    // 2026-12-28..31: Mon 28, Tue 29, Wed 30, Thu 31; 2027-01-01 Fri is a
    // seeded NZ holiday; Jan 2-3 are Sat/Sun.
    const hol = holidayLookupFrom([{ date: "2027-01-01", isHalfDay: false }]);
    expect(workingDaysBetween(d("2026-12-28"), d("2027-01-03"), hol)).toBe(4);
    // Without the calendar entry Friday would count.
    expect(workingDaysBetween(d("2026-12-28"), d("2027-01-03"))).toBe(5);
  });

  it("an empty lookup behaves exactly like the holiday-free variant", () => {
    expect(workingDaysBetween(d("2026-11-02"), d("2026-11-06"), new Map())).toBe(5);
  });
});

describe("workingDaysInPeriod", () => {
  it("November 2026 has 21 Mon–Fri days (no national holidays)", () => {
    expect(workingDaysInPeriod("2026-11")).toBe(21);
  });

  it("October 2026 has 21 working days with Labour Day (Mon 26 Oct) excluded", () => {
    const hol = holidayLookupFrom([{ date: "2026-10-26", isHalfDay: false }]);
    expect(workingDaysInPeriod("2026-10", hol)).toBe(21);
  });

  it("an invalid period returns 0", () => {
    expect(workingDaysInPeriod("not-a-period")).toBe(0);
    expect(workingDaysInPeriod("2026-13")).toBe(0);
  });

  it("only reads the period's own days from a wider lookup", () => {
    // Lookup spans Nov + Dec; the November count must ignore Dec 25.
    const hol = holidayLookupFrom([
      { date: "2026-12-25", isHalfDay: false },
    ]);
    expect(workingDaysInPeriod("2026-11", hol)).toBe(21);
  });
});
