import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Task 1.4 (revised) — aggregator tests: the pure core end-to-end, the
// rule-version hash, the EmployeeTaxProfile row adapter and the DB
// rate-set resolver (mocked — the engine itself stays pure).
// ---------------------------------------------------------------------------

const db = vi.hoisted(() => ({
  statutoryRateSet: {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
  },
}));

vi.mock("@/lib/db", () => ({ db }));

import {
  calculateNzStatutory,
  calculateNzStatutoryWithSet,
  nzRuleVersion,
  resolveNzRateSet,
  toNzTaxProfile,
  type NzTaxProfileRow,
} from "@/lib/payroll/nz/calculate";
import { NzStatutoryError } from "@/lib/payroll/nz/types";
import { baseProfile, fy2026RateSet, utc } from "./fixtures";

const SET = fy2026RateSet();
const PERIOD_END = utc("2026-11-30");

/** A Prisma-shaped rate-set row (children included) for the resolver. */
function rateSetRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "db-set-1",
    label: SET.label,
    effectiveFrom: utc("2026-04-01"),
    effectiveTo: utc("2027-04-01"),
    isCurrent: true,
    payeTiers: SET.payeTiers.map((t, i) => ({ id: `t${i}`, setId: "db-set-1", ...t, sortOrder: i * 10 })),
    secondaryRates: SET.secondaryRates.map((s, i) => ({ id: `s${i}`, setId: "db-set-1", label: "", ...s })),
    accLevy: { setId: "db-set-1", ...SET.accLevy },
    ietc: { setId: "db-set-1", ...SET.ietc },
    kiwiSaver: {
      setId: "db-set-1",
      defaultEmployeeRate: SET.kiwiSaver!.defaultEmployeeRate,
      allowedEmployeeRates: SET.kiwiSaver!.allowedEmployeeRates,
      employerRate: SET.kiwiSaver!.employerRate,
    },
    esctTiers: SET.esctTiers.map((t, i) => ({ id: `e${i}`, setId: "db-set-1", ...t, sortOrder: i * 10 })),
    studentLoan: { setId: "db-set-1", ...SET.studentLoan },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Task 1.4 — pure core (calculateNzStatutoryWithSet)", () => {
  it("M SL, monthly $5,000, enrolled at the default — the full result", () => {
    const r = calculateNzStatutoryWithSet({
      gross: 5_000,
      frequency: "MONTHLY",
      taxProfile: baseProfile({ taxCode: "M SL" }),
      payPeriodEnd: PERIOD_END,
      rateSet: SET,
    });

    expect(r.paye).toMatchObject({
      tax: 851.71,
      acc: 87.5,
      total: 939.21,
      method: "PRIMARY",
      ietc: 0,
    });
    expect(r.kiwisaver).toMatchObject({
      status: "ENROLLED",
      autoEnrolTriggered: false,
      employee: 175.0,
      employerGross: 175.0,
      // annual for ESCT: (5,000 + 175) × 12 = 62,100 → 17.5% tier
      esct: 30.63, // 175 × 0.175 = 30.625 → 30.63
      employerNet: 144.37,
    });
    expect(r.studentLoan).toBe(358.72); // (5,000 − 2,010.66) × 12%
    expect(r.netPay).toBe(3_527.07); // 5,000 − 939.21 − 175 − 358.72
    expect(r.taxCodeApplied).toBe("M SL");
    expect(r.rateSet).toEqual({ id: SET.id, label: SET.label });
    expect(r.payPeriodEnd).toEqual(PERIOD_END);
  });

  it("net pay + deductions always equals gross (ledger integrity)", () => {
    const r = calculateNzStatutoryWithSet({
      gross: 5_000,
      frequency: "MONTHLY",
      taxProfile: baseProfile({ taxCode: "M SL" }),
      payPeriodEnd: PERIOD_END,
      rateSet: SET,
    });
    expect(r.netPay + r.paye.total + r.kiwisaver.employee + r.studentLoan).toBeCloseTo(r.gross, 2);
    expect(r.paye.tax + r.paye.acc).toBe(r.paye.total);
    expect(r.kiwisaver.esct + r.kiwisaver.employerNet).toBe(r.kiwisaver.employerGross);
  });

  it("ME, monthly $2,000 — IETC flows into the tax line, not net pay magic", () => {
    const r = calculateNzStatutoryWithSet({
      gross: 2_000,
      frequency: "MONTHLY",
      taxProfile: baseProfile({ taxCode: "ME" }),
      payPeriodEnd: PERIOD_END,
      rateSet: SET,
    });
    expect(r.paye.tax).toBe(215.67);
    expect(r.paye.ietc).toBe(43.33);
    expect(r.paye.acc).toBe(35.0);
    expect(r.studentLoan).toBe(0);
    // KiwiSaver at defaults: employee 70, employer 70, ESCT 12.25
    expect(r.kiwisaver.employee).toBe(70.0);
    expect(r.netPay).toBe(2_000 - 250.67 - 70); // 1,679.33
  });

  it("STC 18% PLUS with an 8% SL certificate — every tailored line lines up", () => {
    const r = calculateNzStatutoryWithSet({
      gross: 5_000,
      frequency: "MONTHLY",
      taxProfile: baseProfile({
        taxCode: "STC",
        taxCodeSpecialRate: 0.18,
        stcAccTreatment: "PLUS",
        stcStudentLoanRate: 0.08,
        stcStudentLoanThresholdApplies: true,
      }),
      payPeriodEnd: PERIOD_END,
      rateSet: SET,
    });
    expect(r.paye.tax).toBe(900.0);
    expect(r.paye.acc).toBe(87.5);
    expect(r.studentLoan).toBe(239.15); // (5,000 − 2,010.66) × 8%
    expect(r.kiwisaver.employee).toBe(175.0);
    expect(r.netPay).toBe(5_000 - 987.5 - 175 - 239.15); // 3,598.35
  });

  it("NSW, weekly $1,000 — flat code with levy, no KiwiSaver, no student loan", () => {
    const r = calculateNzStatutoryWithSet({
      gross: 1_000,
      frequency: "WEEKLY",
      taxProfile: baseProfile({ taxCode: "NSW" }),
      payPeriodEnd: PERIOD_END,
      rateSet: SET,
    });
    expect(r.paye).toMatchObject({ tax: 105.0, acc: 17.5, total: 122.5, method: "NSW" });
    expect(r.kiwisaver.status).toBe("NOT_ELIGIBLE");
    expect(r.kiwisaver.employee).toBe(0);
    expect(r.kiwisaver.employerGross).toBe(0);
    expect(r.studentLoan).toBe(0);
    expect(r.netPay).toBe(877.5);
  });

  it("a temporary employee's day-29 trigger surfaces on the result", () => {
    const r = calculateNzStatutoryWithSet({
      gross: 1_000,
      frequency: "WEEKLY",
      taxProfile: baseProfile({
        employmentCategory: "TEMPORARY",
        employmentStartDate: utc("2026-10-31"),
      }),
      payPeriodEnd: PERIOD_END,
      rateSet: SET,
    });
    expect(r.kiwisaver.status).toBe("ENROLLED");
    expect(r.kiwisaver.autoEnrolTriggered).toBe(true);
    expect(r.kiwisaver.employee).toBe(35.0);
  });

  it("negative gross throws before any calculation", () => {
    expect(() =>
      calculateNzStatutoryWithSet({
        gross: -1,
        frequency: "MONTHLY",
        taxProfile: baseProfile({}),
        payPeriodEnd: PERIOD_END,
        rateSet: SET,
      }),
    ).toThrowError(NzStatutoryError);
  });
});

describe("Task 1.4 — rule version", () => {
  it("is stable for the same content and independent of identity", () => {
    const a = nzRuleVersion(SET);
    const b = nzRuleVersion({ ...SET, id: "other-id", label: "another label" });
    expect(a).toBe(b);
    expect(a).toMatch(/^nz1:[0-9a-f]{8}$/);
  });

  it("changes when any consumed parameter changes", () => {
    const base = nzRuleVersion(SET);
    expect(nzRuleVersion({ ...SET, payeTiers: SET.payeTiers.map((t, i) => (i === 1 ? { ...t, rate: 0.18 } : t)) })).not.toBe(base);
    expect(nzRuleVersion({ ...SET, secondaryRates: SET.secondaryRates.map((s) => (s.code === "ND" ? { ...s, rate: 0.46 } : s)) })).not.toBe(base);
    expect(nzRuleVersion({ ...SET, accLevy: { ...SET.accLevy, rate: 0.0183 } })).not.toBe(base);
    expect(nzRuleVersion({ ...SET, ietc: null })).not.toBe(base);
    expect(nzRuleVersion({ ...SET, kiwiSaver: null })).not.toBe(base);
    expect(nzRuleVersion({ ...SET, esctTiers: SET.esctTiers.map((t, i) => (i === 0 ? { ...t, toAnnual: 19_000 } : t)) })).not.toBe(base);
    expect(nzRuleVersion({ ...SET, studentLoan: null })).not.toBe(base);
    expect(nzRuleVersion({ ...SET, studentLoan: { rate: 0.12, annualThreshold: 25_000 } })).not.toBe(base);
  });

  it("is order-insensitive for tier arrays (canonicalised before hashing)", () => {
    expect(nzRuleVersion({ ...SET, payeTiers: [...SET.payeTiers].reverse() })).toBe(nzRuleVersion(SET));
    expect(nzRuleVersion({ ...SET, secondaryRates: [...SET.secondaryRates].reverse() })).toBe(nzRuleVersion(SET));
  });
});

describe("Task 1.4 — toNzTaxProfile (row adapter)", () => {
  const ROW: NzTaxProfileRow = {
    taxCode: "M SL",
    isCasual: false,
    kiwiSaverStatus: "ACTIVE",
    kiwiSaverRate: 0.035, // Prisma Decimal coerces via Number()
    employerKiwiSaverRate: null,
    taxCodeSpecialRate: null,
    stcAccTreatment: null,
    stcStudentLoanRate: null,
  };

  it("maps the Phase 0 row onto the engine profile", () => {
    const p = toNzTaxProfile(ROW, { hireDate: utc("2026-05-01") });
    expect(p).toMatchObject({
      taxCode: "M SL",
      isCasual: false,
      employmentCategory: "PERMANENT",
      employmentStartDate: utc("2026-05-01"),
      casualHolidayPayInWages: true, // adapter default
      kiwiSaverStatus: "ACTIVE",
      kiwiSaverRate: 0.035,
      employerKiwiSaverRate: null,
      esctRateOverride: null,
      taxCodeSpecialRate: null,
      stcAccTreatment: "INC", // adapter default
      stcStudentLoanRate: null,
      stcStudentLoanThresholdApplies: true, // adapter default
    });
  });

  it("a casual row derives the CASUAL category; facts can override it", () => {
    expect(toNzTaxProfile({ ...ROW, isCasual: true }).employmentCategory).toBe("CASUAL");
    expect(
      toNzTaxProfile({ ...ROW, isCasual: true }, { employmentCategory: "CASUAL_AGRICULTURAL", casualHolidayPayInWages: false })
        .employmentCategory,
    ).toBe("CASUAL_AGRICULTURAL");
  });

  it("string decimals (SQLite / JSON round-trips) coerce to numbers", () => {
    const p = toNzTaxProfile({ ...ROW, kiwiSaverRate: "0.04", taxCodeSpecialRate: "0.18", stcStudentLoanRate: "0.08" });
    expect(p.kiwiSaverRate).toBe(0.04);
    expect(p.taxCodeSpecialRate).toBe(0.18);
    expect(p.stcStudentLoanRate).toBe(0.08);
  });

  it("rejects unknown elections, empty codes and bad STC treatments", () => {
    expect(() => toNzTaxProfile({ ...ROW, kiwiSaverStatus: "MYSTERY" })).toThrowError(NzStatutoryError);
    expect(() => toNzTaxProfile({ ...ROW, taxCode: "  " })).toThrowError(NzStatutoryError);
    expect(() => toNzTaxProfile({ ...ROW, stcAccTreatment: "SOMETIMES" })).toThrowError(NzStatutoryError);
  });
});

describe("Task 1.4 — resolveNzRateSet (DB resolver)", () => {
  it("finds the latest set covering the pay-period end", async () => {
    db.statutoryRateSet.findFirst.mockResolvedValue(rateSetRow());
    const set = await resolveNzRateSet(PERIOD_END);
    expect(db.statutoryRateSet.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          effectiveFrom: { lte: PERIOD_END },
          OR: [{ effectiveTo: null }, { effectiveTo: { gt: PERIOD_END } }],
        },
        orderBy: { effectiveFrom: "desc" },
      }),
    );
    expect(set).not.toBeNull();
    expect(set!.label).toBe(SET.label);
    expect(set!.payeTiers.map((t) => t.fromAnnual)).toEqual([0, 15600, 53500, 78100, 180000]);
  });

  it("an explicit id goes through findUnique", async () => {
    db.statutoryRateSet.findUnique.mockResolvedValue(rateSetRow({ id: "explicit" }));
    const set = await resolveNzRateSet(PERIOD_END, "explicit");
    expect(db.statutoryRateSet.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "explicit" } }),
    );
    expect(set!.id).toBe("explicit");
  });

  it("returns null when nothing covers the date", async () => {
    db.statutoryRateSet.findFirst.mockResolvedValue(null);
    expect(await resolveNzRateSet(utc("2020-01-01"))).toBeNull();
  });

  it("throws on unusable rows (no ACC levy / no PAYE tiers)", async () => {
    db.statutoryRateSet.findFirst.mockResolvedValue(rateSetRow({ accLevy: null }));
    await expect(resolveNzRateSet(PERIOD_END)).rejects.toThrowError(NzStatutoryError);
    db.statutoryRateSet.findFirst.mockResolvedValue(rateSetRow({ payeTiers: [] }));
    await expect(resolveNzRateSet(PERIOD_END)).rejects.toThrowError(NzStatutoryError);
  });

  it("unsorted tier rows come back sorted", async () => {
    db.statutoryRateSet.findFirst.mockResolvedValue(
      rateSetRow({ payeTiers: [...rateSetRow().payeTiers].reverse(), esctTiers: [...rateSetRow().esctTiers].reverse() }),
    );
    const set = await resolveNzRateSet(PERIOD_END);
    expect(set!.payeTiers.map((t) => t.rate)).toEqual([0.105, 0.175, 0.3, 0.33, 0.39]);
    expect(set!.esctTiers.map((t) => t.rate)).toEqual([0.105, 0.175, 0.3, 0.33, 0.39]);
  });
});

describe("Task 1.4 — calculateNzStatutory (async entry point)", () => {
  it("resolves the set for the period and delegates to the pure core", async () => {
    db.statutoryRateSet.findFirst.mockResolvedValue(rateSetRow());
    const r = await calculateNzStatutory({
      gross: 5_000,
      frequency: "MONTHLY",
      taxProfile: toNzTaxProfile({
        taxCode: "M SL",
        isCasual: false,
        kiwiSaverStatus: "ACTIVE",
        kiwiSaverRate: null,
        employerKiwiSaverRate: null,
        taxCodeSpecialRate: null,
        stcAccTreatment: null,
        stcStudentLoanRate: null,
      }),
      payPeriodEnd: PERIOD_END,
    });
    expect(r.rateSet).toEqual({ id: "db-set-1", label: SET.label });
    expect(r.paye.total).toBe(939.21);
    expect(r.netPay).toBe(3_527.07);
    expect(r.ruleVersion).toBe(nzRuleVersion(SET)); // same content → same version
  });

  it("an explicit rateSetId is honoured (run snapshots pin the set)", async () => {
    db.statutoryRateSet.findUnique.mockResolvedValue(rateSetRow({ id: "pinned" }));
    const r = await calculateNzStatutory({
      gross: 1_000,
      frequency: "WEEKLY",
      taxProfile: baseProfile({}),
      payPeriodEnd: PERIOD_END,
      rateSetId: "pinned",
    });
    expect(r.rateSet.id).toBe("pinned");
    expect(r.paye.total).toBe(171.5);
  });

  it("throws a clear error when no set covers the pay period", async () => {
    db.statutoryRateSet.findFirst.mockResolvedValue(null);
    await expect(
      calculateNzStatutory({
        gross: 1_000,
        frequency: "WEEKLY",
        taxProfile: baseProfile({}),
        payPeriodEnd: utc("2020-01-01"),
      }),
    ).rejects.toThrow(/No statutory rate set effective on 2020-01-01/);
  });
});
