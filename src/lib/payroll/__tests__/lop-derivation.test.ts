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
} from "@/lib/payroll/lop-derivation";
import { holidayLookupFrom } from "@/lib/hr/working-days";

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

describe("lop-derivation — PR-B07 (S4): unmarked-day mode + employment window", () => {
  it("default (no opts) is byte-identical IGNORED: unmarked days never charge", () => {
    expect(deriveLopDays(PERIOD, undefined, [], [])).toBe(0);
    expect(deriveLopDays(PERIOD, undefined, [], [], {})).toBe(0);
    expect(deriveLopDays(PERIOD, undefined, [], [], { unmarkedMode: "IGNORED" })).toBe(0);
  });

  it("ABSENT mode charges every unmarked working day (21 with an empty calendar)", () => {
    expect(deriveLopDays(PERIOD, undefined, [], [], { unmarkedMode: "ABSENT" })).toBe(21);
  });

  it("any record counts as marked in ABSENT mode — PRESENT shields its day", () => {
    // 21 working days, 3 marked PRESENT → 18 unmarked charge.
    expect(deriveLopDays(
      PERIOD, undefined,
      marks(["2026-11-02", "PRESENT"], ["2026-11-03", "WFH"], ["2026-11-04", "ON_LEAVE"]),
      [],
      { unmarkedMode: "ABSENT" },
    )).toBe(18);
  });

  it("ABSENT + HALF_DAY marks mix with unmarked charging without double counts", () => {
    // 1 absent (1) + 1 half (0.5) + 2 marked non-chargeable → 21 − 4 = 17 unmarked.
    expect(deriveLopDays(
      PERIOD, undefined,
      marks(["2026-11-02", "ABSENT"], ["2026-11-03", "HALF_DAY"], ["2026-11-04", "PRESENT"], ["2026-11-05", "WFH"]),
      [],
      { unmarkedMode: "ABSENT" },
    )).toBe(18.5);
  });

  it("paid leave shields its days from unmarked charging; unpaid leave charges them anyway", () => {
    // Paid span Nov 2–6 (5 working days) → unmarked 21 − 5 = 16.
    expect(deriveLopDays(PERIOD, undefined, [], spans(["2026-11-02", "2026-11-06", true]), { unmarkedMode: "ABSENT" })).toBe(16);
    // Unpaid span → 5 charged as leave, 16 unmarked → 21 total.
    expect(deriveLopDays(PERIOD, undefined, [], spans(["2026-11-02", "2026-11-06", false]), { unmarkedMode: "ABSENT" })).toBe(21);
  });

  it("employmentFrom clips pre-hire charging (marks AND unmarked)", () => {
    // Hired Nov 10 → window holds 15 working days (10..30); nothing marked → 15.
    expect(deriveLopDays(PERIOD, undefined, [], [], { unmarkedMode: "ABSENT", employmentFrom: "2026-11-10" })).toBe(15);
    // A PRE-hire ABSENT mark (Nov 4) never charges, window or not.
    expect(deriveLopDays(
      PERIOD, undefined,
      marks(["2026-11-04", "ABSENT"]),
      [],
      { employmentFrom: "2026-11-10" },
    )).toBe(0);
  });

  it("employmentUntil clips post-exit charging (the LWD mirror)", () => {
    // LWD Nov 6 → window holds 5 working days (2..6); 1 marked PRESENT → 4 unmarked.
    expect(deriveLopDays(
      PERIOD, undefined,
      marks(["2026-11-02", "PRESENT"]),
      [],
      { unmarkedMode: "ABSENT", employmentUntil: "2026-11-06" },
    )).toBe(4);
    // Post-LWD unmarked days never charge even in ABSENT mode.
    expect(deriveLopDays(PERIOD, undefined, [], [], { unmarkedMode: "ABSENT", employmentUntil: "2026-11-06" })).toBe(5);
  });

  it("unpaid leave outside the employment window charges nothing", () => {
    // Unpaid span Nov 16–20 but LWD Nov 13: outside the window.
    expect(deriveLopDays(
      PERIOD, undefined,
      [],
      spans(["2026-11-16", "2026-11-20", false]),
      { employmentUntil: "2026-11-13" },
    )).toBe(0);
  });

  it("half-day holidays halve the unmarked charge too", () => {
    const hol = holidayLookupFrom([{ date: d("2026-11-02"), isHalfDay: true }]);
    // 20 full days + 1 half day = 20.5 with nothing marked.
    expect(deriveLopDays(PERIOD, hol, [], [], { unmarkedMode: "ABSENT" })).toBe(20.5);
  });
});

// ---------------------------------------------------------------------------
// P15 (PR-06) — partially-paid leave fraction + the breakdown walk
// (deriveLopBreakdownBetween: ONE walk computes the total the slips store
// AND the per-source detail they freeze). Same reference month (21
// weekdays); the charge for a covered working day is (1 − fraction) × the
// working fraction.
// ---------------------------------------------------------------------------

import {
  deriveLopBreakdownBetween,
} from "@/lib/payroll/lop-derivation";

function pplSpans(...items: Array<[string, string, boolean, number?, string?]>): LopLeaveSpan[] {
  return items.map(([startDate, endDate, paid, salaryFraction, key]) => ({
    startDate, endDate, paid,
    ...(salaryFraction !== undefined ? { salaryFraction } : {}),
    ...(key !== undefined ? { key } : {}),
  }));
}

describe("lop-derivation — P15 (PR-06): partially-paid leave", () => {
  it("half-pay leave charges half a day per working day taken", () => {
    // Mon 9 → Wed 11 (3 working days) at 50% salary → 1.5 days docked.
    expect(deriveLopDays(PERIOD, undefined, [], pplSpans(
      ["2026-11-09", "2026-11-11", true, 0.5, "lt-half"],
    ))).toBe(1.5);
  });

  it("fraction 1 (the default) is byte-identical to fully-paid: 0 charge", () => {
    expect(deriveLopDays(PERIOD, undefined, [], pplSpans(
      ["2026-11-09", "2026-11-11", true, 1, "lt-full"],
    ))).toBe(0);
  });

  it("an omitted salaryFraction (pre-P15 callers) reads as fully paid", () => {
    expect(deriveLopDays(PERIOD, undefined, [], pplSpans(
      ["2026-11-09", "2026-11-11", true],
    ))).toBe(0);
  });

  it("fraction 0 on a paid type charges like unpaid", () => {
    expect(deriveLopDays(PERIOD, undefined, [], pplSpans(
      ["2026-11-09", "2026-11-11", true, 0, "lt-zero"],
    ))).toBe(3);
  });

  it("out-of-range fractions clamp to [0, 1] (never a bonus, never negative)", () => {
    expect(deriveLopDays(PERIOD, undefined, [], pplSpans(
      ["2026-11-09", "2026-11-10", true, 1.5, "lt-over"],
    ))).toBe(0);
    expect(deriveLopDays(PERIOD, undefined, [], pplSpans(
      ["2026-11-09", "2026-11-10", true, -0.25, "lt-under"],
    ))).toBe(2);
  });

  it("salaryFraction is ignored on unpaid spans (they charge the full day)", () => {
    expect(deriveLopDays(PERIOD, undefined, [], pplSpans(
      ["2026-11-09", "2026-11-10", false, 0.5, "lt-unpaid"],
    ))).toBe(2);
  });

  it("a PPL day on a half-day holiday charges (1 − fraction) × 0.5", () => {
    const holidays = holidayLookupFrom([
      { date: d("2026-11-09"), isHalfDay: true },
    ]);
    // Working fraction 0.5 × (1 − 0.5) = 0.25.
    expect(deriveLopDays(PERIOD, holidays, [], pplSpans(
      ["2026-11-09", "2026-11-09", true, 0.5, "lt-half"],
    ))).toBe(0.25);
  });

  it("PPL shields its days from attendance marks at the FRACTIONAL charge (leave wins)", () => {
    // An ABSENT mark on a half-pay leave day docks 0.5 — not the full day.
    expect(deriveLopDays(PERIOD, undefined, marks(
      ["2026-11-09", "ABSENT"],
    ), pplSpans(
      ["2026-11-09", "2026-11-09", true, 0.5, "lt-half"],
    ))).toBe(0.5);
  });

  it("mixed spans sum: fully-paid shields, half-pay docks half, unpaid docks all", () => {
    expect(deriveLopDays(PERIOD, undefined, [], pplSpans(
      ["2026-11-02", "2026-11-03", true, 1, "lt-full"],      // 0
      ["2026-11-04", "2026-11-05", true, 0.5, "lt-half"],    // 1.0
      ["2026-11-06", "2026-11-06", false, 0, "lt-unpaid"],   // 1.0
    ))).toBe(2);
  });

  it("the employment window clips PPL days exactly like unpaid ones", () => {
    // Span Mon 2 → Fri 6, but the employee left on Tue 3: only Mon+Tue
    // count → 2 × 0.5 = 1.
    expect(deriveLopDays(PERIOD, undefined, [], pplSpans(
      ["2026-11-02", "2026-11-06", true, 0.5, "lt-half"],
    ), { employmentUntil: "2026-11-03" })).toBe(1);
  });
});

describe("lop-derivation — P15 (PR-06): the breakdown walk", () => {
  const bd = (
    spansIn: LopLeaveSpan[],
    marksIn: LopAttendanceMark[] = [],
    opts: { unmarkedMode?: "IGNORED" | "ABSENT"; employmentFrom?: string | null; employmentUntil?: string | null } = {},
  ) => deriveLopBreakdownBetween(d("2026-11-01"), d("2026-11-30"), undefined, marksIn, spansIn, opts);

  it("returns the total plus per-key leave rows and attendance buckets", () => {
    const r = bd(pplSpans(
      ["2026-11-02", "2026-11-03", true, 1, "lt-full"],     // 2 taken, 0 charged
      ["2026-11-04", "2026-11-05", true, 0.5, "lt-half"],   // 2 taken, 1 charged
      ["2026-11-06", "2026-11-06", false, 0, "lt-unpaid"],  // 1 taken, 1 charged
    ), marks(["2026-11-09", "ABSENT"], ["2026-11-10", "HALF_DAY"]));
    expect(r.total).toBe(3.5); // 1 + 1 + 1 + 0.5
    expect(r.absentDays).toBe(1);
    expect(r.halfDays).toBe(0.5);
    expect(r.unmarkedDays).toBe(0);
    expect(r.leave).toEqual([
      { key: "lt-full", takenDays: 2, chargedDays: 0 },
      { key: "lt-half", takenDays: 2, chargedDays: 1 },
      { key: "lt-unpaid", takenDays: 1, chargedDays: 1 },
    ]);
  });

  it("two requests of the same type MERGE into one breakdown row", () => {
    const r = bd(pplSpans(
      ["2026-11-02", "2026-11-03", true, 0.5, "lt-half"],
      ["2026-11-16", "2026-11-17", true, 0.5, "lt-half"],
    ));
    expect(r.total).toBe(2);
    expect(r.leave).toEqual([{ key: "lt-half", takenDays: 4, chargedDays: 2 }]);
  });

  it("spans without a key ride the total without a breakdown row", () => {
    const r = bd(pplSpans(["2026-11-02", "2026-11-03", false]));
    expect(r.total).toBe(2);
    expect(r.leave).toEqual([]);
  });

  it("PR-B07 unmarked mode fills the unmarked bucket, leave still wins", () => {
    const r = bd(pplSpans(["2026-11-02", "2026-11-02", true, 0.5, "lt-half"]), [], { unmarkedMode: "ABSENT" });
    // 20 unmarked working days (21 − the leave day) + the half-pay day.
    expect(r.total).toBe(20.5);
    expect(r.unmarkedDays).toBe(20);
    expect(r.leave).toEqual([{ key: "lt-half", takenDays: 1, chargedDays: 0.5 }]);
  });

  it("an inverted window returns all zeros (the guard clause)", () => {
    const r = deriveLopBreakdownBetween(d("2026-11-30"), d("2026-11-01"), undefined, [], []);
    expect(r).toEqual({ total: 0, absentDays: 0, halfDays: 0, unmarkedDays: 0, leave: [] });
  });

  it("every count is rounded to 2 decimals (no float dust)", () => {
    // The whole month (21 weekdays) at half pay → 10.5 exactly; the
    // rounding is what kills 10.499999… float dust.
    const r = bd(pplSpans(["2026-11-02", "2026-11-30", true, 0.5, "lt-half"]));
    expect(r.total).toBe(10.5);
    expect(r.leave[0]).toEqual({ key: "lt-half", takenDays: 21, chargedDays: 10.5 });
  });
});

// ---------------------------------------------------------------------------
// P17 (PR-B27) — the proration basis switch (Workspace.lopBasisMode):
// HYBRID (default, leave-wins = the pre-P17 walk) | LEAVE (spans only) |
// ATTENDANCE (marks only; leave never charges, taken days still recorded).
// ---------------------------------------------------------------------------

describe("lop-derivation — P17 (PR-B27): the basis mode switch", () => {
  const bd = (
    spansIn: LopLeaveSpan[],
    marksIn: LopAttendanceMark[] = [],
    opts: { unmarkedMode?: "IGNORED" | "ABSENT"; basisMode?: "HYBRID" | "LEAVE" | "ATTENDANCE" } = {},
  ) => deriveLopBreakdownBetween(d("2026-11-01"), d("2026-11-30"), undefined, marksIn, spansIn, opts);

  it("LEAVE: attendance marks (incl. ABSENT) never charge without a covering span", () => {
    const r = bd([], marks(
      ["2026-11-02", "ABSENT"],
      ["2026-11-03", "ABSENT"],
      ["2026-11-04", "HALF_DAY"],
    ), { basisMode: "LEAVE" });
    expect(r.total).toBe(0);
    expect(r.absentDays).toBe(0);
    expect(r.halfDays).toBe(0);
  });

  it("LEAVE: spans still charge their fraction complement (PPL unchanged)", () => {
    // Mon 9 → Wed 11 at 50% pay → 1.5; unpaid span Fri 13 (1 day) → 1.
    const r = bd(pplSpans(
      ["2026-11-09", "2026-11-11", true, 0.5, "lt-half"],
      ["2026-11-13", "2026-11-13", false, 0, "lt-unpaid"],
    ), [], { basisMode: "LEAVE" });
    expect(r.total).toBe(2.5);
    expect(r.leave).toEqual([
      { key: "lt-half", takenDays: 3, chargedDays: 1.5 },
      { key: "lt-unpaid", takenDays: 1, chargedDays: 1 },
    ]);
  });

  it("LEAVE: unmarked-as-absent does NOT apply (unmarked-mode needs HYBRID/ATTENDANCE)", () => {
    const r = bd([], [], { basisMode: "LEAVE", unmarkedMode: "ABSENT" });
    expect(r.total).toBe(0);
    expect(r.unmarkedDays).toBe(0);
  });

  it("ATTENDANCE: leave never charges — an unpaid span records taken at charged 0", () => {
    const r = bd(pplSpans(
      ["2026-11-09", "2026-11-11", false, 0, "lt-unpaid"],
    ), [], { basisMode: "ATTENDANCE" });
    expect(r.total).toBe(0);
    expect(r.leave).toEqual([{ key: "lt-unpaid", takenDays: 3, chargedDays: 0 }]);
  });

  it("ATTENDANCE: partially-paid spans charge 0 too (the mode, not the fraction)", () => {
    const r = bd(pplSpans(
      ["2026-11-09", "2026-11-10", true, 0.5, "lt-half"],
    ), [], { basisMode: "ATTENDANCE" });
    expect(r.total).toBe(0);
    expect(r.leave).toEqual([{ key: "lt-half", takenDays: 2, chargedDays: 0 }]);
  });

  it("ATTENDANCE: marks decide when there is no span (ABSENT/HALF_DAY charge)", () => {
    const r = bd([], marks(
      ["2026-11-02", "ABSENT"],
      ["2026-11-03", "HALF_DAY"],
    ), { basisMode: "ATTENDANCE" });
    expect(r.total).toBe(1.5);
    expect(r.absentDays).toBe(1);
    expect(r.halfDays).toBe(0.5);
  });

  it("ATTENDANCE: unmarked-as-absent still applies (the S4 knob rides both mark-feeding modes)", () => {
    // 21 weekdays, one with an ABSENT mark → 20 unmarked charge.
    const r = bd([], marks(["2026-11-02", "ABSENT"]), { basisMode: "ATTENDANCE", unmarkedMode: "ABSENT" });
    expect(r.total).toBe(21);
    expect(r.unmarkedDays).toBe(20);
    expect(r.absentDays).toBe(1);
  });

  it("ATTENDANCE: a covering span shields the day from its mark (leave never charges)", () => {
    // Mon 9 ABSENT + an unpaid leave span over Mon 9 → the span records
    // taken 1 charged 0; the ABSENT mark never fires.
    const r = bd(
      pplSpans(["2026-11-09", "2026-11-09", false, 0, "lt-unpaid"]),
      marks(["2026-11-09", "ABSENT"]),
      { basisMode: "ATTENDANCE" },
    );
    expect(r.total).toBe(0);
    expect(r.absentDays).toBe(0);
    expect(r.leave).toEqual([{ key: "lt-unpaid", takenDays: 1, chargedDays: 0 }]);
  });

  it("HYBRID (explicit) is byte-identical to the omitted default (leave-wins)", () => {
    const spansIn = pplSpans(
      ["2026-11-02", "2026-11-03", true, 0.5, "lt-half"],
      ["2026-11-06", "2026-11-06", false, 0, "lt-unpaid"],
    );
    const marksIn = marks(["2026-11-09", "ABSENT"], ["2026-11-10", "HALF_DAY"]);
    const omitted = bd(spansIn, marksIn);
    const explicit = bd(spansIn, marksIn, { basisMode: "HYBRID" });
    expect(explicit).toEqual(omitted);
    // And the totals match the documented HYBRID arithmetic: 1 (half-pay
    // over 2 days) + 1 (unpaid Fri 6) + 1 (ABSENT) + 0.5 (half-day) = 3.5.
    expect(explicit.total).toBe(3.5);
  });

  it("an unknown basis value clamps to HYBRID (a bad row can't invent a fourth mode)", () => {
    // Cast through unknown — the loader clamps earlier, the kernel stays
    // defensive anyway.
    const r = bd(
      pplSpans(["2026-11-09", "2026-11-09", false, 0, "lt-unpaid"]),
      marks(["2026-11-09", "ABSENT"]),
      { basisMode: "GARBAGE" as unknown as "HYBRID" },
    );
    // HYBRID leave-wins: the unpaid span charges 1, the mark under it never fires.
    expect(r.total).toBe(1);
    expect(r.leave).toEqual([{ key: "lt-unpaid", takenDays: 1, chargedDays: 1 }]);
  });
});
