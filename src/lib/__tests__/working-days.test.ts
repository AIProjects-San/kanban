import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// F1.1 — holiday-aware working-day math (lib/working-days.ts).
// Pins the exact semantics: weekends never count; holiday entries remove
// weekdays (half-days 0.5); kind is irrelevant to the count; entries on
// weekends change nothing; periods read only their own days.
// ---------------------------------------------------------------------------

import {
  dayKey,
  paymentWindow,
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

describe("paymentWindow (S5 / PR-B06)", () => {
  it("no employment dates = the unbounded full-period window", () => {
    const w = paymentWindow("2026-11", undefined);
    expect(w.paidDays).toBe(21);
    expect(w.clippedFrom).toBe(false);
    expect(w.clippedUntil).toBe(false);
  });

  it("a mid-month hire date clips the window start", () => {
    // Hired Tue Nov 10 → working days 10..30 = 15.
    const w = paymentWindow("2026-11", undefined, { from: "2026-11-10" });
    expect(w.paidDays).toBe(15);
    expect(w.clippedFrom).toBe(true);
    expect(w.clippedUntil).toBe(false);
  });

  it("a mid-month last-working-day clips the window end", () => {
    // LWD Fri Nov 6 → working days 2..6 = 5.
    const w = paymentWindow("2026-11", undefined, { until: "2026-11-06" });
    expect(w.paidDays).toBe(5);
    expect(w.clippedFrom).toBe(false);
    expect(w.clippedUntil).toBe(true);
  });

  it("both ends clip (hired and left in the same month)", () => {
    // Hired Mon Nov 2, LWD Fri Nov 13 → 2..13 = 10 working days.
    const w = paymentWindow("2026-11", undefined, { from: "2026-11-02", until: "2026-11-13" });
    expect(w.paidDays).toBe(10);
  });

  it("employment dates outside the period change nothing (no clipping)", () => {
    const before = paymentWindow("2026-11", undefined, { from: "2026-10-15" });
    expect(before.paidDays).toBe(21);
    expect(before.clippedFrom).toBe(false);
    const after = paymentWindow("2026-11", undefined, { until: "2026-12-15" });
    expect(after.paidDays).toBe(21);
    expect(after.clippedUntil).toBe(false);
  });

  it("the window is holiday-aware (half-day holidays count 0.5)", () => {
    const hol = holidayLookupFrom([{ date: "2026-11-02", isHalfDay: true }, { date: "2026-11-11", isHalfDay: false }]);
    // Full period: 21 weekdays − 1 (Nov 11 full holiday) − 0.5 (Nov 2 half) = 19.5.
    expect(paymentWindow("2026-11", hol).paidDays).toBe(19.5);
    // Window from Nov 10: 11 is a full holiday; 10,12,13,16-20,23-27,30 = 14.
    expect(paymentWindow("2026-11", hol, { from: "2026-11-10" }).paidDays).toBe(14);
  });

  it("an inverted window (LWD before hire) yields 0 paid days", () => {
    const w = paymentWindow("2026-11", undefined, { from: "2026-11-20", until: "2026-11-06" });
    expect(w.paidDays).toBe(0);
  });

  it("accepts Date objects for the employment bounds", () => {
    const w = paymentWindow("2026-11", undefined, { from: new Date("2026-11-10T00:00:00.000Z") });
    expect(w.paidDays).toBe(15);
  });
});
