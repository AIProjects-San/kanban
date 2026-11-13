// ---------------------------------------------------------------------------
// Phase 2 — the 2-working-day deadline (TAA 1994 s 23D(4); weekends and
// public holidays shift the due date to the next working day).
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { computeDueDate, workingDaysRemaining } from "../deadline";
import { holidayLookupFrom } from "@/lib/hr/working-days";

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

describe("computeDueDate — payDate + 2 working days", () => {
  it("a mid-week payday is due two working days later", () => {
    // Wednesday 2026-11-11 → Friday 2026-11-13.
    expect(computeDueDate(d("2026-11-11")).toISOString().slice(0, 10)).toBe("2026-11-13");
  });

  it("a FRIDAY payday skips the weekend → due TUESDAY", () => {
    // Friday 2026-11-13 → Monday 16 (1) → Tuesday 17 (2).
    expect(computeDueDate(d("2026-11-13")).toISOString().slice(0, 10)).toBe("2026-11-17");
  });

  it("a payday before a public holiday shifts the due date past it", () => {
    // Christmas 2026: Fri 25 Dec (public holiday), Mon 28 Dec (boxing day
    // Mondayised observed), Tue 29, Wed 30, Thu 31, Fri 1 Jan 2027
    // (New Year, observed Fri), then the weekend.
    const holidays = holidayLookupFrom([
      { date: d("2026-12-25"), isHalfDay: false },
      { date: d("2026-12-28"), isHalfDay: false },
      { date: d("2027-01-01"), isHalfDay: false },
    ]);
    // Thursday 2026-12-24 payday: Fri 25 = holiday, Mon 28 = holiday,
    // Tue 29 = working day 1, Wed 30 = working day 2 → due 2026-12-30.
    expect(computeDueDate(d("2026-12-24"), holidays).toISOString().slice(0, 10)).toBe("2026-12-30");
    // Friday 2026-12-24+1... a Friday 2026-12-18 payday: Mon 21, Tue 22
    // (no holidays that week) → due Tue 2026-12-22.
    expect(computeDueDate(d("2026-12-18"), holidays).toISOString().slice(0, 10)).toBe("2026-12-22");
    // A payday ON the holiday itself: Fri 2026-12-25 → Mon 28 holiday,
    // Tue 29 (1), Wed 30 (2) → due 2026-12-30.
    expect(computeDueDate(d("2026-12-25"), holidays).toISOString().slice(0, 10)).toBe("2026-12-30");
  });

  it("Waitangi Day 2027 (Saturday, Mondayised to Monday 8 Feb) shifts a Friday payday", () => {
    const holidays = holidayLookupFrom([{ date: d("2027-02-08"), isHalfDay: false }]);
    // Friday 2027-02-05 payday → Mon 8 holiday, Tue 9 (1), Wed 10 (2).
    expect(computeDueDate(d("2027-02-05"), holidays).toISOString().slice(0, 10)).toBe("2027-02-10");
  });

  it("the walk starts strictly AFTER the payday (same-day is never the due date)", () => {
    expect(computeDueDate(d("2026-11-11")).getTime()).toBeGreaterThan(d("2026-11-11").getTime());
  });
});

describe("workingDaysRemaining — the countdown", () => {
  it("counts working days from today (exclusive) to the due date (inclusive)", () => {
    // Wed 11 → Fri 13: 2 days remaining on the Wednesday itself.
    expect(workingDaysRemaining(d("2026-11-11"), d("2026-11-13"))).toBe(2);
    // On Thursday 12: 1.
    expect(workingDaysRemaining(d("2026-11-12"), d("2026-11-13"))).toBe(1);
    // On the due date: 0.
    expect(workingDaysRemaining(d("2026-11-13"), d("2026-11-13"))).toBe(0);
  });

  it("goes negative once the deadline has passed (working days late)", () => {
    // Due Fri 13, checked Mon 16 → 1 working day late.
    expect(workingDaysRemaining(d("2026-11-16"), d("2026-11-13"))).toBe(-1);
    // Checked Tue 17 → 2 late.
    expect(workingDaysRemaining(d("2026-11-17"), d("2026-11-13"))).toBe(-2);
    // Weekend checks don't add lateness: due Fri 13, checked Sat 14 → 0.
    expect(workingDaysRemaining(d("2026-11-14"), d("2026-11-13"))).toBe(0);
  });
});
