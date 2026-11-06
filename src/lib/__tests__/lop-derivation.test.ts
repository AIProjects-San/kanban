import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// F1.4 — pure derivation matrix for lib/lop-derivation.ts
// (docs/Fernly_HR_Payroll_Enhancement_Plan.md §7.1). November 2026 is the
// reference month: Nov 1 is a Sunday, Nov 30 a Monday → 21 weekdays
// (2,3,4,5,6,9,10,11,12,13,16,17,18,19,20,23,24,25,26,27,30) — the same
// denominator the hr-holidays e2e pins ($319.05 = 6,700 × 1 / 21).
// ---------------------------------------------------------------------------

import {
  deriveLopDays,
  type LopAttendanceMark,
  type LopLeaveSpan,
} from "@/lib/lop-derivation";
import { holidayLookupFrom } from "@/lib/working-days";

const PERIOD = "2026-11";

/** A UTC-midnight Date from "YYYY-MM-DD". */
function d(s: string): Date {
  return new Date(`${s}T00:00:00.000Z`);
}

function marks(...days: Array<[string, string]>): LopAttendanceMark[] {
  return days.map(([date, status]) => ({ date, status }));
}

function spans(...items: Array<[string, string, boolean]>): LopLeaveSpan[] {
  return items.map(([startDate, endDate, paid]) => ({ startDate, endDate, paid }));
}

describe("lop-derivation (F1.4)", () => {
  it("charges nothing when there are no marks and no leave", () => {
    expect(deriveLopDays(PERIOD, undefined, [], [])).toBe(0);
  });

  it("ABSENT charges the full working day, HALF_DAY half of it", () => {
    // Mon 2 ABSENT, Tue 3 ABSENT, Wed 4 HALF_DAY → 1 + 1 + 0.5.
    expect(deriveLopDays(PERIOD, undefined, marks(
      ["2026-11-02", "ABSENT"],
      ["2026-11-03", "ABSENT"],
      ["2026-11-04", "HALF_DAY"],
    ), [])).toBe(2.5);
  });

  it("non-chargeable statuses (PRESENT / WFH / ON_LEAVE) never charge", () => {
    expect(deriveLopDays(PERIOD, undefined, marks(
      ["2026-11-02", "PRESENT"],
      ["2026-11-03", "WFH"],
      ["2026-11-04", "ON_LEAVE"],
    ), [])).toBe(0);
  });

  it("marks on weekends and full holidays never charge (working days only)", () => {
    const holidays = holidayLookupFrom([
      { date: d("2026-11-05"), isHalfDay: false }, // Thu — full holiday
    ]);
    // Sat 7 + Sun 8 + the holiday Thu 5.
    expect(deriveLopDays(PERIOD, holidays, marks(
      ["2026-11-05", "ABSENT"],
      ["2026-11-07", "ABSENT"],
      ["2026-11-08", "ABSENT"],
    ), [])).toBe(0);
  });

  it("a half-day holiday has working fraction 0.5: ABSENT charges 0.5, HALF_DAY 0.25", () => {
    const holidays = holidayLookupFrom([
      { date: d("2026-11-03"), isHalfDay: true }, // Tue
    ]);
    expect(deriveLopDays(PERIOD, holidays, marks(
      ["2026-11-03", "ABSENT"],
    ), [])).toBe(0.5);
    expect(deriveLopDays(PERIOD, holidays, marks(
      ["2026-11-03", "HALF_DAY"],
    ), [])).toBe(0.25);
  });

  it("unpaid approved leave charges its working days inside the period", () => {
    // Mon 9 → Wed 11 (3 working days), unpaid.
    expect(deriveLopDays(PERIOD, undefined, [], spans(
      ["2026-11-09", "2026-11-11", false],
    ))).toBe(3);
  });

  it("paid approved leave charges nothing", () => {
    expect(deriveLopDays(PERIOD, undefined, [], spans(
      ["2026-11-09", "2026-11-11", true],
    ))).toBe(0);
  });

  it("approved leave wins over attendance marks: paid leave shields an ABSENT day", () => {
    // Contradictory data: ABSENT marked on a day covered by APPROVED paid
    // leave — the day is authorized and paid, so no dock (and no double
    // charge through both paths).
    expect(deriveLopDays(PERIOD, undefined, marks(
      ["2026-11-09", "ABSENT"],
    ), spans(
      ["2026-11-09", "2026-11-11", true],
    ))).toBe(0);
  });

  it("approved unpaid leave over a HALF_DAY mark charges the full working fraction", () => {
    expect(deriveLopDays(PERIOD, undefined, marks(
      ["2026-11-09", "HALF_DAY"],
    ), spans(
      ["2026-11-09", "2026-11-09", false],
    ))).toBe(1);
  });

  it("leave spans crossing the period boundary charge only the in-period working days", () => {
    // Sat Nov 28 → Fri Dec 4: only Mon Nov 30 falls inside November.
    expect(deriveLopDays(PERIOD, undefined, [], spans(
      ["2026-11-28", "2026-12-04", false],
    ))).toBe(1);
  });

  it("disjoint sources sum without double counting (absent + half + unpaid leave)", () => {
    // Mon 2 ABSENT (1) + Tue 3 HALF_DAY (0.5) + Thu 5→Fri 6 unpaid (2) = 3.5.
    expect(deriveLopDays(PERIOD, undefined, marks(
      ["2026-11-02", "ABSENT"],
      ["2026-11-03", "HALF_DAY"],
    ), spans(
      ["2026-11-05", "2026-11-06", false],
    ))).toBe(3.5);
  });

  it("holidays inside an unpaid leave span reduce the charge (leave only charges working days)", () => {
    const holidays = holidayLookupFrom([
      { date: d("2026-11-10"), isHalfDay: false }, // Tue inside the span
    ]);
    // Mon 9 → Wed 11 with Tue a holiday → 2 working days.
    expect(deriveLopDays(PERIOD, holidays, [], spans(
      ["2026-11-09", "2026-11-11", false],
    ))).toBe(2);
  });

  it("five HALF_DAY marks stay clean at 2.5 (no float dust)", () => {
    expect(deriveLopDays(PERIOD, undefined, marks(
      ["2026-11-02", "HALF_DAY"],
      ["2026-11-03", "HALF_DAY"],
      ["2026-11-04", "HALF_DAY"],
      ["2026-11-05", "HALF_DAY"],
      ["2026-11-06", "HALF_DAY"],
    ), [])).toBe(2.5);
  });

  it("accepts Date objects as well as date strings, and rejects junk periods with 0", () => {
    expect(deriveLopDays(PERIOD, undefined, [
      { date: d("2026-11-02"), status: "ABSENT" },
    ], [
      { startDate: d("2026-11-05"), endDate: d("2026-11-06"), paid: false },
    ])).toBe(3);
    expect(deriveLopDays("junk", undefined, marks(["2026-11-02", "ABSENT"]), [])).toBe(0);
    expect(deriveLopDays("", undefined, marks(["2026-11-02", "ABSENT"]), [])).toBe(0);
  });
});
