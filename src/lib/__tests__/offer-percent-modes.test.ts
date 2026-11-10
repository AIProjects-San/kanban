import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// P23 (PR-02/PR-03) — the catalog percent modes (docs/Fernly_HR_Payroll_
// Enhancement_Plan.md §7.2.2): PERCENT_OF_GROSS resolves annually in
// computeOffer (the same two-pass ordering the adjustment adapter documents
// — earnings before non-earnings, sequential growth, no iteration);
// PERCENT_OF_NET resolves ONLY at payroll time through the adapter kernel
// (structureNetDeductionRows → applyAdjustments pass 2, sequential on the
// docked running net). One kernel discipline, both surfaces.
// ---------------------------------------------------------------------------

import {
  basicKeyOf,
  computeOffer,
  parseComponents,
  type OfferComponent,
} from "@/lib/offer-math";
import {
  windowDeductionsFromStructure,
  windowEarningsFromStructure,
  withLopLine,
  lopBasisGross,
  lineSum,
} from "@/lib/payroll-math";
import {
  applyAdjustments,
  structureNetDeductionRows,
  type PayAdjustmentRow,
} from "@/lib/pay-adjustment";
import { solveBaseForCtc } from "@/lib/ctc-solver";

function fixedRow(p: Partial<PayAdjustmentRow>): PayAdjustmentRow {
  return {
    id: "adj-1", userId: "u-1", sourceType: "MANUAL", sourceId: "",
    componentCode: "", label: "Bonus", side: "EARNING", recurrence: "ONE_SHOT",
    calcMode: "FIXED", percent: null, amount: 100, period: "2026-11",
    endPeriod: null, lastConsumedPeriod: "", status: "PENDING", skipReason: "", note: "",
    ...p,
  };
}

describe("P23 — computeOffer: PERCENT_OF_GROSS (annual resolution)", () => {
  const P_GROSS_SET: OfferComponent[] = [
    { key: "basic", label: "Basic Salary", kind: "EARNING", mode: "FIXED", amount: 66_000 },
    { key: "variable_pay", label: "Variable Pay", kind: "EARNING", mode: "PERCENT_OF_GROSS", amount: 8 },
    { key: "adv", label: "Advance Recovery", kind: "DEDUCTION", mode: "PERCENT_OF_GROSS", amount: 5 },
    { key: "admin_fee", label: "Admin Fee", kind: "DEDUCTION", mode: "PERCENT_OF_GROSS", amount: 2 },
  ];

  it("a percent-of-gross earning sees the earnings resolved before it (sequential, no iteration)", () => {
    const t = computeOffer(P_GROSS_SET);
    // earnings: 66,000 basic → variable_pay = 8% × 66,000 = 5,280.
    expect(t.resolved.variable_pay).toBe(5_280);
    expect(t.earnings).toBe(71_280);
  });

  it("a percent-of-gross DEDUCTION sees the FULL gross (incl. percent-of-gross earnings)", () => {
    const t = computeOffer(P_GROSS_SET);
    // adv = 5% × 71,280 = 3,564; admin_fee = 2% × 71,280 = 1,425.60.
    expect(t.resolved.adv).toBe(3_564);
    expect(t.resolved.admin_fee).toBe(1_425.6);
    expect(t.deductions).toBe(4_989.6);
    expect(t.net).toBe(66_290.4);
  });

  it("two percent-of-gross earnings chain: the second sees the first (the adapter's documented order)", () => {
    const t = computeOffer([
      { key: "basic", label: "Basic", kind: "EARNING", mode: "FIXED", amount: 100_000 },
      { key: "vp1", label: "VP 10%", kind: "EARNING", mode: "PERCENT_OF_GROSS", amount: 10 },
      { key: "vp2", label: "VP 10% again", kind: "EARNING", mode: "PERCENT_OF_GROSS", amount: 10 },
    ]);
    // vp1 = 10% × 100,000 = 10,000; vp2 = 10% × 110,000 = 11,000.
    expect(t.resolved.vp1).toBe(10_000);
    expect(t.resolved.vp2).toBe(11_000);
    expect(t.earnings).toBe(121_000);
  });

  it("a percent-of-gross employer contribution rides the employer bucket / CTC", () => {
    const t = computeOffer([
      { key: "basic", label: "Basic", kind: "EARNING", mode: "FIXED", amount: 50_000 },
      { key: "pension", label: "Pension", kind: "EMPLOYER_CONTRIBUTION", mode: "PERCENT_OF_GROSS", amount: 4 },
    ]);
    expect(t.resolved.pension).toBe(2_000);
    expect(t.employerContributions).toBe(2_000);
    expect(t.ctc).toBe(52_000);
    expect(t.net).toBe(50_000);
  });

  it("a percent-of-gross STATISTICAL line resolves for display and counts nowhere", () => {
    const t = computeOffer([
      { key: "basic", label: "Basic", kind: "EARNING", mode: "FIXED", amount: 40_000 },
      { key: "pkg", label: "Package Total", kind: "STATISTICAL", mode: "PERCENT_OF_GROSS", amount: 110 },
    ]);
    expect(t.resolved.pkg).toBe(44_000);
    expect(t.earnings).toBe(40_000);
    expect(t.deductions).toBe(0);
    expect(t.ctc).toBe(40_000);
  });

  it("percent-of-gross never anchors the basic", () => {
    expect(basicKeyOf([
      { key: "basic", label: "Basic", kind: "EARNING", mode: "PERCENT_OF_GROSS", amount: 10 },
      { key: "x", label: "X", kind: "EARNING", mode: "FIXED", amount: 1 },
    ])).toBe("basic"); // the explicit key still anchors (historical rule)
    // but with no explicit basic, the first FIXED earning wins:
    expect(basicKeyOf([
      { key: "pg", label: "PG", kind: "EARNING", mode: "PERCENT_OF_GROSS", amount: 10 },
      { key: "x", label: "X", kind: "EARNING", mode: "FIXED", amount: 1 },
    ])).toBe("x");
  });

  it("re-ordering the loop is value-identical for pre-P23 component sets (byte-identical totals)", () => {
    const LEGACY: OfferComponent[] = [
      { key: "kiwisaver", label: "KiwiSaver 3%", kind: "EMPLOYER_CONTRIBUTION", mode: "PERCENT_OF_BASIC", amount: 3 },
      { key: "basic", label: "Basic Salary", kind: "EARNING", mode: "FIXED", amount: 80_000 },
      { key: "student_loan", label: "Loan", kind: "DEDUCTION", mode: "FIXED", amount: 2_000 },
      { key: "housing", label: "Housing", kind: "EARNING", mode: "FIXED", amount: 12_000 },
    ];
    const t = computeOffer(LEGACY);
    expect(t.resolved.kiwisaver).toBe(2_400);
    expect(t.earnings).toBe(92_000);
    expect(t.deductions).toBe(2_000);
    expect(t.ctc).toBe(94_400);
    expect(t.net).toBe(90_000);
  });
});

describe("P23 — computeOffer: PERCENT_OF_NET (payroll-time only)", () => {
  it("resolves to 0 in the annual totals and rides `unresolved`", () => {
    const t = computeOffer([
      { key: "basic", label: "Basic", kind: "EARNING", mode: "FIXED", amount: 60_000 },
      { key: "advance", label: "Advance Recovery", kind: "DEDUCTION", mode: "PERCENT_OF_NET", amount: 6 },
    ]);
    expect(t.resolved.advance).toBe(0);
    expect(t.unresolved).toEqual(["advance"]);
    expect(t.deductions).toBe(0);
    expect(t.net).toBe(60_000);
  });

  it("a foreign non-deduction percent-of-net line is still honest: 0 + unresolved, never money", () => {
    const t = computeOffer([
      { key: "basic", label: "Basic", kind: "EARNING", mode: "FIXED", amount: 60_000 },
      { key: "weird", label: "Weird", kind: "EARNING", mode: "PERCENT_OF_NET", amount: 6 },
    ]);
    expect(t.resolved.weird).toBe(0);
    expect(t.unresolved).toEqual(["weird"]);
    expect(t.earnings).toBe(60_000);
  });

  it("parseComponents keeps the new modes (a stored P-GROSS/P-NET line never vanishes on read)", () => {
    const json = JSON.stringify([
      { key: "basic", label: "Basic", kind: "EARNING", mode: "FIXED", amount: 1 },
      { key: "vp", label: "VP", kind: "EARNING", mode: "PERCENT_OF_GROSS", amount: 8 },
      { key: "adv", label: "Adv", kind: "DEDUCTION", mode: "PERCENT_OF_NET", amount: 6 },
    ]);
    expect(parseComponents(json)).toHaveLength(3);
    // garbage modes still drop:
    expect(parseComponents('[{"key":"x","label":"X","kind":"EARNING","mode":"MYSTERY","amount":1}]')).toEqual([]);
  });
});

describe("P23 — windowDeductionsFromStructure (the per-window flat deductions)", () => {
  const STRUCTURE: OfferComponent[] = [
    { key: "basic", label: "Basic", kind: "EARNING", mode: "FIXED", amount: 66_000 },
    { key: "variable_pay", label: "Variable Pay", kind: "EARNING", mode: "PERCENT_OF_GROSS", amount: 8 },
    { key: "student_loan", label: "Student Loan", kind: "DEDUCTION", mode: "FIXED", amount: 2_400 },
    { key: "union_dues", label: "Union Dues", kind: "DEDUCTION", mode: "PERCENT_OF_GROSS", amount: 1 },
    { key: "advance_recovery", label: "Advance Recovery", kind: "DEDUCTION", mode: "PERCENT_OF_NET", amount: 6 },
  ];

  it("FIXED + percent-of-gross deductions resolve annually ÷ the cadence's windows (MONTHLY = ÷12)", () => {
    const lines = windowDeductionsFromStructure(STRUCTURE, "MONTHLY", 2026);
    expect(lines.map((l) => l.key)).toEqual(["student_loan", "union_dues"]);
    // earnings = 66,000 + 5,280 = 71,280 → union_dues = 1% = 712.80/yr → 59.40/mo.
    expect(lines.find((l) => l.key === "student_loan")?.amount).toBe(200);
    expect(lines.find((l) => l.key === "union_dues")?.amount).toBe(59.4);
  });

  it("weekly cadence divides by the year's windows (53 for the 2026 ISO year — the P10 rule)", () => {
    const lines = windowDeductionsFromStructure(STRUCTURE, "WEEKLY", 2026);
    expect(lines.find((l) => l.key === "student_loan")?.amount).toBe(Math.round((2_400 / 53) * 100) / 100);
  });

  it("percent-of-net lines are excluded — they ride the adapter kernel instead", () => {
    const lines = windowDeductionsFromStructure(STRUCTURE, "MONTHLY", 2026);
    expect(lines.some((l) => l.key === "advance_recovery")).toBe(false);
  });

  it("earnings stay earnings (the earnings helper is untouched by deduction lines)", () => {
    const earnings = windowEarningsFromStructure(STRUCTURE, "MONTHLY", 2026);
    expect(earnings.map((l) => l.key)).toEqual(["basic", "variable_pay"]);
    expect(earnings.find((l) => l.key === "variable_pay")?.amount).toBe(440);
  });

  it("a pre-P23 structure (no deduction lines) yields an EMPTY deduction set (byte-identical slips)", () => {
    const lines = windowDeductionsFromStructure([
      { key: "basic", label: "Basic", kind: "EARNING", mode: "FIXED", amount: 78_000 },
      { key: "kiwisaver", label: "KiwiSaver", kind: "EMPLOYER_CONTRIBUTION", mode: "PERCENT_OF_BASIC", amount: 3 },
    ], "MONTHLY", 2026);
    expect(lines).toEqual([]);
  });
});

describe("P23 — structureNetDeductionRows + applyAdjustments (one kernel, both surfaces)", () => {
  const STRUCTURE: OfferComponent[] = [
    { key: "basic", label: "Basic", kind: "EARNING", mode: "FIXED", amount: 66_000 },
    { key: "advance_recovery", label: "Advance Recovery", kind: "DEDUCTION", mode: "PERCENT_OF_NET", amount: 6 },
    { key: "garnish", label: "Garnishment", kind: "DEDUCTION", mode: "PERCENT_OF_NET", amount: 10 },
  ];

  it("maps the structure's percent-of-net lines to adapter-shaped synthetic rows", () => {
    const rows = structureNetDeductionRows(STRUCTURE);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      id: "struct:advance_recovery", componentCode: "advance_recovery",
      side: "DEDUCTION", calcMode: "PERCENT_OF_NET", percent: 6, label: "Advance Recovery",
    });
    expect(rows[1]).toMatchObject({ id: "struct:garnish", percent: 10 });
    // non-percent-of-net lines never ride:
    expect(structureNetDeductionRows([{ key: "basic", label: "Basic", kind: "EARNING", mode: "FIXED", amount: 1 }])).toEqual([]);
  });

  it("pass 2 resolves the synthetic rows sequentially on the docked running net (post LOP)", () => {
    // monthly earnings 5,500 (66,000 ÷ 12); 1 day LOP on a 22-day month:
    // LOP = 5,500 × 1/22 = 250 → base deductions = [lop].
    const earnings = windowEarningsFromStructure(STRUCTURE, "MONTHLY", 2026);
    const baseDeductions = withLopLine([], lopBasisGross(earnings), 1, "2026-11", 22);
    const applied = applyAdjustments(
      { earnings, deductions: baseDeductions },
      structureNetDeductionRows(STRUCTURE),
      "2026-11",
    );
    // running net = 5,500 − 250 = 5,250 → advance = 6% = 315; net 4,935 →
    // garnish = 10% = 493.50.
    expect(applied.deductions.find((l) => l.key === "advance_recovery")?.amount).toBe(315);
    expect(applied.deductions.find((l) => l.key === "garnish")?.amount).toBe(493.5);
    expect(lineSum(applied.deductions)).toBe(250 + 315 + 493.5);
    // the synthetic ids ride consumed (the CALLER filters them):
    expect(applied.consumed.map((c) => c.id)).toEqual(["struct:advance_recovery", "struct:garnish"]);
  });

  it("structure percent-of-net lines resolve BEFORE the period's adapter percent-of-net rows", () => {
    const earnings = [{ key: "basic", label: "Basic", amount: 5_000 }];
    const adapterNetRow = fixedRow({
      id: "adj-net", componentCode: "advance_recovery", label: "Advance Recovery",
      side: "DEDUCTION", calcMode: "PERCENT_OF_NET", percent: 50, amount: 0,
    });
    const structRows = structureNetDeductionRows([
      { key: "basic", label: "Basic", kind: "EARNING", mode: "FIXED", amount: 60_000 },
      { key: "advance_recovery", label: "Advance Recovery", kind: "DEDUCTION", mode: "PERCENT_OF_NET", amount: 10 },
    ]);
    const applied = applyAdjustments({ earnings, deductions: [] }, [...structRows, adapterNetRow], "2026-11");
    // struct first: 10% × 5,000 = 500 → net 4,500; adapter row: 50% × 4,500
    // = 2,250 → but it MERGES under the shared componentCode "advance_recovery".
    const merged = applied.deductions.find((l) => l.key === "advance_recovery");
    expect(merged?.amount).toBe(2_750);
  });

  it("flat structure deductions ride the base BEFORE percent-of-net sees the net", () => {
    const STRUCTURE2: OfferComponent[] = [
      { key: "basic", label: "Basic", kind: "EARNING", mode: "FIXED", amount: 60_000 },
      { key: "student_loan", label: "Student Loan", kind: "DEDUCTION", mode: "FIXED", amount: 1_200 },
      { key: "advance_recovery", label: "Advance Recovery", kind: "DEDUCTION", mode: "PERCENT_OF_NET", amount: 10 },
    ];
    const earnings = windowEarningsFromStructure(STRUCTURE2, "MONTHLY", 2026); // basic 5,000/mo
    const flat = windowDeductionsFromStructure(STRUCTURE2, "MONTHLY", 2026); // loan 100/mo
    const applied = applyAdjustments({ earnings, deductions: flat }, structureNetDeductionRows(STRUCTURE2), "2026-11");
    // running net = 5,000 − 100 = 4,900 → advance = 490.
    expect(applied.deductions.find((l) => l.key === "advance_recovery")?.amount).toBe(490);
  });

  it("an invalid synthetic percent is skipped with a reason (defensive; save-time validation prevents it)", () => {
    const bad = structureNetDeductionRows([
      { key: "basic", label: "Basic", kind: "EARNING", mode: "FIXED", amount: 60_000 },
      { key: "bad", label: "Bad", kind: "DEDUCTION", mode: "PERCENT_OF_NET", amount: 0 },
    ]);
    const applied = applyAdjustments({ earnings: [{ key: "basic", label: "Basic", amount: 5_000 }], deductions: [] }, bad, "2026-11");
    expect(applied.skipped.map((s) => s.id)).toEqual(["struct:bad"]);
    expect(applied.deductions).toEqual([]);
  });
});

describe("P23 — solveBaseForCtc refuses non-linear percent-of-gross bases", () => {
  it("refuses when a percent-of-gross earning/employer line is present", () => {
    const res = solveBaseForCtc({
      components: [
        { key: "basic", label: "Basic", kind: "EARNING", mode: "FIXED", amount: 60_000 },
        { key: "vp", label: "VP", kind: "EARNING", mode: "PERCENT_OF_GROSS", amount: 8 },
      ],
      targetCtc: 70_000,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("non-linear");
  });

  it("still solves percent-of-BASIC sets (the linear world, unchanged)", () => {
    const res = solveBaseForCtc({
      components: [
        { key: "basic", label: "Basic", kind: "EARNING", mode: "FIXED", amount: 60_000 },
        { key: "kiwisaver", label: "KiwiSaver", kind: "EMPLOYER_CONTRIBUTION", mode: "PERCENT_OF_BASIC", amount: 3 },
      ],
      targetCtc: 100_000,
    });
    expect(res.ok).toBe(true);
    expect(res.base).toBe(97_087);
  });

  it("percent-of-NET deductions never bend the solution (deductions never count into CTC)", () => {
    const res = solveBaseForCtc({
      components: [
        { key: "basic", label: "Basic", kind: "EARNING", mode: "FIXED", amount: 60_000 },
        { key: "advance", label: "Advance", kind: "DEDUCTION", mode: "PERCENT_OF_NET", amount: 6 },
      ],
      targetCtc: 60_000,
    });
    expect(res.ok).toBe(true);
    expect(res.base).toBe(60_000);
  });
});
