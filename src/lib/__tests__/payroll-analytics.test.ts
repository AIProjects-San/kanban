import { describe, expect, it } from "vitest";

import {
  buildBenefitClaimsSeries,
  buildOutgoingSalarySeries,
  buildPayrollAnalytics,
  buildPayrollCards,
  buildSalaryByDimension,
  latestPaidMonth,
  monthLabelOf,
  type AnalyticsClaim,
  type AnalyticsSlip,
} from "@/lib/payroll-analytics";

const ms = (s: string) => new Date(`${s}T00:00:00.000Z`).getTime();

function slip(over: Partial<AnalyticsSlip> & Pick<AnalyticsSlip, "userId">): AnalyticsSlip {
  return {
    gross: 100,
    net: 90,
    withholdStatus: "",
    department: "ENGINEERING",
    jobTitle: "Engineer",
    windowEndMs: ms("2026-11-30"),
    ...over,
  };
}

function claim(over: Partial<AnalyticsClaim> = {}): AnalyticsClaim {
  return { amount: 200, windowEndMs: ms("2026-11-15"), ...over };
}

describe("buildOutgoingSalarySeries (P22 / PR-C01)", () => {
  it("buckets by the run's window-END month across mixed cadences", () => {
    const series = buildOutgoingSalarySeries([
      slip({ userId: "a", windowEndMs: ms("2026-10-31") }), // monthly Oct
      slip({ userId: "b", windowEndMs: ms("2026-11-08") }), // a weekly run ENDING in Nov
      slip({ userId: "c", windowEndMs: ms("2026-11-30") }), // the monthly Nov run
    ]);
    // Weekly + monthly November windows sum into ONE November bucket.
    expect(series.map((m) => m.monthKey)).toEqual(["2026-10", "2026-11"]);
    expect(series[1].net).toBe(180);
    expect(series[1].gross).toBe(200);
    expect(series[1].label).toBe("Nov 2026");
  });

  it("never counts WITHHELD or RELEASED nets — held money is not outgoing", () => {
    const series = buildOutgoingSalarySeries([
      slip({ userId: "a", net: 90, windowEndMs: ms("2026-10-31") }),
      slip({ userId: "b", net: 90, withholdStatus: "WITHHELD", windowEndMs: ms("2026-10-31") }),
      slip({ userId: "c", net: 90, withholdStatus: "RELEASED", windowEndMs: ms("2026-10-31") }),
    ]);
    expect(series).toHaveLength(1);
    expect(series[0].net).toBe(90);
  });

  it("keeps only the trailing N buckets (sparse history is not zero-padded)", () => {
    const slips = [1, 2, 3, 4].map((i) =>
      slip({ userId: `u${i}`, windowEndMs: ms(`2026-0${i}-28`) }),
    );
    expect(buildOutgoingSalarySeries(slips, 2).map((m) => m.monthKey)).toEqual(["2026-03", "2026-04"]);
    expect(buildOutgoingSalarySeries(slips).map((m) => m.monthKey)).toHaveLength(4);
  });

  it("returns [] on empty input and drops unknown window ends", () => {
    expect(buildOutgoingSalarySeries([])).toEqual([]);
    expect(buildOutgoingSalarySeries([slip({ userId: "x", windowEndMs: 0 })])).toEqual([]);
  });
});

describe("latestPaidMonth + buildSalaryByDimension (P22 / PR-C02, PR-C03)", () => {
  it("slices the LATEST PAID month only, grouped by dimension, largest first", () => {
    const slips = [
      slip({ userId: "a", gross: 100, department: "ENGINEERING", jobTitle: "Engineer", windowEndMs: ms("2026-10-31") }),
      slip({ userId: "b", gross: 300, department: "DESIGN", jobTitle: "Designer", windowEndMs: ms("2026-11-30") }),
      slip({ userId: "c", gross: 200, department: "DESIGN", jobTitle: "Designer", windowEndMs: ms("2026-11-30") }),
      // The next month already exists (a weekly run ending Dec 1) — it wins.
      slip({ userId: "d", gross: 50, department: "ENGINEERING", jobTitle: "Engineer", windowEndMs: ms("2026-12-01") }),
    ];
    expect(latestPaidMonth(slips)).toBe("2026-12");
    const rows = buildSalaryByDimension(slips, "department", "2026-12");
    // Only the Dec-1-ending slip is in the anchor month.
    expect(rows).toEqual([{ label: "ENGINEERING", amount: 50, slipCount: 1 }]);

    // Explicit anchor for the benchmark's "last month" shape:
    const novRows = buildSalaryByDimension(slips, "department", "2026-11");
    expect(novRows.map((r) => [r.label, r.amount, r.slipCount])).toEqual([
      ["DESIGN", 500, 2],
    ]);
  });

  it("folds missing dimensions into the honest bucket and sorts deterministically", () => {
    const rows = buildSalaryByDimension(
      [
        slip({ userId: "a", gross: 100, department: "", jobTitle: "", windowEndMs: ms("2026-11-30") }),
        slip({ userId: "b", gross: 100, department: "ENGINEERING", jobTitle: "Engineer", windowEndMs: ms("2026-11-30") }),
      ],
      "department",
      "2026-11",
    );
    // Same amount: the alphabetical tiebreak decides.
    expect(rows.map((r) => r.label)).toEqual(["ENGINEERING", "No department"]);
    const titleRows = buildSalaryByDimension(
      [
        slip({ userId: "a", gross: 100, department: "", jobTitle: "", windowEndMs: ms("2026-11-30") }),
      ],
      "jobTitle",
      "2026-11",
    );
    expect(titleRows.map((r) => r.label)).toEqual(["No job title"]);
  });

  it("returns [] when nothing is paid yet", () => {
    expect(latestPaidMonth([])).toBeNull();
    expect(buildSalaryByDimension([], "department", null)).toEqual([]);
  });
});

describe("buildBenefitClaimsSeries (P22 / PR-C04)", () => {
  it("buckets claimed magnitude + count per month, trailing window", () => {
    const series = buildBenefitClaimsSeries([
      claim({ amount: 200, windowEndMs: ms("2026-10-20") }),
      claim({ amount: 100, windowEndMs: ms("2026-11-05") }),
      claim({ amount: 50, windowEndMs: ms("2026-11-25") }),
    ]);
    expect(series).toEqual([
      { monthKey: "2026-10", label: "Oct 2026", amount: 200, count: 1 },
      { monthKey: "2026-11", label: "Nov 2026", amount: 150, count: 2 },
    ]);
    expect(buildBenefitClaimsSeries([claim({ windowEndMs: ms("2026-01-01") }), claim()], 1)).toHaveLength(1);
  });
});

describe("buildPayrollCards (P22 / PR-N01–06)", () => {
  it("derives every card from the built series + the caller's counts", () => {
    const cards = buildPayrollCards({
      outgoing: [
        { monthKey: "2026-10", label: "Oct 2026", net: 90, gross: 100 },
        { monthKey: "2026-11", label: "Nov 2026", net: 90, gross: 100 },
      ],
      activeStructures: 3,
      claims: [claim(), claim({ amount: 50 })],
      incentives: [{ amount: 500 }, { amount: 250 }],
    });
    expect(cards).toEqual({
      totalOutgoingSalary: 180,
      outgoingSalaryMonths: 2,
      totalSalaryStructures: 3,
      benefitClaimsTotal: 250,
      benefitClaimsCount: 2,
      incentiveTotal: 750,
      incentiveCount: 2,
      statutoryDeclined: true,
    });
  });

  it("the statutory marker is always true (the two ADR-014 cards render '—')", () => {
    const cards = buildPayrollCards({ outgoing: [], activeStructures: 0, claims: [], incentives: [] });
    expect(cards.statutoryDeclined).toBe(true);
    expect(cards.totalOutgoingSalary).toBe(0);
    expect(cards.outgoingSalaryMonths).toBe(0);
  });
});

describe("buildPayrollAnalytics (the composer)", () => {
  it("wires every surface off ONE payload — series, both slices, cards agree", () => {
    const payload = buildPayrollAnalytics({
      slips: [
        slip({ userId: "a", gross: 300, net: 270, department: "DESIGN", jobTitle: "Designer", windowEndMs: ms("2026-11-30") }),
        slip({ userId: "b", gross: 100, net: 90, department: "ENGINEERING", jobTitle: "Engineer", windowEndMs: ms("2026-11-30") }),
      ],
      claims: [claim({ amount: 120, windowEndMs: ms("2026-11-10") })],
      incentives: [{ amount: 400 }],
      activeStructures: 2,
    });
    expect(payload.outgoing).toHaveLength(1);
    expect(payload.outgoing[0].net).toBe(360);
    expect(payload.departmentSalary.rows.map((r) => r.label)).toEqual(["DESIGN", "ENGINEERING"]);
    expect(payload.departmentSalary.total).toBe(400);
    expect(payload.designationSalary.rows.map((r) => r.label)).toEqual(["Designer", "Engineer"]);
    expect(payload.benefitClaims[0].amount).toBe(120);
    // The card and the chart agree by construction (same series).
    expect(payload.cards.totalOutgoingSalary).toBe(payload.outgoing.reduce((s, m) => s + m.net, 0));
    expect(payload.cards.totalSalaryStructures).toBe(2);
    expect(payload.cards.incentiveTotal).toBe(400);
  });

  it("empty workspace: honest zeros, null anchor month, empty charts", () => {
    const payload = buildPayrollAnalytics({ slips: [], claims: [], incentives: [], activeStructures: 0 });
    expect(payload.outgoing).toEqual([]);
    expect(payload.departmentSalary).toEqual({ anchorMonth: null, rows: [], total: 0 });
    expect(payload.designationSalary).toEqual({ anchorMonth: null, rows: [], total: 0 });
    expect(payload.benefitClaims).toEqual([]);
    expect(payload.cards.outgoingSalaryMonths).toBe(0);
  });
});

describe("monthLabelOf", () => {
  it("formats keys and falls back to the raw string on garbage", () => {
    expect(monthLabelOf("2026-01")).toBe("Jan 2026");
    expect(monthLabelOf("2026-11")).toBe("Nov 2026");
    expect(monthLabelOf("nonsense")).toBe("nonsense");
    expect(monthLabelOf("2026-99")).toBe("2026-99");
  });
});
