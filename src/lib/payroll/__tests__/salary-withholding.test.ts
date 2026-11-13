import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// P8 (PR-19/PR-B13, F3.3) — salary-withholding kernel tests: hold-window
// math, overlap detection, validation, and the release plan (per-slip rows,
// zero-net skips named, total rounding).
// ---------------------------------------------------------------------------

import {
  isPeriodHeld,
  windowsOverlap,
  validateWithholdingWindow,
  planWithholdingRelease,
  withholdingReleaseLabel,
} from "@/lib/payroll/salary-withholding";

describe("isPeriodHeld", () => {
  const window = { fromPeriod: "2026-11", untilPeriod: "2027-01" };

  it("holds inside the window, boundaries inclusive", () => {
    expect(isPeriodHeld(window, "2026-11")).toBe(true);
    expect(isPeriodHeld(window, "2026-12")).toBe(true);
    expect(isPeriodHeld(window, "2027-01")).toBe(true);
  });

  it("does not hold outside the window", () => {
    expect(isPeriodHeld(window, "2026-10")).toBe(false);
    expect(isPeriodHeld(window, "2027-02")).toBe(false);
  });

  it("open-ended windows hold from fromPeriod onwards", () => {
    expect(isPeriodHeld({ fromPeriod: "2026-11", untilPeriod: null }, "2027-06")).toBe(true);
    expect(isPeriodHeld({ fromPeriod: "2026-11", untilPeriod: null }, "2026-10")).toBe(false);
  });

  it("invalid periods are never held", () => {
    expect(isPeriodHeld(window, "not-a-period")).toBe(false);
    expect(isPeriodHeld(window, "")).toBe(false);
  });
});

describe("windowsOverlap", () => {
  it("detects containment, crossing, and identity; separates disjoint windows", () => {
    expect(windowsOverlap(
      { fromPeriod: "2026-11", untilPeriod: null },
      { fromPeriod: "2027-05", untilPeriod: "2027-06" },
    )).toBe(true); // open-ended swallows everything after
    expect(windowsOverlap(
      { fromPeriod: "2026-11", untilPeriod: "2027-01" },
      { fromPeriod: "2027-01", untilPeriod: "2027-03" },
    )).toBe(true); // boundary touch counts
    expect(windowsOverlap(
      { fromPeriod: "2026-11", untilPeriod: "2026-12" },
      { fromPeriod: "2027-01", untilPeriod: null },
    )).toBe(false);
  });
});

describe("validateWithholdingWindow", () => {
  it("accepts a well-formed window (open-ended included)", () => {
    expect(validateWithholdingWindow({ fromPeriod: "2026-12", untilPeriod: null }).ok).toBe(true);
    expect(validateWithholdingWindow({ fromPeriod: "2026-12", untilPeriod: "2027-03" }).ok).toBe(true);
  });

  it("refuses malformed periods and inverted windows", () => {
    expect(validateWithholdingWindow({ fromPeriod: "2026-13", untilPeriod: null }).ok).toBe(false);
    expect(validateWithholdingWindow({ fromPeriod: "2026-12", untilPeriod: "2026-11" }).ok).toBe(false);
    expect(validateWithholdingWindow({ fromPeriod: "2026-12", untilPeriod: "nope" }).ok).toBe(false);
  });
});

describe("planWithholdingRelease", () => {
  it("plans one row per money-bearing slip with its frozen net", () => {
    const plan = planWithholdingRelease({
      slips: [
        { id: "ps-1", slipNo: "PS-2026-11-001", period: "2026-11", net: 4_980.75 },
        { id: "ps-2", slipNo: "PS-2026-12-001", period: "2026-12", net: 5_120 },
      ],
      releasePeriod: "2027-02",
    });
    expect(plan.rows).toEqual([
      { payslipId: "ps-1", slipNo: "PS-2026-11-001", period: "2026-11", amount: 4_980.75 },
      { payslipId: "ps-2", slipNo: "PS-2026-12-001", period: "2026-12", amount: 5_120 },
    ]);
    expect(plan.total).toBe(10_100.75);
    expect(plan.zeroNetSlips).toEqual([]);
  });

  it("names zero-net held slips instead of dropping them", () => {
    const plan = planWithholdingRelease({
      slips: [
        { id: "ps-0", slipNo: "PS-2026-11-009", period: "2026-11", net: 0 },
        { id: "ps-1", slipNo: "PS-2026-12-009", period: "2026-12", net: 100 },
      ],
      releasePeriod: "2027-01",
    });
    expect(plan.rows).toHaveLength(1);
    expect(plan.zeroNetSlips).toEqual([{ slipNo: "PS-2026-11-009", period: "2026-11" }]);
    expect(plan.total).toBe(100);
  });

  it("rounds each row once, then the total (stored nets are already 2dp)", () => {
    const plan = planWithholdingRelease({
      slips: [
        { id: "a", slipNo: "A", period: "2026-11", net: 33.335 },
        { id: "b", slipNo: "B", period: "2026-12", net: 33.335 },
      ],
      releasePeriod: "2027-01",
    });
    expect(plan.rows.map((r) => r.amount)).toEqual([33.34, 33.34]); // half-up per row
    expect(plan.total).toBe(66.68);
  });

  it("the label carries its own provenance (slipNo + held period)", () => {
    expect(withholdingReleaseLabel("PS-2026-11-001", "2026-11")).toBe(
      "Withheld salary release — PS-2026-11-001 (2026-11)",
    );
  });
});

// ---------------------------------------------------------------------------
// P10 (PR-B05) — holds against non-monthly run keys. The old string compare
// silently never matched ('W' > '1' lexicographically), so weekly runs could
// never be withheld; these pin the window-based rule.
// ---------------------------------------------------------------------------
describe("isPeriodHeld — cross-cadence (P10)", () => {
  const window = { fromPeriod: "2026-11", untilPeriod: "2026-12" };

  it("holds weekly runs whose windows start inside the hold span", () => {
    expect(isPeriodHeld(window, "2026-W45")).toBe(true); // starts Nov 2
    expect(isPeriodHeld(window, "2026-W49")).toBe(true); // starts Nov 30
    // "Until 2026-12" covers ALL of December, so W50 (Dec 7) is held too.
    expect(isPeriodHeld(window, "2026-W50")).toBe(true);
    expect(isPeriodHeld(window, "2026-W44")).toBe(false); // starts Oct 26
    // 2027-W01 starts Jan 4 — past the hold's December boundary.
    expect(isPeriodHeld(window, "2027-W01")).toBe(false);
  });

  it("holds bimonthly halves, fortnights, days, quarters and years", () => {
    expect(isPeriodHeld(window, "2026-11-A")).toBe(true);
    expect(isPeriodHeld(window, "2026-11-B")).toBe(true);
    expect(isPeriodHeld(window, "2026-12-B")).toBe(true);
    expect(isPeriodHeld(window, "2026-10-B")).toBe(false);
    expect(isPeriodHeld(window, "2026-F24")).toBe(true); // Nov 16 – Nov 29
    expect(isPeriodHeld(window, "2026-F22")).toBe(false); // Oct 19 – Nov 1
    expect(isPeriodHeld(window, "2026-11-30")).toBe(true);
    expect(isPeriodHeld(window, "2026-10-31")).toBe(false);
    // Q4 spans Oct–Dec: its START (Oct 1) is before the hold — not held.
    expect(isPeriodHeld(window, "2026-Q4")).toBe(false);
    // A hold-from of a quarter key works on the run side too.
    expect(isPeriodHeld({ fromPeriod: "2026-Q4", untilPeriod: null }, "2026-W46")).toBe(true);
    expect(isPeriodHeld({ fromPeriod: "2026-Q4", untilPeriod: null }, "2026-W40")).toBe(false);
  });

  it("open-ended holds cover every later window start, any cadence", () => {
    const open = { fromPeriod: "2026-11", untilPeriod: null };
    expect(isPeriodHeld(open, "2027-W10")).toBe(true);
    expect(isPeriodHeld(open, "2026-W45")).toBe(true);
    expect(isPeriodHeld(open, "2026-W44")).toBe(false);
  });

  it("unparseable keys are never held", () => {
    expect(isPeriodHeld(window, "garbage")).toBe(false);
    expect(isPeriodHeld({ fromPeriod: "junk", untilPeriod: null }, "2026-11")).toBe(false);
  });
});

describe("windowsOverlap — cross-cadence (P10)", () => {
  it("monthly windows overlap as before (regression)", () => {
    expect(windowsOverlap({ fromPeriod: "2026-11", untilPeriod: "2026-12" }, { fromPeriod: "2026-12", untilPeriod: null })).toBe(true);
    expect(windowsOverlap({ fromPeriod: "2026-11", untilPeriod: "2026-11" }, { fromPeriod: "2027-01", untilPeriod: null })).toBe(false);
    expect(windowsOverlap({ fromPeriod: "2026-01", untilPeriod: null }, { fromPeriod: "2026-11", untilPeriod: "2026-12" })).toBe(true);
  });

  it("mixed-cadence boundaries compare by window start", () => {
    // A hold from 2026-W45 (starts Nov 2) vs one from 2026-11 (starts Nov 1):
    // the weekly hold starts AFTER the monthly one, so they overlap.
    expect(windowsOverlap({ fromPeriod: "2026-W45", untilPeriod: null }, { fromPeriod: "2026-11", untilPeriod: "2026-12" })).toBe(true);
    // A hold from 2026-F25 (starts Nov 16) does not reach one ending 2026-W46
    // (Nov 15):  Nov 16 > Nov 15 → no overlap.
    expect(windowsOverlap({ fromPeriod: "2026-F25", untilPeriod: null }, { fromPeriod: "2026-W44", untilPeriod: "2026-W46" })).toBe(false);
  });
});
