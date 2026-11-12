import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Task 1.3 (revised) — student loan acceptance tests.
//
// Thresholds verified against the IRD spec §5.4 (weekly $464, fortnightly
// $928, monthly $2,010.66 — the annual $24,128 divided by pays-per-year
// and truncated to whole cents) and the IR341 monthly SL column
// ($2,010 → $0.00, $2,015 → $0.52, verified in Phase 0). Secondary income
// carries no threshold (IRD: "the repayment threshold does not apply to
// secondary income").
//
// Deviation from the draft spec, documented: the draft applied the STC
// certificate rate to every dollar with no threshold. IRD's spec §5.9 and
// its examples are explicit that for MAIN employment the special rate
// applies "in every dollar of earnings in excess of $464 per week" and the
// certificate states which treatment applies — the engine defaults to the
// main-employment form (threshold) and takes the secondary form
// (every dollar) via stcStudentLoanThresholdApplies = false. Both
// behaviours are tested below.
// ---------------------------------------------------------------------------

import {
  calculateStudentLoan,
  studentLoanPeriodThreshold,
} from "@/lib/payroll/nz/student-loan";
import { NzStatutoryError } from "@/lib/payroll/nz/types";
import { baseProfile, fy2026RateSet } from "./fixtures";

const SET = fy2026RateSet();

function sl(
  gross: number,
  frequency: "WEEKLY" | "FORTNIGHTLY" | "BIMONTHLY" | "MONTHLY" | "ANNUAL",
  code: string,
  extra: Record<string, unknown> = {},
) {
  return calculateStudentLoan({
    gross,
    frequency,
    taxProfile: baseProfile({ taxCode: code, ...extra }),
    studentLoan: SET.studentLoan,
  });
}

describe("Task 1.3 — acceptance scenarios", () => {
  it("M SL, monthly $3,000 — 12% above the $2,010.66 threshold", () => {
    // (3,000 − 2,010.66) × 12% = 989.34 × 0.12 = 118.7208 → 118.72
    expect(sl(3_000, "MONTHLY", "M SL")).toBe(118.72);
  });

  it("M SL, weekly $500 — 12% above the $464 threshold", () => {
    expect(sl(500, "WEEKLY", "M SL")).toBe(4.32);
  });

  it("S SL, monthly $3,000 — every dollar, no threshold", () => {
    expect(sl(3_000, "MONTHLY", "S SL")).toBe(360.0);
  });

  it("STC with an 8% certificate rate, main employment — above the threshold", () => {
    // (3,000 − 2,010.66) × 8% = 79.1472 → 79.15 (IRD spec §5.9 example one)
    expect(
      sl(3_000, "MONTHLY", "STC", {
        stcStudentLoanRate: 0.08,
        stcStudentLoanThresholdApplies: true,
      }),
    ).toBe(79.15);
  });

  it("STC with an 8% certificate rate, secondary certificate — every dollar", () => {
    // The draft table's $240.00 corresponds to the certificate-stated
    // secondary treatment (spec §5.9 example three).
    expect(
      sl(3_000, "MONTHLY", "STC", {
        stcStudentLoanRate: 0.08,
        stcStudentLoanThresholdApplies: false,
      }),
    ).toBe(240.0);
  });

  it("STC SL without a certificate rate falls back to the standard 12% above threshold", () => {
    expect(sl(3_000, "MONTHLY", "STC SL")).toBe(118.72);
  });

  it("the IR23 certificate is the SL authority for STC — no suffix needed", () => {
    // An IR23 tailored code covers both tax and student loan; the code is
    // plain "STC" (there is no "STC SL" on the IR330).
    expect(sl(3_000, "MONTHLY", "STC", { stcStudentLoanRate: 0.08 })).toBe(79.15);
    // A certificate rate on any other code is inert.
    expect(sl(3_000, "MONTHLY", "M", { stcStudentLoanRate: 0.08 })).toBe(0);
  });
});

describe("Task 1.3 — thresholds and boundaries", () => {
  it("per-period thresholds match the IRD spec §5.4 table", () => {
    expect(studentLoanPeriodThreshold("WEEKLY", SET.studentLoan!)).toBe(464);
    expect(studentLoanPeriodThreshold("FORTNIGHTLY", SET.studentLoan!)).toBe(928);
    expect(studentLoanPeriodThreshold("MONTHLY", SET.studentLoan!)).toBe(2_010.66);
    expect(studentLoanPeriodThreshold("QUARTERLY", SET.studentLoan!)).toBe(6_032);
    expect(studentLoanPeriodThreshold("ANNUAL", SET.studentLoan!)).toBe(24_128);
  });

  it("pay at or below the threshold deducts nothing; a dollar above starts", () => {
    expect(sl(464, "WEEKLY", "M SL")).toBe(0);
    expect(sl(463.99, "WEEKLY", "M SL")).toBe(0);
    expect(sl(465, "WEEKLY", "M SL")).toBe(0.12);
  });

  it("reproduces the IR341 monthly SL column rows verified in Phase 0", () => {
    expect(sl(2_010, "MONTHLY", "M SL")).toBe(0);
    expect(sl(2_015, "MONTHLY", "M SL")).toBe(0.52); // (2,015 − 2,010.66) × 12%
  });

  it("the monthly threshold truncates (2,010.66, not 2,010.67)", () => {
    // 2,010.67 is one cent above the truncated threshold → 0.0012 → $0.00
    expect(sl(2_010.67, "MONTHLY", "M SL")).toBe(0);
    expect(sl(2_010.69, "MONTHLY", "M SL")).toBe(0.00); // 0.03 × 12% = 0.0036 → 0.00
    expect(sl(2_011, "MONTHLY", "M SL")).toBe(0.04); // 0.34 × 12% = 0.0408
  });

  it("fortnightly and bimonthly thresholds divide correctly", () => {
    expect(sl(2_000, "FORTNIGHTLY", "M SL")).toBe(128.64); // (2,000 − 928) × 12%
    expect(sl(2_000, "BIMONTHLY", "M SL")).toBe(119.36); // (2,000 − 1,005.33) × 12%
  });

  it("ME SL rides the same threshold as M SL", () => {
    expect(sl(3_000, "MONTHLY", "ME SL")).toBe(118.72);
  });

  it("every secondary SL code taxes the full dollar", () => {
    expect(sl(1_000, "WEEKLY", "SB SL")).toBe(120.0);
    expect(sl(1_000, "WEEKLY", "SH SL")).toBe(120.0);
    expect(sl(1_000, "WEEKLY", "ST SL")).toBe(120.0);
    expect(sl(1_000, "WEEKLY", "SA SL")).toBe(120.0);
  });

  it("codes without an SL variant deduct nothing", () => {
    expect(sl(3_000, "MONTHLY", "ND SL")).toBe(0);
    expect(sl(3_000, "MONTHLY", "CAE SL")).toBe(0);
    expect(sl(3_000, "MONTHLY", "EDW SL")).toBe(0);
    expect(sl(3_000, "MONTHLY", "NSW SL")).toBe(0);
    expect(sl(3_000, "MONTHLY", "M")).toBe(0);
  });

  it("zero/negative gross and missing parameters produce no deduction", () => {
    expect(sl(0, "MONTHLY", "M SL")).toBe(0);
    expect(sl(-5, "MONTHLY", "M SL")).toBe(0);
    expect(
      calculateStudentLoan({
        gross: 3_000,
        frequency: "MONTHLY",
        taxProfile: baseProfile({ taxCode: "M SL" }),
        studentLoan: null,
      }),
    ).toBe(0);
  });

  it("certificate rates outside 0–12c throw", () => {
    expect(() => sl(3_000, "MONTHLY", "STC", { stcStudentLoanRate: 0.13 })).toThrowError(NzStatutoryError);
    expect(() => sl(3_000, "MONTHLY", "STC", { stcStudentLoanRate: -0.01 })).toThrowError(NzStatutoryError);
  });
});
