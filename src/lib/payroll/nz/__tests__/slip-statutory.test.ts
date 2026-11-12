import { describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Phase 2 (engine wiring) — the SLIP kernel tests: taxable-gross derivation
// (component mapping + LOP dock + pre-tax deductions), the system-default
// profile posture, the line builder, the snapshot serializer/parser and the
// auto-enrolment extraction. Pure — the db mock only exists because the
// aggregator module imports the resolver seam.
// ---------------------------------------------------------------------------

const db = vi.hoisted(() => ({
  statutoryRateSet: { findFirst: vi.fn(), findUnique: vi.fn() },
}));

vi.mock("@/lib/db", () => ({ db }));

import {
  classifyComponentsForStatutory,
  parseStatutorySnapshot,
  planSlipStatutory,
  serializeStatutorySnapshot,
  statutoryDeductionLines,
  statutoryTaxableGross,
  systemDefaultTaxProfileRow,
  withoutStatutoryLines,
  type StatutoryComponentRow,
} from "@/lib/payroll/nz/slip-statutory";
import { calculateNzStatutoryWithSet, toNzTaxProfile } from "@/lib/payroll/nz/calculate";
import { NzStatutoryError } from "@/lib/payroll/nz/types";
import { baseProfile, fy2026RateSet, utc } from "./fixtures";
import type { PayslipLine } from "@/lib/payroll-math";

const SET = fy2026RateSet();

/** A recorded M-code permanent profile row (the DB shape). */
function profileRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    taxCode: "M",
    isCasual: false,
    kiwiSaverStatus: "ACTIVE",
    kiwiSaverRate: null,
    employerKiwiSaverRate: null,
    taxCodeSpecialRate: null,
    stcAccTreatment: "INC",
    stcStudentLoanRate: null,
    employmentType: "PERMANENT",
    casualHolidayPayInWages: true,
    employmentStartDate: null,
    esctRateOverride: null,
    ...overrides,
  };
}

const NO_CLASSIFICATION = classifyComponentsForStatutory([]);
const monthlyEnd = utc("2026-11-30");

// ---------------------------------------------------------------------------
// Component classification (Task 3.3 mapping).
// ---------------------------------------------------------------------------

describe("classifyComponentsForStatutory", () => {
  it("keeps plain taxable earning rows out of both exclusion sets", () => {
    const rows: StatutoryComponentRow[] = [
      { code: "basic", taxApplicable: true, statutoryCategory: "TAXABLE_EARNING", wageBaseRef: "GROSS" },
    ];
    const cls = classifyComponentsForStatutory(rows);
    expect(cls.excludedEarnings.has("basic")).toBe(false);
    expect(cls.preTaxDeductions.size).toBe(0);
  });

  it("excludes non-taxable / statistical / wage-base-NONE rows and collects pre-tax deductions", () => {
    const rows: StatutoryComponentRow[] = [
      { code: "reimbursement", taxApplicable: false, statutoryCategory: "NON_TAXABLE", wageBaseRef: "NONE" },
      { code: "headcount", taxApplicable: false, statutoryCategory: "STATISTICAL", wageBaseRef: "NONE" },
      { code: "sacrifice", taxApplicable: true, statutoryCategory: "PRE_TAX_DEDUCTION", wageBaseRef: "GROSS" },
      // Contradictory admin data falls to the EXCLUDED side (never silently taxed).
      { code: "weird", taxApplicable: false, statutoryCategory: "TAXABLE_EARNING", wageBaseRef: "GROSS" },
    ];
    const cls = classifyComponentsForStatutory(rows);
    expect(cls.excludedEarnings.has("reimbursement")).toBe(true);
    expect(cls.excludedEarnings.has("headcount")).toBe(true);
    expect(cls.excludedEarnings.has("weird")).toBe(true);
    expect(cls.preTaxDeductions.has("sacrifice")).toBe(true);
    expect(cls.excludedEarnings.has("sacrifice")).toBe(true); // not a TAXABLE_EARNING
  });
});

// ---------------------------------------------------------------------------
// Taxable gross.
// ---------------------------------------------------------------------------

describe("statutoryTaxableGross", () => {
  const lines = (specs: Array<[string, number]>) =>
    specs.map(([key, amount]) => ({ key, label: key, amount }));

  it("is the plain earnings sum when everything is taxable and nothing docks", () => {
    const earnings = lines([["basic", 6500], ["transport", 200]]);
    expect(statutoryTaxableGross(earnings, [], NO_CLASSIFICATION)).toBe(6700);
  });

  it("subtracts the LOP line (money not received is not taxed)", () => {
    const earnings = lines([["basic", 6500]]);
    const deductions: PayslipLine[] = [
      { key: "lop", label: "Loss of pay (1 day)", amount: 295.45 },
    ];
    expect(statutoryTaxableGross(earnings, deductions, NO_CLASSIFICATION)).toBe(6204.55);
  });

  it("splits the LOP dock proportionally when the basis mixes taxable and non-taxable lines", () => {
    // Payment-day basis: 6000 taxable + 2000 non-taxable = 8000. An LOP
    // line of 800 docks that basis → the taxable share of the dock is
    // 800 × 6000/8000 = 600.
    const earnings: PayslipLine[] = [
      { key: "basic", label: "Basic", amount: 6000 },
      { key: "allowance", label: "Allowance", amount: 2000 },
    ];
    const deductions: PayslipLine[] = [{ key: "lop", label: "LOP", amount: 800 }];
    const cls = classifyComponentsForStatutory([
      { code: "allowance", taxApplicable: false, statutoryCategory: "NON_TAXABLE", wageBaseRef: "NONE" },
    ]);
    // Taxable earnings 6000 − dock 600 = 5400.
    expect(statutoryTaxableGross(earnings, deductions, cls)).toBe(5400);
  });

  it("excludes mapped non-taxable earnings and pre-tax deductions", () => {
    const earnings = lines([["basic", 5000], ["reimbursement", 300]]);
    const deductions: PayslipLine[] = [
      { key: "sacrifice", label: "Salary sacrifice", amount: 200 },
      { key: "union", label: "Union fees", amount: 50 }, // post-tax: no effect
    ];
    const cls = classifyComponentsForStatutory([
      { code: "reimbursement", taxApplicable: false, statutoryCategory: "NON_TAXABLE", wageBaseRef: "NONE" },
      { code: "sacrifice", taxApplicable: true, statutoryCategory: "PRE_TAX_DEDUCTION", wageBaseRef: "GROSS" },
    ]);
    expect(statutoryTaxableGross(earnings, deductions, cls)).toBe(4800);
  });

  it("never counts statistical lines and never goes negative", () => {
    const earnings: PayslipLine[] = [
      { key: "basic", label: "Basic", amount: 100 },
      { key: "headcount", label: "Team size", amount: 12, statistical: true },
    ];
    const deductions: PayslipLine[] = [{ key: "lop", label: "LOP", amount: 500 }];
    expect(statutoryTaxableGross(earnings, deductions, NO_CLASSIFICATION)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// System-default posture + the plan.
// ---------------------------------------------------------------------------

describe("planSlipStatutory", () => {
  it("computes the M-code monthly fixture exactly (PAYE 1301.71 / ACC 113.75 / KS 227.50)", () => {
    const plan = planSlipStatutory({
      userId: "u-1",
      frequency: "MONTHLY",
      payPeriodEnd: monthlyEnd,
      rateSet: SET,
      profileRow: profileRow() as never,
      earnings: [{ key: "basic", label: "Basic Salary", amount: 6500 }],
      deductions: [],
      classification: NO_CLASSIFICATION,
    });
    // Annualised 78,000 → slab tax 15,620.50 ÷ 12 = 1301.71; levy 1.75% of
    // 6,500 = 113.75 (under the per-period cap); KS default 3.5% = 227.50.
    expect(plan.lines).toEqual([
      { key: "paye", label: "PAYE income tax (M)", amount: 1301.71 },
      { key: "acc", label: "ACC earners' levy", amount: 113.75 },
      { key: "ks", label: "KiwiSaver employee 3.5%", amount: 227.5 },
    ]);
    expect(plan.snapshot.taxableGross).toBe(6500);
    expect(plan.snapshot.statutoryNet).toBe(4857.04);
    expect(plan.snapshot.kiwiSaver.employerGross).toBe(227.5);
    expect(plan.snapshot.kiwiSaver.esct).toBe(68.25); // 30% band on (6500+227.5)×12 = 80,730
    expect(plan.snapshot.defaultedProfile).toBe(false);
    expect(plan.autoEnrol).toBeNull(); // PERMANENT: enrolled at hire, no time rule
  });

  it("falls back to the system-default posture (M / ACTIVE / PERMANENT) and flags it", () => {
    const plan = planSlipStatutory({
      userId: "u-2",
      frequency: "MONTHLY",
      payPeriodEnd: monthlyEnd,
      rateSet: SET,
      profileRow: null,
      earnings: [{ key: "basic", label: "Basic Salary", amount: 6500 }],
      deductions: [],
      classification: NO_CLASSIFICATION,
    });
    expect(plan.snapshot.defaultedProfile).toBe(true);
    expect(plan.snapshot.taxCode).toBe("M");
    // Same numbers as the recorded identical profile.
    expect(plan.lines.map((l) => l.key)).toEqual(["paye", "acc", "ks"]);
    expect(systemDefaultTaxProfileRow().taxCode).toBe("M");
  });

  it("extracts the 28-day TEMPORARY auto-enrolment with the default rate", () => {
    const plan = planSlipStatutory({
      userId: "u-3",
      frequency: "MONTHLY",
      payPeriodEnd: monthlyEnd,
      rateSet: SET,
      profileRow: profileRow({
        employmentType: "TEMPORARY",
        employmentStartDate: utc("2026-09-01"), // day 29 = 2026-09-29, long past
      }) as never,
      earnings: [{ key: "basic", label: "Basic Salary", amount: 6500 }],
      deductions: [],
      classification: NO_CLASSIFICATION,
    });
    expect(plan.autoEnrol).not.toBeNull();
    expect(plan.autoEnrol!.rate).toBe(0.035);
    expect(plan.autoEnrol!.reason).toContain("28 days");
    expect(plan.snapshot.kiwiSaver.autoEnrolTriggered).toBe(true);
    // The ks line still prices at the default (the election IS the default).
    expect(plan.lines.find((l) => l.key === "ks")?.amount).toBe(227.5);
  });

  it("propagates engine guardrail failures (STC without certificate rate)", () => {
    expect(() =>
      planSlipStatutory({
        userId: "u-4",
        frequency: "MONTHLY",
        payPeriodEnd: monthlyEnd,
        rateSet: SET,
        profileRow: profileRow({ taxCode: "STC" }) as never,
        earnings: [{ key: "basic", label: "Basic Salary", amount: 6500 }],
        deductions: [],
        classification: NO_CLASSIFICATION,
      }),
    ).toThrow(NzStatutoryError);
  });

  it("omits zero lines (casual SB with no KiwiSaver → paye + acc only)", () => {
    const plan = planSlipStatutory({
      userId: "u-5",
      frequency: "MONTHLY",
      payPeriodEnd: monthlyEnd,
      rateSet: SET,
      profileRow: profileRow({
        taxCode: "SB",
        kiwiSaverStatus: "NOT_ENROLLED",
        employmentType: "CASUAL",
        casualHolidayPayInWages: true,
      }) as never,
      earnings: [{ key: "basic", label: "Shift pay", amount: 1000 }],
      deductions: [],
      classification: NO_CLASSIFICATION,
    });
    // SB flat 10.5% of 1000 = 105; levy 17.50; no KS (casual exemption), no SL.
    expect(plan.lines).toEqual([
      { key: "paye", label: "PAYE income tax (SB)", amount: 105 },
      { key: "acc", label: "ACC earners' levy", amount: 17.5 },
    ]);
  });

  it("prices the taxable gross, not the raw gross (LOP + non-taxable mapping)", () => {
    const cls = classifyComponentsForStatutory([
      { code: "reimbursement", taxApplicable: false, statutoryCategory: "NON_TAXABLE", wageBaseRef: "NONE" },
    ]);
    const plan = planSlipStatutory({
      userId: "u-6",
      frequency: "MONTHLY",
      payPeriodEnd: monthlyEnd,
      rateSet: SET,
      profileRow: profileRow() as never,
      earnings: [
        { key: "basic", label: "Basic Salary", amount: 6500 },
        // A window-exempt reimbursement: non-taxable AND never docked, so
        // the whole LOP dock falls on the taxable basic.
        { key: "reimbursement", label: "Travel reimbursement", amount: 400, dependsOnPaymentDays: false },
      ],
      deductions: [{ key: "lop", label: "Loss of pay (2 days)", amount: 590.91 }],
      classification: cls,
    });
    // Taxable = 6500 − 590.91 (the docked basis is entirely the taxable
    // basic) = 5909.09; the reimbursement never entered a wage base.
    expect(plan.snapshot.taxableGross).toBe(5909.09);
  });
});

// ---------------------------------------------------------------------------
// Line builder, serializer, parser, stripper.
// ---------------------------------------------------------------------------

describe("statutoryDeductionLines + serializeStatutorySnapshot + parseStatutorySnapshot", () => {
  it("round-trips a result through serialize → parse", () => {
    const result = calculateNzStatutoryWithSet({
      gross: 6500,
      frequency: "MONTHLY",
      taxProfile: { ...baseProfile(), kiwiSaverRate: 0.04 },
      payPeriodEnd: monthlyEnd,
      rateSet: SET,
    });
    const snap = serializeStatutorySnapshot(result, { defaultedProfile: false });
    expect(snap.ruleVersion).toBe(result.ruleVersion);
    expect(snap.rateSetLabel).toBe(SET.label);
    const parsed = parseStatutorySnapshot(JSON.parse(JSON.stringify(snap)));
    expect(parsed).toEqual(snap);
  });

  it("parses defensively: null / garbage / partial shapes → null", () => {
    expect(parseStatutorySnapshot(null)).toBeNull();
    expect(parseStatutorySnapshot("nope")).toBeNull();
    expect(parseStatutorySnapshot({ taxCode: "M" })).toBeNull();
    expect(parseStatutorySnapshot({ taxCode: "M", rateSetId: "x", rateSetLabel: "y", paye: {}, kiwiSaver: {}, studentLoan: 0 })).toBeNull();
  });

  it("clamps a negative PAYE line at zero and omits it when empty (snapshot keeps the truth)", () => {
    const lines = statutoryDeductionLines({
      gross: 100,
      frequency: "MONTHLY",
      payPeriodEnd: monthlyEnd,
      paye: { tax: -12, acc: 0, total: -12, method: "ME", ietc: 43.33, annualised: 1200 },
      kiwisaver: {
        status: "NOT_ENROLLED", autoEnrolTriggered: false, reason: "r",
        employee: 0, employerGross: 0, esct: 0, employerNet: 0,
        employeeRate: 0, employerRate: 0, esctRate: 0,
      },
      studentLoan: 0,
      netPay: 112,
      taxCodeApplied: "ME",
      rateSet: { id: "s", label: "l" },
      ruleVersion: "nz1:0",
    });
    expect(lines).toEqual([]);
  });

  it("strips auto-managed statutory keys from submitted deduction sets", () => {
    const out = withoutStatutoryLines([
      { key: "paye", label: "PAYE", amount: 100 },
      { key: "union", label: "Union fees", amount: 10 },
      { key: "ks", label: "KiwiSaver", amount: 30 },
      { key: "acc", label: "ACC", amount: 5 },
      { key: "sl", label: "SL", amount: 15 },
    ]);
    expect(out).toEqual([{ key: "union", label: "Union fees", amount: 10 }]);
  });
});

// ---------------------------------------------------------------------------
// Cross-check: the adapter + engine see the same profile the plan used.
// ---------------------------------------------------------------------------

describe("toNzTaxProfile (kernel integration)", () => {
  it("prefers the row's employment facts over the call-site fallback", () => {
    const p = toNzTaxProfile(
      profileRow({ employmentType: "CASUAL", casualHolidayPayInWages: false }) as never,
      { employmentCategory: "PERMANENT", casualHolidayPayInWages: true },
    );
    expect(p.employmentCategory).toBe("CASUAL");
    expect(p.casualHolidayPayInWages).toBe(false);
  });
});
