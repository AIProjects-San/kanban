import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// P30 (LV-01/LV-11, L10) — the compensatory day walk's full rule matrix.
// The kernel is the ONE rule both surfaces run (submission + the approval's
// in-transaction re-validation), so every refused shape is pinned here, not
// in the action mocks.
// ---------------------------------------------------------------------------

import {
  earnedCompDays,
  claimedNonWorkingDays,
} from "@/lib/leave/compensatory-leave";
import { holidayLookupFrom } from "@/lib/hr/working-days";

/** 2026-01: Fri 2, Sat 3, Sun 4, Mon 5 … (a weekend inside the first week). */
const HOLIDAYS = holidayLookupFrom([
  // A full public holiday on Tue 2026-01-06, a half-day holiday on Wed 2026-01-07.
  { date: "2026-01-06", isHalfDay: false },
  { date: "2026-01-07", isHalfDay: true },
]);

const att = (entries: Record<string, string | undefined>) => {
  const m = new Map<string, string>();
  for (const [k, v] of Object.entries(entries)) {
    if (v !== undefined) m.set(k, v);
  }
  return m;
};

describe("earnedCompDays", () => {
  it("earns a full comp day per worked weekend day (PRESENT and WFH)", () => {
    const walk = earnedCompDays({
      workFrom: "2026-01-03",
      workTo: "2026-01-04",
      holidays: HOLIDAYS,
      attendanceByDay: att({ "2026-01-03": "PRESENT", "2026-01-04": "WFH" }),
    });
    expect(walk.days).toBe(2);
    expect(walk.problems).toEqual([]);
  });

  it("earns a full comp day for a worked full holiday (the holiday-list rule)", () => {
    const walk = earnedCompDays({
      workFrom: "2026-01-06",
      workTo: "2026-01-06",
      holidays: HOLIDAYS,
      attendanceByDay: att({ "2026-01-06": "PRESENT" }),
    });
    expect(walk.days).toBe(1);
    expect(walk.problems).toEqual([]);
  });

  it("earns half a comp day for a HALF_DAY attendance mark", () => {
    const walk = earnedCompDays({
      workFrom: "2026-01-03",
      workTo: "2026-01-03",
      holidays: HOLIDAYS,
      attendanceByDay: att({ "2026-01-03": "HALF_DAY" }),
    });
    expect(walk.days).toBe(0.5);
    expect(walk.problems).toEqual([]);
  });

  it("refuses a working day inside the span (naming it; the whole claim is invalid)", async () => {
    const walk = earnedCompDays({
      workFrom: "2026-01-02",
      workTo: "2026-01-03",
      holidays: HOLIDAYS,
      attendanceByDay: att({ "2026-01-02": "PRESENT", "2026-01-03": "PRESENT" }),
    });
    // The Saturday still prices (days 1) — but ANY problem refuses the
    // claim at the action layer, so the walk reports both honestly.
    expect(walk.days).toBe(1);
    expect(walk.problems).toEqual([
      { date: "2026-01-02", reason: "is a working day — comp-off claims only cover weekends and holidays" },
    ]);
  });

  it("refuses a half-day holiday (a half-day holiday is a working half day)", () => {
    const walk = earnedCompDays({
      workFrom: "2026-01-07",
      workTo: "2026-01-07",
      holidays: HOLIDAYS,
      attendanceByDay: att({ "2026-01-07": "PRESENT" }),
    });
    expect(walk.days).toBe(0);
    expect(walk.problems.length).toBe(1);
    expect(walk.problems[0].date).toBe("2026-01-07");
  });

  it("refuses unmarked days and ABSENT/ON_LEAVE days with distinct reasons", () => {
    const walk = earnedCompDays({
      workFrom: "2026-01-03",
      workTo: "2026-01-04",
      holidays: HOLIDAYS,
      attendanceByDay: att({ "2026-01-03": "ABSENT", "2026-01-04": "ON_LEAVE" }),
    });
    expect(walk.days).toBe(0);
    expect(walk.problems.map((p) => p.date)).toEqual(["2026-01-03", "2026-01-04"]);
    expect(walk.problems[0].reason).toContain("shows absent attendance");
    expect(walk.problems[1].reason).toContain("shows on leave attendance");
  });

  it("refuses a day with no attendance row at all", () => {
    const walk = earnedCompDays({
      workFrom: "2026-01-03",
      workTo: "2026-01-03",
      holidays: HOLIDAYS,
      attendanceByDay: att({}),
    });
    expect(walk.days).toBe(0);
    expect(walk.problems[0].reason).toContain("no attendance marked");
  });

  it("mixed spans report BOTH the earned days and the refused days", () => {
    const walk = earnedCompDays({
      workFrom: "2026-01-03",
      workTo: "2026-01-05",
      holidays: HOLIDAYS,
      attendanceByDay: att({ "2026-01-03": "PRESENT", "2026-01-05": "PRESENT" }),
    });
    // Sat earned, Sun unmarked (refused), Mon is a working day (refused).
    expect(walk.days).toBe(1);
    expect(walk.problems.map((p) => p.date)).toEqual(["2026-01-04", "2026-01-05"]);
  });
});

describe("claimedNonWorkingDays (the ESS preview mirror)", () => {
  it("counts weekends and full holidays; skips working and half-day-holiday days", () => {
    // Sat 3 + Sun 4 + Tue 6 (full holiday) = 3; Mon 5 and Wed 7 don't count.
    expect(claimedNonWorkingDays("2026-01-03", "2026-01-07", HOLIDAYS)).toBe(3);
    expect(claimedNonWorkingDays("2026-01-02", "2026-01-02", HOLIDAYS)).toBe(0);
  });
});
