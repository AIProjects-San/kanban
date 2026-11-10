import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// F2.4 — leave policy engine, pure-rule matrix
// (docs/Fernly_Policy_Engine_Design.md §4; enhancement plan §7.2 F2.4).
//
// Every strategy's ledger walk, the floor-aware guard, the LV-B07 service
// gate, the standing cap, idempotency (existingPeriodKeys), the year-end
// rollover and the carry lapse — pinned here, not in mocks.
// ---------------------------------------------------------------------------

import {
  resolveLeavePolicy,
  dueGrantOps,
  checkLeaveRequestAgainstBalance,
  checkServiceEligibility,
  rolloverOps,
  carryLapseDelta,
  monthsIntoYear,
  addMonths,
  monthsBetween,
  capBalanceForConsumption,
  type LeavePolicyRow,
  type EmploymentFacts,
  type DueGrantsInput,
  checkCrossRequestConsecutive } from "@/lib/leave-policy";

const NO_FACTS: EmploymentFacts | null = null;
const ACTIVE_FROM_2023: EmploymentFacts = {
  hireDate: "2023-03-15",
  employmentStatus: "ACTIVE",
  probationEndsAt: null,
};

function policyRow(overrides: Partial<LeavePolicyRow> = {}): LeavePolicyRow {
  return {
    annualDays: 20,
    maxCarryOver: 5,
    minNoticeDays: 1,
    maxConsecutiveDays: 15,
    ...overrides,
  };
}

function due(
  row: Partial<LeavePolicyRow>,
  employment: EmploymentFacts | null,
  year: number,
  asOf: string,
  opts: Partial<Pick<DueGrantsInput, "grantedSoFar" | "availableNow" | "existingPeriodKeys">> = {},
): ReturnType<typeof dueGrantOps> {
  return dueGrantOps({
    policy: resolveLeavePolicy(policyRow(row)),
    employment,
    year,
    asOf,
    grantedSoFar: opts.grantedSoFar ?? 0,
    availableNow: opts.availableNow ?? 0,
    existingPeriodKeys: opts.existingPeriodKeys ?? new Set<string>(),
  });
}

// ---------------------------------------------------------------------------
// resolveLeavePolicy — defaults are the pre-F2.4 world (zero drift)
// ---------------------------------------------------------------------------

describe("resolveLeavePolicy", () => {
  it("resolves null to the classic defaults (no policy row at all)", () => {
    const p = resolveLeavePolicy(null);
    expect(p).toMatchObject({
      annualDays: 0,
      allocationStrategy: "MANUAL",
      allowNegative: false,
      negativeFloor: 0,
      countHolidaysInLeave: false,
      accrualCap: 0,
      minServiceMonths: 0,
      carryExpiresAfterMonths: null,
    });
  });

  it("fills every strategy field from the row and defaults accrualCap to annualDays", () => {
    const p = resolveLeavePolicy(
      policyRow({ annualDays: 24, allocationStrategy: "EARNED", accrualCap: null }),
    );
    expect(p.allocationStrategy).toBe("EARNED");
    expect(p.accrualCap).toBe(24);
  });

  it("fails LOUD on an unknown enum value (design doc §10.6)", () => {
    expect(() => resolveLeavePolicy(policyRow({ allocationStrategy: "WAT" }))).toThrow(/allocationStrategy/);
    expect(() => resolveLeavePolicy(policyRow({ accrualFrequency: "DAILY" }))).toThrow(/accrualFrequency/);
    expect(() => resolveLeavePolicy(policyRow({ allocateOnDay: "MIDDLE" }))).toThrow(/allocateOnDay/);
    expect(() => resolveLeavePolicy(policyRow({ accrualRounding: "UP" }))).toThrow(/accrualRounding/);
    expect(() => resolveLeavePolicy(policyRow({ grantOn: "MIDSUMMER" }))).toThrow(/grantOn/);
  });

  it("clamps nonsense numerics without throwing (they are knobs, not vocabularies)", () => {
    const p = resolveLeavePolicy(policyRow({ negativeFloor: -7, minServiceMonths: -3 }));
    expect(p.negativeFloor).toBe(0);
    expect(p.minServiceMonths).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// MANUAL — nothing is scheduled (the service's materializer owns it)
// ---------------------------------------------------------------------------

describe("MANUAL strategy", () => {
  it("returns no ops — grant-on-first-use stays on the service path", () => {
    expect(due({ allocationStrategy: "MANUAL" }, ACTIVE_FROM_2023, 2026, "2026-06-15")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// ANNUAL_LUMP_SUM — Org B of the design doc
// ---------------------------------------------------------------------------

describe("ANNUAL_LUMP_SUM strategy", () => {
  it("grants the whole year on Jan 1 for an employee hired before the year", () => {
    const ops = due({ allocationStrategy: "ANNUAL_LUMP_SUM" }, ACTIVE_FROM_2023, 2026, "2026-01-01");
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ periodKey: "2026", delta: 20, dueDate: "2026-01-01" });
  });

  it("grants nothing before Jan 1 and nothing for a pre-hire year", () => {
    expect(due({ allocationStrategy: "ANNUAL_LUMP_SUM" }, ACTIVE_FROM_2023, 2026, "2025-12-31")).toEqual([]);
    expect(due({ allocationStrategy: "ANNUAL_LUMP_SUM" }, ACTIVE_FROM_2023, 2022, "2022-06-01")).toEqual([]);
  });

  it("pro-rates a mid-year joiner by calendar days remaining, floor-quarter", () => {
    const joiner: EmploymentFacts = { hireDate: "2026-07-15", employmentStatus: "ACTIVE", probationEndsAt: null };
    // Jul 15 → Dec 31 = 170 of 365 days → 20 × 170/365 = 9.315… → 9.25.
    const ops = due({ allocationStrategy: "ANNUAL_LUMP_SUM", prorateForJoiners: true }, joiner, 2026, "2026-07-15");
    expect(ops).toHaveLength(1);
    expect(ops[0].delta).toBe(9.25);
    expect(ops[0].dueDate).toBe("2026-07-15");
    // Not due the day before the hire.
    expect(due({ allocationStrategy: "ANNUAL_LUMP_SUM" }, joiner, 2026, "2026-07-14")).toEqual([]);
  });

  it("pro-rates a Jan 1 hire to the full amount and a Dec 31 hire to zero", () => {
    const jan1: EmploymentFacts = { hireDate: "2026-01-01", employmentStatus: "ACTIVE", probationEndsAt: null };
    const dec31: EmploymentFacts = { hireDate: "2026-12-31", employmentStatus: "ACTIVE", probationEndsAt: null };
    expect(due({ allocationStrategy: "ANNUAL_LUMP_SUM" }, jan1, 2026, "2026-01-01")[0].delta).toBe(20);
    expect(due({ allocationStrategy: "ANNUAL_LUMP_SUM" }, dec31, 2026, "2026-12-31")).toEqual([]);
  });

  it("skips pro-ration when prorateForJoiners is false (full year whenever hired)", () => {
    const joiner: EmploymentFacts = { hireDate: "2026-12-01", employmentStatus: "ACTIVE", probationEndsAt: null };
    const ops = due({ allocationStrategy: "ANNUAL_LUMP_SUM", prorateForJoiners: false }, joiner, 2026, "2026-12-01");
    expect(ops[0].delta).toBe(20);
  });

  it("grants on the hire anniversary when grantOn=ANNIVERSARY (Org C's shape without the wait)", () => {
    const ops = due({ allocationStrategy: "ANNUAL_LUMP_SUM", grantOn: "ANNIVERSARY" }, ACTIVE_FROM_2023, 2026, "2026-03-15");
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ periodKey: "2026-03", delta: 20, dueDate: "2026-03-15" });
    expect(due({ allocationStrategy: "ANNUAL_LUMP_SUM", grantOn: "ANNIVERSARY" }, ACTIVE_FROM_2023, 2026, "2026-03-14")).toEqual([]);
  });

  it("treats a profile-less user as full eligibility on Jan 1 (facts-free default)", () => {
    const ops = due({ allocationStrategy: "ANNUAL_LUMP_SUM" }, NO_FACTS, 2026, "2026-01-01");
    expect(ops[0]).toMatchObject({ periodKey: "2026", delta: 20 });
  });

  it("defers the grant until probation ends when accrueDuringProbation=false", () => {
    const probationer: EmploymentFacts = {
      hireDate: "2025-11-01",
      employmentStatus: "PROBATION",
      probationEndsAt: "2026-05-01",
    };
    expect(due({ allocationStrategy: "ANNUAL_LUMP_SUM", accrueDuringProbation: false }, probationer, 2026, "2026-04-30")).toEqual([]);
    const ops = due({ allocationStrategy: "ANNUAL_LUMP_SUM", accrueDuringProbation: false }, probationer, 2026, "2026-05-01");
    expect(ops).toHaveLength(1);
    expect(ops[0].delta).toBe(20);
  });

  it("blocks accrual entirely for a PROBATION employee with no recorded end", () => {
    const unmanaged: EmploymentFacts = { hireDate: "2026-01-05", employmentStatus: "PROBATION", probationEndsAt: null };
    expect(due({ allocationStrategy: "ANNUAL_LUMP_SUM", accrueDuringProbation: false }, unmanaged, 2026, "2026-12-31")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// EARNED — Org A of the design doc (monthly accrual + advance allowance)
// ---------------------------------------------------------------------------

describe("EARNED strategy", () => {
  it("accrues monthly, one period per month, landing on the 1st", () => {
    const ops = due({ allocationStrategy: "EARNED", annualDays: 24 }, ACTIVE_FROM_2023, 2026, "2026-03-01");
    expect(ops.map((o) => [o.periodKey, o.delta])).toEqual([
      ["2026-01", 2],
      ["2026-02", 2],
      ["2026-03", 2],
    ]);
  });

  it("sums to EXACTLY annualDays over the year despite floor-quarter rounding (true-up)", () => {
    const ops = due({ allocationStrategy: "EARNED", annualDays: 25 }, ACTIVE_FROM_2023, 2026, "2026-12-31");
    expect(ops).toHaveLength(12);
    // 25/12 = 2.083… → floor-quarter 2.0 × 11 months + 3.0 true-up = 25.
    expect(ops.slice(0, 11).every((o) => o.delta === 2)).toBe(true);
    expect(ops[11]).toMatchObject({ periodKey: "2026-12", delta: 3 });
    expect(ops.reduce((s, o) => s + o.delta, 0)).toBe(25);
  });

  it("is idempotent: existing period keys are skipped (double-run ⇒ single row)", () => {
    const existing = new Set(["2026-01", "2026-02", "2026-03"]);
    const ops = due({ allocationStrategy: "EARNED", annualDays: 24 }, ACTIVE_FROM_2023, 2026, "2026-06-15", {
      existingPeriodKeys: existing,
      grantedSoFar: 6,
    });
    expect(ops.map((o) => o.periodKey)).toEqual(["2026-04", "2026-05", "2026-06"]);
    expect(ops.every((o) => o.delta === 2)).toBe(true);
  });

  it("skips the hire month under FIRST (a partial month never accrues)", () => {
    const joiner: EmploymentFacts = { hireDate: "2026-04-10", employmentStatus: "ACTIVE", probationEndsAt: null };
    const ops = due({ allocationStrategy: "EARNED", annualDays: 24 }, joiner, 2026, "2026-12-31");
    expect(ops.map((o) => o.periodKey)).toEqual([
      "2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10", "2026-11", "2026-12",
    ]);
    // Joiner's partial year pays nominal per employed period (no true-up).
    expect(ops.reduce((s, o) => s + o.delta, 0)).toBe(16);
  });

  it("accrues the hire month on the join day itself under DOJ_DAY", () => {
    const joiner: EmploymentFacts = { hireDate: "2026-04-10", employmentStatus: "ACTIVE", probationEndsAt: null };
    const ops = due({ allocationStrategy: "EARNED", annualDays: 24, allocateOnDay: "DOJ_DAY" }, joiner, 2026, "2026-04-10");
    expect(ops.map((o) => o.periodKey)).toEqual(["2026-04"]);
    expect(ops[0].delta).toBe(2);
    // The 9th (day before hire) is not due yet.
    expect(due({ allocationStrategy: "EARNED", annualDays: 24, allocateOnDay: "DOJ_DAY" }, joiner, 2026, "2026-04-09")).toEqual([]);
  });

  it("supports quarterly, half-yearly and annual cadences with matching period keys", () => {
    const q = due({ allocationStrategy: "EARNED", annualDays: 24, accrualFrequency: "QUARTERLY" }, ACTIVE_FROM_2023, 2026, "2026-06-30");
    expect(q.map((o) => [o.periodKey, o.delta])).toEqual([
      ["2026-Q1", 6],
      ["2026-Q2", 6],
    ]);
    const h = due({ allocationStrategy: "EARNED", annualDays: 24, accrualFrequency: "HALF_YEARLY" }, ACTIVE_FROM_2023, 2026, "2026-06-30");
    expect(h.map((o) => [o.periodKey, o.delta])).toEqual([["2026-H1", 12]]);
    const a = due({ allocationStrategy: "EARNED", annualDays: 24, accrualFrequency: "ANNUAL" }, ACTIVE_FROM_2023, 2026, "2026-12-31");
    expect(a.map((o) => [o.periodKey, o.delta])).toEqual([["2026", 24]]);
  });

  it("lands grants on the period's last day when allocateOnDay=LAST", () => {
    const ops = due({ allocationStrategy: "EARNED", annualDays: 24, allocateOnDay: "LAST" }, ACTIVE_FROM_2023, 2026, "2026-01-31");
    expect(ops.map((o) => o.periodKey)).toEqual(["2026-01"]);
    expect(due({ allocationStrategy: "EARNED", annualDays: 24, allocateOnDay: "LAST" }, ACTIVE_FROM_2023, 2026, "2026-01-30")).toEqual([]);
  });

  it("enforces the STANDING cap: consumption frees room, grants never exceed it", () => {
    // Cap 15, 2/month, Jan–Jul already granted (14, none consumed) → the
    // August grant truncates to the 1 day of room left; Sep–Dec get none.
    const almostFull = new Set(
      ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07"],
    );
    const truncated = due(
      { allocationStrategy: "EARNED", annualDays: 24, accrualCap: 15 },
      ACTIVE_FROM_2023, 2026, "2026-12-31",
      { existingPeriodKeys: almostFull, grantedSoFar: 14, availableNow: 14 },
    );
    expect(truncated.map((o) => [o.periodKey, o.delta])).toEqual([["2026-08", 1]]);

    // Same grants but 12 days consumed (standing 2) → 13 days of room,
    // which no longer binds (5 remaining months × 2 = 10 nominal) → every
    // remaining month accrues its FULL nominal again (consumption freed the
    // cap that would otherwise have stopped all accrual).
    const reEarning = due(
      { allocationStrategy: "EARNED", annualDays: 24, accrualCap: 15 },
      ACTIVE_FROM_2023, 2026, "2026-12-31",
      { existingPeriodKeys: almostFull, grantedSoFar: 14, availableNow: 2 },
    );
    expect(reEarning.map((o) => [o.periodKey, o.delta])).toEqual([
      ["2026-08", 2], ["2026-09", 2], ["2026-10", 2], ["2026-11", 2], ["2026-12", 2],
    ]);
    // Standing AT the cap → room 0 → nothing granted.
    const capped = due(
      { allocationStrategy: "EARNED", annualDays: 24, accrualCap: 15 },
      ACTIVE_FROM_2023, 2026, "2026-08-01",
      { grantedSoFar: 15, availableNow: 15 },
    );
    expect(capped).toEqual([]);
  });

  it("NEAREST rounding rounds per-period grants to the nearest quarter", () => {
    // 25/12 = 2.0833 → NEAREST quarter = 2.0? No: 2.0833 → 2.25? 2.0833×4 = 8.33 → round = 8 → 2.0.
    // 26/12 = 2.1667 → ×4 = 8.67 → 9 → 2.25.
    const ops = due({ allocationStrategy: "EARNED", annualDays: 26, accrualRounding: "NEAREST" }, ACTIVE_FROM_2023, 2026, "2026-02-01");
    expect(ops.map((o) => o.delta)).toEqual([2.25, 2.25]);
  });

  it("defers accrual to probationEndsAt when accrueDuringProbation=false", () => {
    const probationer: EmploymentFacts = {
      hireDate: "2025-11-01",
      employmentStatus: "PROBATION",
      probationEndsAt: "2026-03-10",
    };
    // Nothing while probation runs (Jan/Feb/Mar-1st all < Mar 10).
    expect(due({ allocationStrategy: "EARNED", annualDays: 24, accrueDuringProbation: false }, probationer, 2026, "2026-03-09")).toEqual([]);
    // From probation end: April's period (due Apr 1 ≥ Mar 10) accrues; the
    // Jan–Mar periods' landing moments (Jan 1/Feb 1/Mar 1) were deferred to
    // Mar 10 — they become due then too (pause-then-resume, documented).
    const ops = due({ allocationStrategy: "EARNED", annualDays: 24, accrueDuringProbation: false }, probationer, 2026, "2026-03-10");
    expect(ops.map((o) => o.periodKey)).toEqual(["2026-01", "2026-02", "2026-03"]);
  });
});

// ---------------------------------------------------------------------------
// AFTER_SERVICE — Org C of the design doc (deposit after a year of service)
// ---------------------------------------------------------------------------

describe("AFTER_SERVICE strategy", () => {
  const orgC: EmploymentFacts = { hireDate: "2025-04-01", employmentStatus: "ACTIVE", probationEndsAt: null };

  it("deposits nothing during the first minServiceMonths", () => {
    expect(due({ allocationStrategy: "AFTER_SERVICE", annualDays: 12, minServiceMonths: 12 }, orgC, 2025, "2025-12-31")).toEqual([]);
    expect(due({ allocationStrategy: "AFTER_SERVICE", annualDays: 12, minServiceMonths: 12 }, orgC, 2026, "2026-03-31")).toEqual([]);
  });

  it("deposits the whole year on the service anniversary, then repeats yearly", () => {
    const first = due({ allocationStrategy: "AFTER_SERVICE", annualDays: 12, minServiceMonths: 12 }, orgC, 2026, "2026-04-01");
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ periodKey: "2026-04", delta: 12, dueDate: "2026-04-01" });

    const second = due({ allocationStrategy: "AFTER_SERVICE", annualDays: 12, minServiceMonths: 12 }, orgC, 2027, "2027-04-01");
    expect(second[0]).toMatchObject({ periodKey: "2027-04", delta: 12, dueDate: "2027-04-01" });
  });

  it("handles a mid-month minServiceMonths threshold (18 months → the 18-month mark)", () => {
    const hired: EmploymentFacts = { hireDate: "2025-04-01", employmentStatus: "ACTIVE", probationEndsAt: null };
    expect(due({ allocationStrategy: "AFTER_SERVICE", annualDays: 12, minServiceMonths: 18 }, hired, 2026, "2026-09-30")).toEqual([]);
    const ops = due({ allocationStrategy: "AFTER_SERVICE", annualDays: 12, minServiceMonths: 18 }, hired, 2026, "2026-10-01");
    expect(ops[0]).toMatchObject({ periodKey: "2026-10", delta: 12, dueDate: "2026-10-01" });
  });

  it("grants nothing without a hire date (service arithmetic is not fabricated)", () => {
    expect(due({ allocationStrategy: "AFTER_SERVICE", minServiceMonths: 12 }, NO_FACTS, 2026, "2026-12-31")).toEqual([]);
  });

  it("skips a deposit already on the ledger (idempotency)", () => {
    const existing = new Set(["2026-04"]);
    expect(due({ allocationStrategy: "AFTER_SERVICE", annualDays: 12, minServiceMonths: 12 }, orgC, 2026, "2026-06-01", {
      existingPeriodKeys: existing,
    })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The guard — floor-aware overdraft check
// ---------------------------------------------------------------------------

describe("checkLeaveRequestAgainstBalance", () => {
  const classic = resolveLeavePolicy(policyRow({}));

  it("is EXACTLY the classic guard at the defaults (floor 0)", () => {
    expect(checkLeaveRequestAgainstBalance(classic, 20, 20).ok).toBe(true);
    expect(checkLeaveRequestAgainstBalance(classic, 20.5, 20).ok).toBe(false);
    expect(checkLeaveRequestAgainstBalance(classic, 8, 6).ok).toBe(false);
    expect(checkLeaveRequestAgainstBalance(classic, 6, 6).ok).toBe(true);
  });

  it("allows a request that lands exactly ON the floor", () => {
    const advance = resolveLeavePolicy(policyRow({ allowNegative: true, negativeFloor: 5 }));
    // available 6 − requested 8 = −2 ≥ −5 → allowed.
    expect(checkLeaveRequestAgainstBalance(advance, 8, 6)).toMatchObject({ ok: true, floor: 5 });
    // available 6 − requested 11 = −5 = the floor → still allowed.
    expect(checkLeaveRequestAgainstBalance(advance, 11, 6).ok).toBe(true);
  });

  it("rejects one day past the floor", () => {
    const advance = resolveLeavePolicy(policyRow({ allowNegative: true, negativeFloor: 5 }));
    expect(checkLeaveRequestAgainstBalance(advance, 11.25, 6).ok).toBe(false);
    expect(checkLeaveRequestAgainstBalance(advance, 20, 6).ok).toBe(false);
  });

  it("a floor without the allowNegative switch is inert data", () => {
    const inert = resolveLeavePolicy(policyRow({ allowNegative: false, negativeFloor: 5 }));
    expect(checkLeaveRequestAgainstBalance(inert, 8, 6)).toMatchObject({ ok: false, floor: 0 });
  });
});

// ---------------------------------------------------------------------------
// The LV-B07 service gate
// ---------------------------------------------------------------------------

describe("checkServiceEligibility", () => {
  const gated = resolveLeavePolicy(policyRow({ minServiceMonths: 6 }));

  it("passes when the type has no gate", () => {
    const p = resolveLeavePolicy(policyRow({}));
    expect(checkServiceEligibility(p, ACTIVE_FROM_2023, "2026-01-01").ok).toBe(true);
  });

  it("rejects before N months of service and passes on the mark", () => {
    const fresh: EmploymentFacts = { hireDate: "2026-01-15", employmentStatus: "ACTIVE", probationEndsAt: null };
    expect(checkServiceEligibility(gated, fresh, "2026-07-14").ok).toBe(false);
    expect(checkServiceEligibility(gated, fresh, "2026-07-15").ok).toBe(true);
  });

  it("no hire date on record is not ineligibility (unknown ≠ ineligible)", () => {
    const noFacts: EmploymentFacts = { hireDate: null, employmentStatus: "ACTIVE", probationEndsAt: null };
    expect(checkServiceEligibility(gated, noFacts, "2026-01-01").ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Year-end rollover + carry lapse (the cron's other writers)
// ---------------------------------------------------------------------------

describe("rolloverOps", () => {
  it("carries min(available, maxCarryOver) and expires the excess", () => {
    expect(rolloverOps(8, 5)).toEqual({ carry: 5, expire: -3 });
    expect(rolloverOps(3, 5)).toEqual({ carry: 3, expire: 0 });
    expect(rolloverOps(0, 5)).toEqual({ carry: 0, expire: 0 });
    expect(rolloverOps(-2, 5)).toEqual({ carry: 0, expire: 0 }); // advance debt is not expired, it is owed
    expect(rolloverOps(7, 0)).toEqual({ carry: 0, expire: -7 }); // sick-style: carry 0, all excess lapses
  });
});

describe("carryLapseDelta", () => {
  it("expires the unspent carry only (FIFO consumption)", () => {
    expect(carryLapseDelta(5, 3)).toBe(-2); // 2 of the 5 carried days unspent
    expect(carryLapseDelta(5, 7)).toBe(0); // all carry spent
    expect(carryLapseDelta(0, 5)).toBe(0);
  });
});

describe("monthsIntoYear", () => {
  it("counts COMPLETE months (a 3-month expiry lapses on April 1st)", () => {
    expect(monthsIntoYear(2026, "2026-01-31")).toBe(0);
    expect(monthsIntoYear(2026, "2026-02-01")).toBe(1);
    expect(monthsIntoYear(2026, "2026-03-31")).toBe(2);
    expect(monthsIntoYear(2026, "2026-04-01")).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Date helpers the engine rides on
// ---------------------------------------------------------------------------

describe("date helpers", () => {
  it("addMonths clamps to month ends", () => {
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2024-01-31", 1)).toBe("2024-02-29"); // leap year
    expect(addMonths("2024-02-29", 12)).toBe("2025-02-28");
    expect(addMonths("2026-04-01", 18)).toBe("2027-10-01");
  });

  it("monthsBetween counts whole calendar months", () => {
    expect(monthsBetween("2025-04-01", "2026-04-01")).toBe(12);
    expect(monthsBetween("2026-01-15", "2026-02-10")).toBe(0); // partial month
    expect(monthsBetween("2026-01-15", "2026-02-15")).toBe(1);
    expect(monthsBetween("2026-03-01", "2026-01-01")).toBe(-2);
  });
});


describe("checkCrossRequestConsecutive (LV-B08 / S12)", () => {
  const hol = undefined; // holiday-free: working days = Mon–Fri counts

  it("a lone range is its own chain (identical to the per-request guard)", () => {
    const r = checkCrossRequestConsecutive({ newStart: "2026-11-02", newEnd: "2026-11-06", others: [], maxConsecutiveDays: 5, holidays: hol });
    expect(r).toEqual({ ok: true, chainDays: 5, chainStart: "2026-11-02", chainEnd: "2026-11-06" });
  });

  it("TOUCHING requests chain: Mon–Fri + next Mon–Fri = 10 working days", () => {
    const r = checkCrossRequestConsecutive({
      newStart: "2026-11-09", newEnd: "2026-11-13",
      others: [{ start: "2026-11-02", end: "2026-11-06" }],
      maxConsecutiveDays: 9, holidays: hol,
    });
    expect(r.chainDays).toBe(10);
    expect(r.ok).toBe(false);
    expect(r.chainStart).toBe("2026-11-02");
    expect(r.chainEnd).toBe("2026-11-13");
  });

  it("a ≥1-calendar-day gap breaks the chain (weekend bridges count as gaps)", () => {
    // Fri 2026-11-06 → Tue 2026-11-10: Sat/Sun gap → separate chains.
    const r = checkCrossRequestConsecutive({
      newStart: "2026-11-10", newEnd: "2026-11-13",
      others: [{ start: "2026-11-02", end: "2026-11-06" }],
      maxConsecutiveDays: 9, holidays: hol,
    });
    expect(r.chainDays).toBe(4); // Tue–Fri only
    expect(r.ok).toBe(true);
  });

  it("three-way chains merge in any input order", () => {
    const r = checkCrossRequestConsecutive({
      newStart: "2026-11-09", newEnd: "2026-11-10",
      others: [
        { start: "2026-11-16", end: "2026-11-20" },      // after, touching Tue 10 → Wed 11? gap = 11-15 minus...
        { start: "2026-11-02", end: "2026-11-06" },      // before, touching
      ],
      maxConsecutiveDays: 9, holidays: hol,
    });
    // 11-02..06 (5d) + 11-09..10 (2d) chain; 11-16..20 has an 11-11..15 gap → separate.
    expect(r.chainDays).toBe(7);
    expect(r.chainStart).toBe("2026-11-02");
    expect(r.chainEnd).toBe("2026-11-10");
  });

  it("overlapping requests merge into one chain (the overlap guard fires elsewhere)", () => {
    const r = checkCrossRequestConsecutive({
      newStart: "2026-11-04", newEnd: "2026-11-10",
      others: [{ start: "2026-11-02", end: "2026-11-06" }],
      maxConsecutiveDays: 9, holidays: hol,
    });
    expect(r.chainDays).toBe(7); // 11-02..10
    expect(r.ok).toBe(true);
  });

  it("holidays inside the chain reduce the counted days (holiday-aware like every day count)", () => {
    const hol2 = new Map([["2026-11-03", { isHalfDay: false }]]);
    const r = checkCrossRequestConsecutive({
      newStart: "2026-11-02", newEnd: "2026-11-06", others: [],
      maxConsecutiveDays: 4, holidays: hol2,
    });
    expect(r.chainDays).toBe(4);
    expect(r.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// P21 (LV-B14) — the balance-for-consumption cap
// (benchmark get_remaining_leaves: consumable = min(positive balance,
// calendar days left in the allocation year, inclusive of the start day))
// ---------------------------------------------------------------------------

describe("capBalanceForConsumption", () => {
  it("caps a balance that outruns the days left in the year", () => {
    // Dec 15 → Dec 31 = 17 calendar days (inclusive).
    const r = capBalanceForConsumption(30, "2026-12-15", 2026);
    expect(r.daysLeftInYear).toBe(17);
    expect(r.consumable).toBe(17);
    expect(r.capped).toBe(true);
  });

  it("a balance under the cap passes through untouched", () => {
    const r = capBalanceForConsumption(5, "2026-12-15", 2026);
    expect(r.consumable).toBe(5);
    expect(r.capped).toBe(false);
  });

  it("an advance (negative) balance is never capped — the floor path owns it", () => {
    const r = capBalanceForConsumption(-3, "2026-12-15", 2026);
    expect(r.consumable).toBe(-3);
    expect(r.capped).toBe(false);
  });

  it("December 31 itself leaves exactly one consumable day", () => {
    const r = capBalanceForConsumption(10, "2026-12-31", 2026);
    expect(r.daysLeftInYear).toBe(1);
    expect(r.consumable).toBe(1);
  });

  it("January 1 sees the whole (leap-aware) year", () => {
    expect(capBalanceForConsumption(400, "2027-01-01", 2027).daysLeftInYear).toBe(365);
    expect(capBalanceForConsumption(400, "2028-01-01", 2028).daysLeftInYear).toBe(366);
  });

  it("the guard chain: a request past the cap refuses where balance alone would pass", () => {
    // Balance 30 would cover a 5-working-day request; the year has 2 days left.
    const cap = capBalanceForConsumption(30, "2026-12-30", 2026);
    const guard = checkLeaveRequestAgainstBalance(
      resolveLeavePolicy(null), 5, cap.consumable,
    );
    expect(guard.ok).toBe(false);
    // The uncapped balance would have passed — the cap is what refused.
    expect(checkLeaveRequestAgainstBalance(resolveLeavePolicy(null), 5, 30).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// P27 (LV-08) — named allocation windows. Every strategy's planPeriods
// derives its boundaries from the window; absent, the implicit calendar
// year (byte-identical — the whole suite above IS that pin). The window
// kernel's own matrix lives in leave-period.test.ts.
// ---------------------------------------------------------------------------

describe("P27 window strategies (fiscal Apr → Mar, bucket 2027)", () => {
  const WIN = { start: "2027-04-01", end: "2028-03-31" };

  function dueWin(
    row: Partial<LeavePolicyRow>,
    employment: EmploymentFacts | null,
    year: number,
    asOf: string,
    window?: { start: string; end: string },
  ): ReturnType<typeof dueGrantOps> {
    return dueGrantOps({
      policy: resolveLeavePolicy(policyRow(row)),
      employment,
      year,
      asOf,
      window,
      grantedSoFar: 0,
      availableNow: 0,
      existingPeriodKeys: new Set<string>(),
    });
  }

  const win = (): { start: string; end: string } => ({ ...WIN });

  it("ANNUAL_LUMP_SUM PERIOD_START lands the lump on the window's first day", () => {
    const ops = dueWin({ allocationStrategy: "ANNUAL_LUMP_SUM", grantOn: "PERIOD_START" }, ACTIVE_FROM_2023, 2027, "2027-04-02", win());
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ periodKey: "2027", delta: 20, dueDate: "2027-04-01" });
  });

  it("ANNUAL_LUMP_SUM PERIOD_START + prorateForJoiners: a mid-window joiner's grant is window-pro-rated", () => {
    // Hired Jul 1 2027 — 274 days remain of the 365-day window
    // (Jul 1 → Mar 31 inclusive).
    const hireMid: EmploymentFacts = { hireDate: "2027-07-01", employmentStatus: "ACTIVE", probationEndsAt: null };
    const ops = dueWin({ allocationStrategy: "ANNUAL_LUMP_SUM", grantOn: "PERIOD_START", annualDays: 20, prorateForJoiners: true }, hireMid, 2027, "2027-07-02", win());
    expect(ops).toHaveLength(1);
    // 20 × 274/365 = 15.01… → floor-quarter = 15.
    expect(ops[0].delta).toBe(15);
    expect(ops[0].dueDate).toBe("2027-07-01");
  });

  it("ANNUAL_LUMP_SUM ANNIVERSARY: the hire anniversary inside the window", () => {
    // hire 2023-03-15: the anniversaries at +48 months (2027-03-15) precede
    // the Apr 2027 window start — the in-window one is 2028-03-15 (+60),
    // due once asOf reaches it.
    const notYet = dueWin({ allocationStrategy: "ANNUAL_LUMP_SUM", grantOn: "ANNIVERSARY" }, ACTIVE_FROM_2023, 2027, "2028-01-01", win());
    expect(notYet).toHaveLength(0);
    const ops = dueWin({ allocationStrategy: "ANNUAL_LUMP_SUM", grantOn: "ANNIVERSARY" }, ACTIVE_FROM_2023, 2027, "2028-03-20", win());
    expect(ops).toHaveLength(1);
    expect(ops[0].dueDate).toBe("2028-03-15");
    expect(ops[0].periodKey).toBe("2027-03");
  });

  it("AFTER_SERVICE deposits land inside the window", () => {
    // hire 2023-03-15 + 12 months = 2024-03-15; deposits yearly. In-window:
    // 2028-03-15 (the 2027-03-15 deposit precedes the window start).
    const ops = dueWin({ allocationStrategy: "AFTER_SERVICE", minServiceMonths: 12 }, ACTIVE_FROM_2023, 2027, "2028-03-20", win());
    expect(ops).toHaveLength(1);
    expect(ops[0].dueDate).toBe("2028-03-15");
    expect(ops[0].periodKey).toBe("2027-03");
  });

  it("EARNED MONTHLY periods anchor at the window's months (keys run Apr → Mar)", () => {
    const ops = dueWin({ allocationStrategy: "EARNED", accrualFrequency: "MONTHLY", annualDays: 24 }, ACTIVE_FROM_2023, 2027, "2028-03-31", win());
    expect(ops).toHaveLength(12);
    expect(ops[0]).toMatchObject({ periodKey: "2027-04", dueDate: "2027-04-01" });
    expect(ops[11]).toMatchObject({ periodKey: "2028-03", dueDate: "2028-03-01" });
    // The last period true-ups the full year: 24 days exactly.
    expect(ops.reduce((s, o) => s + o.delta, 0)).toBe(24);
  });

  it("EARNED QUARTERLY anchors its four quarters at the window start", () => {
    const ops = dueWin({ allocationStrategy: "EARNED", accrualFrequency: "QUARTERLY", annualDays: 24 }, ACTIVE_FROM_2023, 2027, "2028-03-31", win());
    expect(ops.map((o) => o.periodKey)).toEqual(["2027-Q1", "2027-Q2", "2027-Q3", "2027-Q4"]);
    expect(ops[0].dueDate).toBe("2027-04-01");
    expect(ops[3].dueDate).toBe("2028-01-01");
    expect(ops.reduce((s, o) => s + o.delta, 0)).toBe(24);
  });

  it("EARNED with DOJ_DAY clamps the hire day into the period's OWN month (bucket year + 1 included)", () => {
    const ops = dueWin({ allocationStrategy: "EARNED", accrualFrequency: "MONTHLY", annualDays: 24, allocateOnDay: "DOJ_DAY" }, ACTIVE_FROM_2023, 2027, "2028-03-31", win());
    // hire day 15: every period lands on its month's 15th — including the
    // periods whose months fall in 2028 (the bucket year + 1).
    expect(ops[0].dueDate).toBe("2027-04-15");
    expect(ops[11].dueDate).toBe("2028-03-15");
  });

  it("a joiner hired mid-window accrues only from their hire month", () => {
    const hireMid: EmploymentFacts = { hireDate: "2027-07-01", employmentStatus: "ACTIVE", probationEndsAt: null };
    const ops = dueWin({ allocationStrategy: "EARNED", accrualFrequency: "MONTHLY", annualDays: 24 }, hireMid, 2027, "2028-03-31", win());
    // Jul → Mar = 9 periods, each floor-quarter 2 → 18 days.
    expect(ops).toHaveLength(9);
    expect(ops[0].periodKey).toBe("2027-07");
    expect(ops.reduce((s, o) => s + o.delta, 0)).toBe(18);
  });

  it("absent window: the implicit calendar year (the byte-identical default)", () => {
    const ops = dueWin({ allocationStrategy: "EARNED", accrualFrequency: "MONTHLY", annualDays: 24 }, ACTIVE_FROM_2023, 2027, "2027-12-31");
    expect(ops[0]).toMatchObject({ periodKey: "2027-01", dueDate: "2027-01-01" });
    expect(ops[11]).toMatchObject({ periodKey: "2027-12" });
  });
});

describe("P27 capBalanceForConsumption — the window end", () => {
  it("caps at the days left in the named window (not Dec 31)", () => {
    // Window ends 2028-03-31; a request starting 2028-03-02 has 30 days
    // left — a 35-day balance caps to 30.
    const r = capBalanceForConsumption(35, "2028-03-02", 2027, "2028-03-31");
    expect(r.daysLeftInYear).toBe(30);
    expect(r.consumable).toBe(30);
    expect(r.capped).toBe(true);
  });

  it("absent windowEnd: Dec 31 of the year (byte-identical)", () => {
    const r = capBalanceForConsumption(30, "2027-12-15", 2027);
    expect(r.daysLeftInYear).toBe(17);
  });
});
