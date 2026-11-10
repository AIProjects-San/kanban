import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// P27 (LV-08) — the leave period window kernel tests (the resolution and
// validation matrix). The kernel is pure (day keys in, windows out); the
// action guards and the engine consumers are covered in their own suites.
// ---------------------------------------------------------------------------

import {
  implicitCalendarWindow,
  windowForDate,
  resolveActiveWindow,
  windowForBucket,
  carrySourceBucket,
  validateLeavePeriod,
  monthsIntoWindow,
  type LeavePeriodInput,
} from "@/lib/leave-period";

const FISCAL_27: LeavePeriodInput = {
  id: "p1",
  name: "FY 2027/28 (Apr → Mar)",
  startDate: "2027-04-01",
  endDate: "2028-03-31",
};
const FISCAL_28: LeavePeriodInput = {
  id: "p2",
  name: "FY 2028/29 (Apr → Mar)",
  startDate: "2028-04-01",
  endDate: "2029-03-31",
};

describe("windowForDate — the resolution matrix", () => {
  it("no periods: every date falls to the implicit calendar year", () => {
    const w = windowForDate([], "2026-07-14");
    expect(w).toEqual({ bucketYear: 2026, start: "2026-01-01", end: "2026-12-31", name: null, periodId: null });
    expect(windowForDate([], "2026-12-31").end).toBe("2026-12-31");
    expect(windowForDate([], "2027-01-01").bucketYear).toBe(2027);
  });

  it("a date inside a period resolves to that period (bucket = start year)", () => {
    expect(windowForDate([FISCAL_27], "2027-04-01")).toMatchObject({ periodId: "p1", bucketYear: 2027, start: "2027-04-01", end: "2028-03-31" });
    expect(windowForDate([FISCAL_27], "2028-01-15")).toMatchObject({ periodId: "p1", bucketYear: 2027 });
    expect(windowForDate([FISCAL_27], "2028-03-31")).toMatchObject({ periodId: "p1" });
  });

  it("the dead zone (after the last period ended) spends against the closed window", () => {
    // FY27/28 ended Mar 31 2028; no next period defined yet.
    expect(windowForDate([FISCAL_27], "2028-04-02")).toMatchObject({ periodId: "p1", bucketYear: 2027 });
    // With the chain complete, May 2028 is inside FY28/29 instead.
    expect(windowForDate([FISCAL_27, FISCAL_28], "2028-04-02")).toMatchObject({ periodId: "p2", bucketYear: 2028 });
  });

  it("a date BEFORE the first period falls to the implicit calendar year (consumption keeps working; the engine's grant phase skips)", () => {
    expect(windowForDate([FISCAL_27], "2026-11-20")).toEqual(implicitCalendarWindow(2026));
    expect(windowForDate([FISCAL_27], "2027-02-10")).toEqual(implicitCalendarWindow(2027));
  });
});

describe("resolveActiveWindow — the job's target", () => {
  it("equals windowForDate (containing → closed fallback → implicit)", () => {
    expect(resolveActiveWindow([FISCAL_27, FISCAL_28], "2028-06-01")).toMatchObject({ periodId: "p2" });
    expect(resolveActiveWindow([FISCAL_27], "2028-06-01")).toMatchObject({ periodId: "p1" });
    expect(resolveActiveWindow([], "2028-06-01")).toEqual(implicitCalendarWindow(2028));
  });
});

describe("windowForBucket — the materializer's window", () => {
  it("the explicit period whose start year is the bucket, else the implicit calendar year", () => {
    expect(windowForBucket([FISCAL_27], 2027)).toMatchObject({ periodId: "p1", start: "2027-04-01" });
    expect(windowForBucket([FISCAL_27], 2026)).toEqual(implicitCalendarWindow(2026));
    expect(windowForBucket([], 2027)).toEqual(implicitCalendarWindow(2027));
  });
});

describe("carrySourceBucket — the rollover source", () => {
  it("null when the window is implicit (the classic year − 1 rule)", () => {
    expect(carrySourceBucket([FISCAL_27], implicitCalendarWindow(2026))).toBeNull();
    expect(carrySourceBucket([], implicitCalendarWindow(2027))).toBeNull();
  });

  it("the chain predecessor's bucket for a later period", () => {
    expect(carrySourceBucket([FISCAL_27, FISCAL_28], windowForDate([FISCAL_27, FISCAL_28], "2028-06-01"))).toBe(2027);
  });

  it("startYear − 1 for the FIRST period (the last calendar bucket with history)", () => {
    expect(carrySourceBucket([FISCAL_27], windowForDate([FISCAL_27], "2027-06-01"))).toBe(2026);
    // A Jan-1-start first period also carries from the prior calendar year.
    const janStart: LeavePeriodInput = { id: "j1", name: "Calendar 2028", startDate: "2028-01-01", endDate: "2028-12-31" };
    expect(carrySourceBucket([janStart], windowForDate([janStart], "2028-06-01"))).toBe(2027);
  });
});

describe("validateLeavePeriod — the rule matrix", () => {
  const EXISTING: LeavePeriodInput[] = [FISCAL_27];

  it("accepts a clean future window extending the chain", () => {
    expect(validateLeavePeriod({ name: "FY 2028/29", startDate: "2028-04-01", endDate: "2029-03-31" }, EXISTING)).toEqual({ ok: true, reason: "" });
  });

  it("accepts the first period ever", () => {
    expect(validateLeavePeriod({ name: "First", startDate: "2029-01-01", endDate: "2029-12-31" }, [])).toEqual({ ok: true, reason: "" });
  });

  it("refuses: empty / over-long name, bad date shapes, reversed or zero-length windows", () => {
    expect(validateLeavePeriod({ name: "   ", startDate: "2028-04-01", endDate: "2029-03-31" }, []).ok).toBe(false);
    expect(validateLeavePeriod({ name: "x".repeat(81), startDate: "2028-04-01", endDate: "2029-03-31" }, []).ok).toBe(false);
    expect(validateLeavePeriod({ name: "X", startDate: "not-a-date", endDate: "2029-03-31" }, []).ok).toBe(false);
    expect(validateLeavePeriod({ name: "X", startDate: "2029-03-31", endDate: "2029-03-31" }, []).ok).toBe(false);
    expect(validateLeavePeriod({ name: "X", startDate: "2029-03-31", endDate: "2028-04-01" }, []).ok).toBe(false);
  });

  it("refuses windows over 370 days (annual windows only)", () => {
    expect(validateLeavePeriod({ name: "Too long", startDate: "2028-04-01", endDate: "2029-06-30" }, []).ok).toBe(false);
    // 370 days exactly is fine; 371 is not.
    expect(validateLeavePeriod({ name: "370d", startDate: "2028-04-01", endDate: "2029-04-05" }, []).ok).toBe(true);
    expect(validateLeavePeriod({ name: "371d", startDate: "2028-04-01", endDate: "2029-04-06" }, []).ok).toBe(false);
  });

  it("refuses overlap with an existing period", () => {
    expect(validateLeavePeriod({ name: "Overlap", startDate: "2028-01-01", endDate: "2028-06-30" }, EXISTING).ok).toBe(false);
  });

  it("refuses a second window starting in the same calendar year (the bucket must stay unique)", () => {
    expect(validateLeavePeriod({ name: "Split H1", startDate: "2027-06-01", endDate: "2027-09-30" }, EXISTING).ok).toBe(false);
  });

  it("refuses a window floating between existing windows (forks the chain)", () => {
    const two: LeavePeriodInput[] = [FISCAL_27, FISCAL_28];
    // Wholly after the chain = forward extension; wholly before = backward.
    expect(validateLeavePeriod({ name: "Backward ext", startDate: "2026-01-01", endDate: "2026-12-31" }, two).ok).toBe(true);
    expect(validateLeavePeriod({ name: "Forward ext", startDate: "2029-04-01", endDate: "2030-03-31" }, two).ok).toBe(true);
    // A window inside a YEAR-LONG GAP between two periods: no overlap, no
    // shared start year — only the chain rule catches it.
    const gapped: LeavePeriodInput[] = [
      { id: "a", name: "A", startDate: "2027-01-01", endDate: "2027-06-30" },
      { id: "b", name: "B", startDate: "2029-07-01", endDate: "2029-12-31" },
    ];
    const floater = validateLeavePeriod({ name: "Floater", startDate: "2028-05-01", endDate: "2028-12-31" }, gapped);
    expect(floater.ok).toBe(false);
    expect(floater.reason).toContain("extend the chain");
  });
});

describe("monthsIntoWindow — the lapse clock", () => {
  it("counts complete months from the window's start (0 in the first month)", () => {
    expect(monthsIntoWindow("2027-04-01", "2027-04-30")).toBe(0);
    expect(monthsIntoWindow("2027-04-01", "2027-05-01")).toBe(1);
    expect(monthsIntoWindow("2027-04-01", "2028-01-01")).toBe(9);
    expect(monthsIntoWindow("2027-04-01", "2028-03-31")).toBe(11);
  });

  it("clamps a pre-window asOf at 0", () => {
    expect(monthsIntoWindow("2027-04-01", "2027-01-15")).toBe(0);
  });

  it("is byte-identical to monthsIntoYear when the window IS the calendar year", () => {
    // monthsIntoYear(2027, "2027-04-01") === 3 — the pre-P27 lapse clock.
    expect(monthsIntoWindow("2027-01-01", "2027-04-01")).toBe(3);
  });
});
