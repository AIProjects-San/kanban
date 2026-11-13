// ---------------------------------------------------------------------------
// Phase 2 — the reconciliation core: the 8 checks that must pass before
// an EI file may be generated. Injected mismatches must refuse.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { runReconciliation, reconciliationRefusalMessage, RECONCILE_ACCOUNT_CODES } from "../reconciliation";
import type { PayslipStatutoryT } from "@/lib/types";

const snap = (tax: number, acc: number, ks: number, sl: number, gross: number): PayslipStatutoryT => ({
  taxCode: "M",
  rateSetId: "rs",
  rateSetLabel: "FY2026-27",
  ruleVersion: "v1",
  frequency: "MONTHLY",
  payPeriodEnd: "2026-10-31",
  taxableGross: gross,
  defaultedProfile: false,
  paye: { tax, acc, total: tax + acc, method: "ANNUALISED", ietc: 0, annualised: gross * 12 },
  kiwiSaver: {
    status: "ACTIVE", reason: "", autoEnrolTriggered: false,
    employee: ks, employerGross: ks, esct: 10, employerNet: ks - 10,
    employeeRate: 0.035, employerRate: 0.035, esctRate: 0.175,
  },
  studentLoan: sl,
  statutoryNet: gross - tax - acc - ks - sl,
});

function lines(): string {
  // Deduction JSON: the line keys the GL posted from.
  return JSON.stringify([
    { key: "paye", label: "PAYE income tax (M)", amount: 851.71 },
    { key: "acc", label: "ACC earners' levy", amount: 87.5 },
    { key: "ks", label: "KiwiSaver employee 3.5%", amount: 175 },
    { key: "sl", label: "Student loan repayment", amount: 60 },
  ]);
}

const PAYSLIPS = [
  {
    payslipId: "ps-1",
    runId: "run-1",
    deductions: lines(),
    employerKiwiSaverNet: 165,
    employerEsct: 10,
    statutory: snap(851.71, 87.5, 175, 60, 5000),
  },
  {
    payslipId: "ps-2",
    runId: "run-1",
    deductions: lines(),
    employerKiwiSaverNet: 165,
    employerEsct: 10,
    statutory: snap(851.71, 87.5, 175, 60, 5000),
  },
];

/** Totals that agree with PAYSLIPS to the cent. */
const AGREEING_TOTALS = {
  payeCents: 170342, // 2 × 851.71
  kiwisaverEmployeeCents: 35000, // 2 × 175
  kiwisaverEmployerNetCents: 33000, // 2 × 165
  esctCents: 2000, // 2 × 10
  studentLoanCents: 12000, // 2 × 60
  grossCents: 1000000, // 2 × 5000
};

const AGREEING_JE = new Map<string, number>([
  [RECONCILE_ACCOUNT_CODES.PAYE, 851.71 * 2], // 2100
  ["2110", 87.5 * 2], // ACC — not a filed check, logged only
  [RECONCILE_ACCOUNT_CODES.KIWISAVER_EMPLOYEE, 175 * 2], // 2120
  [RECONCILE_ACCOUNT_CODES.KIWISAVER_EMPLOYER, 165 * 2], // 2130
  [RECONCILE_ACCOUNT_CODES.ESCT, 10 * 2], // 2140
  [RECONCILE_ACCOUNT_CODES.STUDENT_LOAN, 60 * 2], // 2150
]);

describe("runReconciliation — all 8 checks", () => {
  it("passes cleanly when payslips, filing totals and the posted JE agree to the cent", () => {
    const report = runReconciliation({
      filingId: "prospective",
      totals: AGREEING_TOTALS,
      payslips: PAYSLIPS,
      journalCredits: AGREEING_JE,
    });
    expect(report.allPass).toBe(true);
    expect(report.checks).toHaveLength(12); // 7 + 5 ledger pairs
    expect(report.accLevyCents).toBe(17500); // 2 × 87.50 — logged, never filed
    expect(report.runIds).toEqual(["run-1"]);
  });

  it("check 1 — a PAYE mismatch between the payslip lines and the filed total fails", () => {
    const report = runReconciliation({
      filingId: "prospective",
      totals: { ...AGREEING_TOTALS, payeCents: 170341 }, // 1c off
      payslips: PAYSLIPS,
      journalCredits: AGREEING_JE,
    });
    expect(report.allPass).toBe(false);
    const check1 = report.checks.find((c) => c.index === 1)!;
    expect(check1.pass).toBe(false);
    expect(reconciliationRefusalMessage(report)).toContain("Check 1");
    expect(reconciliationRefusalMessage(report)).toContain("off by 1c");
  });

  it("check 2 — the ACC levy is logged for internal reconciliation and never filed", () => {
    const report = runReconciliation({
      filingId: "prospective",
      totals: AGREEING_TOTALS,
      payslips: PAYSLIPS,
      journalCredits: AGREEING_JE,
    });
    const check2 = report.checks.find((c) => c.index === 2)!;
    expect(check2.pass).toBe(true);
    expect(check2.filingCents).toBe(0);
    expect(check2.sourceCents).toBe(17500);
    expect(check2.note).toContain("Total logged");
  });

  it("checks 3-6 — KiwiSaver / ESCT / student loan mismatches each fail their check", () => {
    for (const key of ["kiwisaverEmployeeCents", "kiwisaverEmployerNetCents", "esctCents", "studentLoanCents"] as const) {
      const report = runReconciliation({
        filingId: "prospective",
        totals: { ...AGREEING_TOTALS, [key]: AGREEING_TOTALS[key] + 500 },
        payslips: PAYSLIPS,
        journalCredits: AGREEING_JE,
      });
      expect(report.allPass).toBe(false);
      expect(report.checks.filter((c) => !c.pass).length).toBeGreaterThanOrEqual(1);
    }
  });

  it("check 7 — the filed gross must equal the statutory TAXABLE gross (not the payslip headline gross)", () => {
    const report = runReconciliation({
      filingId: "prospective",
      totals: { ...AGREEING_TOTALS, grossCents: 1000500 }, // payslip.gross with a non-taxable allowance
      payslips: PAYSLIPS,
      journalCredits: AGREEING_JE,
    });
    const check7 = report.checks.find((c) => c.index === 7)!;
    expect(check7.pass).toBe(false);
  });

  it("check 8 — the JE credits must equal the filed totals per account (2100↔f15, 2120↔f22, 2130↔f23, 2140↔f24, 2150↔f19)", () => {
    // Drop the 2100 credit entirely (an unposted run).
    const noPaye = new Map(AGREEING_JE);
    noPaye.delete(RECONCILE_ACCOUNT_CODES.PAYE);
    const report = runReconciliation({
      filingId: "prospective",
      totals: AGREEING_TOTALS,
      payslips: PAYSLIPS,
      journalCredits: noPaye,
    });
    expect(report.allPass).toBe(false);
    const failed = report.checks.filter((c) => c.index === 8 && !c.pass);
    expect(failed).toHaveLength(1);
    expect(failed[0].label).toContain("2100");
    expect(reconciliationRefusalMessage(report)).toContain("JournalEntry credits 2100");
  });

  it("a missing statutory snapshot is a hard error (the slip can never be filed)", () => {
    expect(() =>
      runReconciliation({
        filingId: "prospective",
        totals: AGREEING_TOTALS,
        payslips: [{ ...PAYSLIPS[0], statutory: null }],
        journalCredits: AGREEING_JE,
      }),
    ).toThrow(/no statutory snapshot/i);
  });

  it("the refusal message names every failed check with its cent difference", () => {
    const report = runReconciliation({
      filingId: "prospective",
      totals: { ...AGREEING_TOTALS, payeCents: 1, studentLoanCents: 2 },
      payslips: PAYSLIPS,
      journalCredits: new Map(),
    });
    const msg = reconciliationRefusalMessage(report);
    expect(msg).toContain("refusing to generate");
    expect(msg).toContain("Check 1");
    expect(msg).toContain("Check 6");
    expect(msg).toContain("Check 8");
    expect(msg).toContain("Correct the underlying payslips");
  });
});
