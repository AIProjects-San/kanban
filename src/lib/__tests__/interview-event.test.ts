import { describe, it, expect } from "vitest";

import { planInterviewEvent } from "@/lib/interview-event";

// ---------------------------------------------------------------------------
// F-R18 (S18) — the interview calendar-event day basis kernel.
//
// scheduleInterview used to store date = the full instant + time = the
// SERVER-LOCAL HH:MM of that instant, so the calendar grid, the ICS export
// and (around midnight, or on a server whose TZ ≠ the users') even the DAY
// disagreed. The kernel pins the new contract: the wall-clock the user
// picked becomes UTC-midnight-of-that-day + the picked "HH:MM" — exactly
// the pair the generic-events writer (events.ts) stores, so every reader
// renders one basis for all events.
// ---------------------------------------------------------------------------

describe("planInterviewEvent (F-R18/S18)", () => {
  it("derives UTC-midnight of the picked day + the picked HH:MM verbatim", () => {
    const { date, time } = planInterviewEvent("2027-03-18T14:30");
    expect(date.toISOString()).toBe("2027-03-18T00:00:00.000Z");
    expect(time).toBe("14:30");
  });

  it("keeps the time-of-day OUT of the stored date (the day is the fact, not the instant)", () => {
    // 23:59 — the classic midnight-flip case: under the old basis the
    // instant's UTC day could differ from the picked day on a non-UTC
    // server; here the day is exactly what was picked.
    const { date, time } = planInterviewEvent("2027-03-18T23:59");
    expect(date.toISOString()).toBe("2027-03-18T00:00:00.000Z");
    expect(time).toBe("23:59");
  });

  it("accepts day edges (00:00 and the first of the month)", () => {
    expect(planInterviewEvent("2027-04-01T00:00")).toEqual({
      date: new Date("2027-04-01T00:00:00.000Z"),
      time: "00:00",
    });
  });

  it("accepts a real leap day", () => {
    expect(planInterviewEvent("2028-02-29T09:15").date.toISOString()).toBe("2028-02-29T00:00:00.000Z");
  });

  it("is pure — the same input always yields the same pair (no clock, no locale, no I/O)", () => {
    const a = planInterviewEvent("2026-12-24T10:00");
    const b = planInterviewEvent("2026-12-24T10:00");
    expect(a).toEqual(b);
  });

  it("refuses an impossible calendar date (QA-10b: not at the Prisma write)", () => {
    expect(() => planInterviewEvent("2026-02-30T10:00")).toThrow(/not a real calendar date/);
    expect(() => planInterviewEvent("2027-04-31T10:00")).toThrow(/not a real calendar date/);
    expect(() => planInterviewEvent("2026-13-01T10:00")).toThrow(/not a real calendar date/);
  });

  it("refuses an out-of-range 24-hour time", () => {
    expect(() => planInterviewEvent("2027-03-18T24:00")).toThrow(/not a valid 24-hour time/);
    expect(() => planInterviewEvent("2027-03-18T09:60")).toThrow(/not a valid 24-hour time/);
  });

  it("refuses a non-datetime-local shape (seconds, offsets, date-only…)", () => {
    const bad = [
      "2027-03-18T14:30:00", // seconds — a datetime-local value never carries them
      "2027-03-18T14:30Z", // an offset — that's the instant's job (scheduledAt)
      "2027-03-18 14:30", // space separator
      "2027-03-18", // date-only
      "14:30", // time-only
      "", // empty
    ];
    for (const v of bad) expect(() => planInterviewEvent(v)).toThrow(/YYYY-MM-DDTHH:MM/);
  });
});
