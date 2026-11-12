import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Task 1.2 (revised) — KiwiSaver acceptance tests: the auto-enrolment
// resolution scenarios and the money calculation with ESCT.
//
// The exemption rules were verified verbatim against IRD's "Opting in and
// enrolling temporary and casual employees" page (2026-11-12):
//   • temporary: "You must automatically enrol employees if their
//     employment is for more than 28 days in a row. This applies from
//     day 29."
//   • casual: exempt when "engaged on an irregular and intermittent basis"
//     and "get holiday pay with their wages"
//   • casual agricultural: exempt "on a day-to-day basis for fewer than
//     3 months"
// ---------------------------------------------------------------------------

import {
  autoEnrolDueDate,
  calculateKiwiSaver,
  esctRateForAnnual,
  resolveKiwiSaverStatus,
} from "@/lib/payroll/nz/kiwisaver";
import { baseProfile, fy2026RateSet, utc } from "./fixtures";

const SET = fy2026RateSet();
const PERIOD_END = utc("2026-11-30");

function ks(
  gross: number,
  profileOverrides: Record<string, unknown>,
  frequency: "WEEKLY" | "MONTHLY" | "ANNUAL" = "MONTHLY",
  payPeriodEnd: Date = PERIOD_END,
) {
  const profile = baseProfile(profileOverrides);
  const resolution = resolveKiwiSaverStatus(profile, payPeriodEnd);
  const result = calculateKiwiSaver({
    gross,
    frequency,
    taxProfile: profile,
    resolution,
    kiwiSaver: SET.kiwiSaver,
    esctTiers: SET.esctTiers,
  });
  return { resolution, result };
}

describe("Task 1.2 — resolveKiwiSaverStatus acceptance scenarios", () => {
  it("Permanent employee, no election — ENROLLED (auto-enrolled at hire posture)", () => {
    const { resolution } = ks(1_000, {});
    expect(resolution.status).toBe("ENROLLED");
    expect(resolution.autoEnrolTriggered).toBe(false);
  });

  it("Permanent employee, ENROLLED at 3.5% — employee deduction is gross × 3.5%", () => {
    const { result } = ks(1_000, { kiwiSaverRate: 0.035 });
    expect(result.status).toBe("ENROLLED");
    expect(result.employee).toBe(35.0);
    expect(result.employeeRate).toBe(0.035);
  });

  it("Casual employee, holiday pay in wages, not opted in — NOT_ENROLLED (exempt)", () => {
    const { resolution, result } = ks(1_000, {
      employmentCategory: "CASUAL",
      casualHolidayPayInWages: true,
    });
    expect(resolution.status).toBe("NOT_ENROLLED");
    expect(result.employee).toBe(0);
    expect(result.employerGross).toBe(0);
  });

  it("Casual employee opted in manually — ENROLLED at their elected rate", () => {
    const { resolution, result } = ks(1_000, {
      employmentCategory: "CASUAL",
      kiwiSaverRate: 0.04,
    });
    expect(resolution.status).toBe("ENROLLED");
    expect(result.employee).toBe(40.0);
  });

  it("Casual without the holiday-pay-in-wages condition does not meet the exemption", () => {
    // IRD's casual definition requires BOTH irregular/intermittent work AND
    // holiday pay in wages; without the second condition auto-enrolment
    // applies.
    const { resolution } = ks(1_000, {
      employmentCategory: "CASUAL",
      casualHolidayPayInWages: false,
    });
    expect(resolution.status).toBe("ENROLLED");
    expect(resolution.autoEnrolTriggered).toBe(true);
  });

  it("Temporary employee, 20 days employed — NOT_ENROLLED", () => {
    const { resolution } = ks(1_000, {
      employmentCategory: "TEMPORARY",
      employmentStartDate: utc("2026-11-10"),
    });
    expect(resolution.status).toBe("NOT_ENROLLED");
    expect(resolution.autoEnrolTriggered).toBe(false);
  });

  it("Temporary employee, 30 days employed — ENROLLED (auto-enrol trigger)", () => {
    const { resolution } = ks(1_000, {
      employmentCategory: "TEMPORARY",
      employmentStartDate: utc("2026-10-31"),
    });
    expect(resolution.status).toBe("ENROLLED");
    expect(resolution.autoEnrolTriggered).toBe(true);
  });

  it("The 28-day boundary is exact: day 28 exempt, day 29 enrolled", () => {
    // Day 1 is the employment start date, so day 29 = start + 28 days
    // (Phase 3 correction — a 1 March start auto-enrols on 29 March).
    // Pay period ending 2026-11-30: a 2026-11-03 start is only at day 28
    // (exempt); a 2026-11-02 start reaches day 29 (enrolled).
    const day28 = ks(1_000, {
      employmentCategory: "TEMPORARY",
      employmentStartDate: utc("2026-11-03"),
    });
    expect(day28.resolution.status).toBe("NOT_ENROLLED");
    const day29 = ks(1_000, {
      employmentCategory: "TEMPORARY",
      employmentStartDate: utc("2026-11-02"),
    });
    expect(day29.resolution.status).toBe("ENROLLED");
    expect(day29.resolution.autoEnrolTriggered).toBe(true);
    expect(day29.resolution.reason).toContain("day 29");
  });

  it("Temporary employee whose contract extended to 40 days — ENROLLED from day 29", () => {
    const { resolution, result } = ks(1_000, {
      employmentCategory: "TEMPORARY",
      employmentStartDate: utc("2026-10-21"),
    });
    expect(resolution.status).toBe("ENROLLED");
    expect(resolution.autoEnrolTriggered).toBe(true);
    expect(result.employee).toBe(35.0); // default 3.5% applies
  });

  it("A temporary employee with no start date on record stays exempt", () => {
    const { resolution } = ks(1_000, { employmentCategory: "TEMPORARY" });
    expect(resolution.status).toBe("NOT_ENROLLED");
  });

  it("Casual agricultural worker, 2 months — NOT_ENROLLED", () => {
    const { resolution } = ks(1_000, {
      employmentCategory: "CASUAL_AGRICULTURAL",
      employmentStartDate: utc("2026-09-30"),
    });
    expect(resolution.status).toBe("NOT_ENROLLED");
  });

  it("Casual agricultural worker, 4 months — ENROLLED (auto-enrol trigger)", () => {
    const { resolution } = ks(1_000, {
      employmentCategory: "CASUAL_AGRICULTURAL",
      employmentStartDate: utc("2026-07-30"),
    });
    expect(resolution.status).toBe("ENROLLED");
    expect(resolution.autoEnrolTriggered).toBe(true);
  });

  it("The 3-month boundary is calendar-exact: 3 months exempt, 3 months + 1 day enrolled", () => {
    const exact3 = ks(1_000, {
      employmentCategory: "CASUAL_AGRICULTURAL",
      employmentStartDate: utc("2026-08-30"),
    });
    expect(exact3.resolution.status).toBe("NOT_ENROLLED");
    const threeMonthsOneDay = ks(1_000, {
      employmentCategory: "CASUAL_AGRICULTURAL",
      employmentStartDate: utc("2026-08-29"),
    });
    expect(threeMonthsOneDay.resolution.status).toBe("ENROLLED");
    expect(threeMonthsOneDay.resolution.autoEnrolTriggered).toBe(true);
  });

  it("An explicit election makes enrolment sticky — the time rules never re-trigger", () => {
    // A temporary employee enrolled by a previous run (persisted election)
    // resolves ENROLLED without the trigger flag.
    const { resolution } = ks(1_000, {
      employmentCategory: "TEMPORARY",
      employmentStartDate: utc("2026-10-31"),
      kiwiSaverRate: 0.035,
    });
    expect(resolution.status).toBe("ENROLLED");
    expect(resolution.autoEnrolTriggered).toBe(false);
  });

  it("NSW (recognised seasonal worker) — never eligible, regardless of election", () => {
    const { resolution, result } = ks(1_000, { taxCode: "NSW", kiwiSaverRate: 0.04 });
    expect(resolution.status).toBe("NOT_ELIGIBLE");
    expect(result.employee).toBe(0);
    expect(result.employerGross).toBe(0);
  });
});

describe("Task 1.2 — election statuses", () => {
  it("NOT_ENROLLED (Phase 3) — nothing deducted on either side, no auto-enrolment at hire", () => {
    // The admin-recorded "not in the scheme" election: even a PERMANENT
    // employee with no rate election stays NOT_ENROLLED (user matrix row
    // "Permanent, NOT_ENROLLED → $0").
    const { resolution, result } = ks(1_000, { kiwiSaverStatus: "NOT_ENROLLED" });
    expect(resolution.status).toBe("NOT_ENROLLED");
    expect(resolution.autoEnrolTriggered).toBe(false);
    expect(result.employee).toBe(0);
    expect(result.employerGross).toBe(0);
    expect(result.esct).toBe(0);
  });

  it("OPTED_OUT — nothing deducted on either side", () => {
    const { resolution, result } = ks(1_000, { kiwiSaverStatus: "OPTED_OUT" });
    expect(resolution.status).toBe("OPT_OUT");
    expect(result.employee).toBe(0);
    expect(result.employerGross).toBe(0);
    expect(result.esct).toBe(0);
  });

  it("ON_HOLIDAY — employee 0%, employer contribution continues with ESCT", () => {
    const { resolution, result } = ks(2_000, { kiwiSaverStatus: "ON_HOLIDAY", kiwiSaverRate: 0.04 });
    expect(resolution.status).toBe("ON_HOLIDAY");
    expect(result.employee).toBe(0);
    expect(result.employeeRate).toBe(0);
    expect(result.employerGross).toBe(70.0); // 3.5% compulsory continues
    // annual for ESCT: (2,000 + 70) × 12 = 24,840 → 17.5% tier
    expect(result.esctRate).toBe(0.175);
    expect(result.esct).toBe(12.25); // 70 × 0.175
    expect(result.employerNet).toBe(57.75);
  });

  it("NOT_ELIGIBLE without an election — nothing at all", () => {
    const { resolution, result } = ks(1_000, { kiwiSaverStatus: "NOT_ELIGIBLE" });
    expect(resolution.status).toBe("NOT_ELIGIBLE");
    expect(result.employee).toBe(0);
    expect(result.employerGross).toBe(0);
  });

  it("NOT_ELIGIBLE member who opted in — employee rate applies, employer contribution is voluntary", () => {
    // Under-18/65+ members (spec §4.3.2): employers are not required to make
    // compulsory contributions — only an explicitly elected rate applies.
    const optedIn = ks(2_000, { kiwiSaverStatus: "NOT_ELIGIBLE", kiwiSaverRate: 0.04 });
    expect(optedIn.result.status).toBe("ENROLLED");
    expect(optedIn.result.employee).toBe(80.0);
    expect(optedIn.result.employerGross).toBe(0);

    const withVoluntary = ks(2_000, {
      kiwiSaverStatus: "NOT_ELIGIBLE",
      kiwiSaverRate: 0.04,
      employerKiwiSaverRate: 0.03,
    });
    expect(withVoluntary.result.employerGross).toBe(60.0);
    expect(withVoluntary.result.employerRate).toBe(0.03);
  });
});

describe("Task 3.4 — autoEnrolDueDate (the profile editor's preview line)", () => {
  it("Temporary: day 29 = start + 28 days (1 March 2027 → 29 March 2027)", () => {
    const due = autoEnrolDueDate("TEMPORARY", utc("2027-03-01"));
    expect(due && due.toISOString().slice(0, 10)).toBe("2027-03-29");
  });

  it("Casual agricultural: the day after 3 whole calendar months", () => {
    const due = autoEnrolDueDate("CASUAL_AGRICULTURAL", utc("2026-08-30"));
    expect(due && due.toISOString().slice(0, 10)).toBe("2026-12-01");
  });

  it("Month-end starts clamp (31 Aug + 3 months → 30 Nov, +1 day → 1 Dec)", () => {
    const due = autoEnrolDueDate("CASUAL_AGRICULTURAL", utc("2026-08-31"));
    expect(due && due.toISOString().slice(0, 10)).toBe("2026-12-01");
  });

  it("Permanent and casual have no time rule; a missing start date has no due date", () => {
    expect(autoEnrolDueDate("PERMANENT", utc("2026-01-01"))).toBeNull();
    expect(autoEnrolDueDate("CASUAL", utc("2026-01-01"))).toBeNull();
    expect(autoEnrolDueDate("TEMPORARY", null)).toBeNull();
    expect(autoEnrolDueDate("CASUAL_AGRICULTURAL", null)).toBeNull();
  });

  it("the TEMPORARY due date drives the resolution — enrolled only from that date", () => {
    const start = utc("2026-11-02"); // day 29 = 2026-11-30
    const before = resolveKiwiSaverStatus(
      baseProfile({ employmentCategory: "TEMPORARY", employmentStartDate: start }),
      utc("2026-11-29"),
    );
    expect(before.status).toBe("NOT_ENROLLED");
    const on = resolveKiwiSaverStatus(
      baseProfile({ employmentCategory: "TEMPORARY", employmentStartDate: start }),
      utc("2026-11-30"),
    );
    expect(on.status).toBe("ENROLLED");
    expect(on.autoEnrolTriggered).toBe(true);
  });
});

describe("Task 1.2 — money calculation and ESCT", () => {
  it("default enrolment uses the rate-set default (3.5% FY2026-27)", () => {
    const { result } = ks(1_000, {});
    expect(result.employeeRate).toBe(0.035);
    expect(result.employee).toBe(35.0);
    expect(result.employerRate).toBe(0.035);
    expect(result.employerGross).toBe(35.0);
  });

  it("weekly $1,000 enrolled at 3.5% — full line set with 17.5% ESCT tier", () => {
    // annual for ESCT: (1,000 + 35) × 52 = 53,820 → 17.5% tier
    const { result } = ks(1_000, {}, "WEEKLY");
    expect(result.employee).toBe(35.0);
    expect(result.employerGross).toBe(35.0);
    expect(result.esctRate).toBe(0.175);
    expect(result.esct).toBe(6.13); // 35 × 0.175 = 6.125 → 6.13
    expect(result.employerNet).toBe(28.87); // 35 − 6.13 (lines sum)
    expect(result.esct + result.employerNet).toBe(result.employerGross);
  });

  it("10% election — employee at 10%, employer stays at the compulsory 3.5%", () => {
    const { result } = ks(2_000, { kiwiSaverRate: 0.1 });
    expect(result.employee).toBe(200.0);
    expect(result.employerGross).toBe(70.0);
    // annual for ESCT: (2,000 + 70) × 12 = 24,840 → 17.5% tier
    expect(result.esct).toBe(12.25);
    expect(result.employerNet).toBe(57.75);
  });

  it("the ESCT base includes the gross employer contribution (ITA YA 1)", () => {
    // annual 62,100 crosses into the 17.5% tier only because the employer
    // contribution is counted: 5,000×12 = 60,000 would stay at 17.5%…
    // but 62,100 vs 64,200 both sit in 17.5%; use 5,300 to straddle 64,200:
    // (5,300 + 185.50) × 12 = 65,826 → 30% tier, while 5,300 × 12 = 63,600
    // alone would be 17.5%.
    const { result } = ks(5_300, {});
    expect(result.employerGross).toBe(185.5);
    expect(result.esctRate).toBe(0.3);
    expect(result.esct).toBe(55.65); // 185.50 × 0.30
  });

  it("an elected employer rate overrides the compulsory rate", () => {
    const { result } = ks(1_000, { employerKiwiSaverRate: 0.06 });
    expect(result.employerGross).toBe(60.0);
  });

  it("a fixed ESCT override wins over the tier lookup", () => {
    const { result } = ks(1_000, { esctRateOverride: 0.3 });
    expect(result.esctRate).toBe(0.3);
    expect(result.esct).toBe(10.5); // 35 × 0.30
    expect(result.employerNet).toBe(24.5);
  });

  it("ESCT tier boundaries are inclusive on the upper dollar (IRD Table 1)", () => {
    expect(esctRateForAnnual(18_720, SET.esctTiers)).toBe(0.105);
    expect(esctRateForAnnual(18_720.01, SET.esctTiers)).toBe(0.175);
    expect(esctRateForAnnual(64_200, SET.esctTiers)).toBe(0.175);
    expect(esctRateForAnnual(64_200.01, SET.esctTiers)).toBe(0.3);
    expect(esctRateForAnnual(93_720, SET.esctTiers)).toBe(0.3);
    expect(esctRateForAnnual(93_720.01, SET.esctTiers)).toBe(0.33);
    expect(esctRateForAnnual(216_000, SET.esctTiers)).toBe(0.33);
    expect(esctRateForAnnual(1_000_000, SET.esctTiers)).toBe(0.39);
    expect(esctRateForAnnual(50_000, [])).toBe(0);
  });

  it("a rate set without KiwiSaver parameters degrades to zeros", () => {
    const profile = baseProfile({});
    const resolution = resolveKiwiSaverStatus(profile, PERIOD_END);
    const result = calculateKiwiSaver({
      gross: 1_000,
      frequency: "MONTHLY",
      taxProfile: profile,
      resolution,
      kiwiSaver: null,
      esctTiers: SET.esctTiers,
    });
    expect(result.employee).toBe(0);
    expect(result.employerGross).toBe(0);
    expect(result.reason).toContain("no KiwiSaver parameters");
  });
});
