import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// G4 — the timesheet kernel tests: the status graph (incl. the REJECTED →
// DRAFT re-submission edge), the four-eyes predicate, the hours math, the
// window-coverage predicate and the hours → paid-days bridge math the
// reviewed payroll hook will consume.
// ---------------------------------------------------------------------------

import {
  canTransitionTimesheet,
  isEditableTimesheet,
  canApproveTimesheet,
  sumLineHours,
  overtimeHours,
  billableHours,
  isValidTimesheetLine,
  timesheetCoversWindow,
  hoursToPaidDays,
  STANDARD_HOURS_PER_WORKING_DAY,
} from "../timesheets";

describe("timesheet status graph", () => {
  it("walks DRAFT → SUBMITTED → APPROVED → LOCKED and nothing leaves LOCKED", () => {
    expect(canTransitionTimesheet("DRAFT", "SUBMITTED")).toBe(true);
    expect(canTransitionTimesheet("SUBMITTED", "APPROVED")).toBe(true);
    expect(canTransitionTimesheet("APPROVED", "LOCKED")).toBe(true);
    expect(canTransitionTimesheet("LOCKED", "DRAFT")).toBe(false);
    expect(canTransitionTimesheet("LOCKED", "SUBMITTED")).toBe(false);
  });

  it("rejects and returns the sheet to its author: REJECTED → DRAFT, then re-submit", () => {
    expect(canTransitionTimesheet("SUBMITTED", "REJECTED")).toBe(true);
    expect(canTransitionTimesheet("REJECTED", "DRAFT")).toBe(true);
    expect(canTransitionTimesheet("REJECTED", "SUBMITTED")).toBe(false); // via DRAFT only
  });

  it("refuses the illegal jumps (draft straight to approved, approval back to draft)", () => {
    expect(canTransitionTimesheet("DRAFT", "APPROVED")).toBe(false);
    expect(canTransitionTimesheet("DRAFT", "LOCKED")).toBe(false);
    expect(canTransitionTimesheet("APPROVED", "DRAFT")).toBe(false);
    expect(canTransitionTimesheet("APPROVED", "REJECTED")).toBe(false);
  });

  it("only the draft family is editable", () => {
    expect(isEditableTimesheet("DRAFT")).toBe(true);
    expect(isEditableTimesheet("REJECTED")).toBe(true);
    expect(isEditableTimesheet("SUBMITTED")).toBe(false);
    expect(isEditableTimesheet("APPROVED")).toBe(false);
    expect(isEditableTimesheet("LOCKED")).toBe(false);
  });
});

describe("four-eyes on the subject", () => {
  it("nobody approves their own hours — anyone else may", () => {
    expect(canApproveTimesheet("u-yuki", "u-yuki")).toBe(false);
    expect(canApproveTimesheet("u-yuki", "u-hr")).toBe(true);
  });
});

describe("hours math", () => {
  const lines = [
    { hours: 8, isOvertime: false, isBillable: true },
    { hours: 7.5, isOvertime: false, isBillable: false },
    { hours: 2, isOvertime: true, isBillable: true },
    { hours: 1.25, isOvertime: true, isBillable: false },
  ];

  it("sums, splits overtime and billable, materialized to 2dp", () => {
    expect(sumLineHours(lines)).toBe(18.75);
    expect(overtimeHours(lines)).toBe(3.25);
    expect(billableHours(lines)).toBe(10);
  });

  it("tolerates non-finite garbage hours as zero (never NaN)", () => {
    expect(sumLineHours([{ hours: Number.NaN }])).toBe(0);
    expect(overtimeHours([{ hours: Number.NaN, isOvertime: true }])).toBe(0);
  });
});

describe("line validation twin", () => {
  it("accepts sane lines inside the window", () => {
    expect(
      isValidTimesheetLine({ hours: 7.5, workDay: "2026-11-10", periodStartDay: "2026-11-01", periodEndDay: "2026-11-30" }),
    ).toBeNull();
  });

  it("refuses zero/negative/over-24 hours and days outside the window", () => {
    expect(
      isValidTimesheetLine({ hours: 0, workDay: "2026-11-10", periodStartDay: "2026-11-01", periodEndDay: "2026-11-30" }),
    ).toMatch(/between 0 and 24/);
    expect(
      isValidTimesheetLine({ hours: 25, workDay: "2026-11-10", periodStartDay: "2026-11-01", periodEndDay: "2026-11-30" }),
    ).toMatch(/between 0 and 24/);
    expect(
      isValidTimesheetLine({ hours: 8, workDay: "2026-10-31", periodStartDay: "2026-11-01", periodEndDay: "2026-11-30" }),
    ).toMatch(/inside the timesheet's period/);
  });
});

describe("window coverage (the payroll-consumption predicate)", () => {
  const november = { start: new Date("2026-11-01T00:00:00Z"), end: new Date("2026-11-30T23:59:59Z") };

  it("a monthly sheet covers the monthly window (and its weekly sub-windows)", () => {
    expect(
      timesheetCoversWindow({ periodStart: "2026-11-01", periodEnd: "2026-11-30" }, november),
    ).toBe(true);
    expect(
      timesheetCoversWindow(
        { periodStart: "2026-11-01", periodEnd: "2026-11-30" },
        { start: new Date("2026-11-02T00:00:00Z"), end: new Date("2026-11-08T23:59:59Z") },
      ),
    ).toBe(true);
  });

  it("a weekly sheet does NOT cover the monthly window (nor a disjoint week)", () => {
    expect(
      timesheetCoversWindow({ periodStart: "2026-11-02", periodEnd: "2026-11-08" }, november),
    ).toBe(false);
    expect(
      timesheetCoversWindow({ periodStart: "2026-11-16", periodEnd: "2026-11-22" }, november),
    ).toBe(false);
    expect(
      timesheetCoversWindow({ periodStart: "2026-12-01", periodEnd: "2026-12-31" }, november),
    ).toBe(false);
  });
});

describe("hoursToPaidDays (the payroll bridge math)", () => {
  it("an 8h-per-working-day month translates to exactly the working days", () => {
    expect(hoursToPaidDays(160, 20)).toBe(20);
    expect(hoursToPaidDays(8, 1)).toBe(1);
  });

  it("a part-time month prorates fractionally (the 0.5-day granularity survives)", () => {
    expect(hoursToPaidDays(140, 20)).toBe(17.5);
    expect(hoursToPaidDays(17, 20)).toBe(2.13); // 2.125 → round2
  });

  it("clamps: zero hours → zero days; a hostile sheet cannot pay 7× the period", () => {
    expect(hoursToPaidDays(0, 20)).toBe(0);
    expect(hoursToPaidDays(400, 20)).toBe(50); // 400 h ÷ 8 — 2.5× the period, still under the clamp
    expect(hoursToPaidDays(1200, 20)).toBe(140); // 7 × 20 — the hard ceiling
    expect(hoursToPaidDays(400, 0)).toBe(7); // degenerate denominator still bounded
  });

  it("pins the standard day at 8h (the workspace default day's paid span)", () => {
    expect(STANDARD_HOURS_PER_WORKING_DAY).toBe(8);
  });
});
