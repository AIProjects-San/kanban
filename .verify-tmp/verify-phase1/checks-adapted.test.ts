// ADAPTED from the verification spec's /tmp/verify-phase1/checks.test.ts.
// Same 20 checks, same expected values. Adaptations (spec assumed an older
// API/data model):
//   1. Rate set loaded via StatutoryRule + relations (payeTiers/secondaryRates/
//      accLevy/kiwiSaver/esctTiers/studentLoan) — TaxSlab has no taxYearId.
//   2. calculatePaye input: payeTiers/secondaryRates/accLevy (not slabs/accRule).
//   3. STC rate on the 0–1 scale (0.18, not 18 — engine validates 0–1).
//   4. calculateStudentLoan: studentLoan param (legacy periodThresholds/
//      standardRate input was deleted in the Phase 1A gap closure).
//   5. Profile shape: NzTaxProfileInput (employmentCategory, isCasual,
//      kiwiSaverRate 0–1 scale, stcStudentLoanThresholdApplies).
//   6. calculateKiwiSaver: resolution + kiwiSaver + esctTiers params.
import { calculatePaye } from "../../src/lib/payroll/nz/paye";
import { calculateKiwiSaver, resolveKiwiSaverStatus, resolveKiwiSaverDecision } from "../../src/lib/payroll/nz/kiwisaver";
import { calculateStudentLoan } from "../../src/lib/payroll/nz/student-loan";
import type { NzTaxProfileInput } from "../../src/lib/payroll/nz/types";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
let pass = 0, fail = 0;
const r2 = (n: number) => Math.round(n * 100) / 100;
const t = (label: string, actual: any, expected: any) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log(`PASS  ${label}`); }
  else    { fail++; console.log(`FAIL  ${label}  expected=${JSON.stringify(expected)} got=${JSON.stringify(actual)}`); }
};

async function main() {
  const set = await prisma.statutoryRule.findFirst({
    where: { isCurrent: true },
    include: { payeTiers: true, secondaryRates: true, accLevy: true, kiwiSaver: true, esctTiers: true, studentLoan: true },
  });
  if (!set) { console.log("FAIL  current StatutoryRule rate set missing"); process.exit(1); }
  const slabs = set.payeTiers.map((s: any) => ({ fromAnnual: s.fromAnnual, toAnnual: s.toAnnual, rate: s.rate }));
  const secondaryRates = set.secondaryRates.map((s: any) => ({ code: s.code, rate: s.rate, accInclusive: s.accInclusive }));
  const accLevy = { rate: set.accLevy!.rate, maxEarnings: set.accLevy!.maxEarnings, maxLevy: set.accLevy!.maxLevy };
  const ksAllowedRaw = set.kiwiSaver?.allowedEmployeeRates;
  const ksAllowed = typeof ksAllowedRaw === "string" ? JSON.parse(ksAllowedRaw) : ksAllowedRaw;
  const kiwiSaver = set.kiwiSaver
    ? { defaultEmployeeRate: set.kiwiSaver.defaultEmployeeRate, allowedEmployeeRates: ksAllowed, employerRate: set.kiwiSaver.employerRate }
    : null;
  const esctTiers = set.esctTiers.map((s: any) => ({ fromAnnual: s.fromAnnual, toAnnual: s.toAnnual, rate: s.rate }));
  const studentLoan = set.studentLoan ? { rate: set.studentLoan.rate, annualThreshold: set.studentLoan.annualThreshold } : null;

  const mk = (o: Partial<NzTaxProfileInput> = {}): NzTaxProfileInput => ({
    taxCode: "M", isCasual: false, employmentCategory: "PERMANENT",
    employmentStartDate: null, casualHolidayPayInWages: false,
    // ACTIVE + no explicit rate = the auto-enrolment posture (the time
    // rules apply). "NOT_ENROLLED" is the admin-recorded election that
    // never auto-enrols — the spec's default predates that vocabulary.
    kiwiSaverStatus: "ACTIVE", kiwiSaverRate: null, employerKiwiSaverRate: null,
    esctRateOverride: null, taxCodeSpecialRate: null, stcAccTreatment: "INC",
    stcStudentLoanRate: null, stcStudentLoanThresholdApplies: true,
    autoEnrolExemption: null, ...o,
  });

  const paye = (gross: number, freq: any, p: NzTaxProfileInput = mk()) => {
    const r = calculatePaye({ gross, frequency: freq, taxProfile: p, payeTiers: slabs, secondaryRates, accLevy });
    return { tax: r2(r.tax), acc: r2(r.acc), total: r2(r.total) };
  };

  // Primary codes
  t("M weekly $1,000",       paye(1000, "WEEKLY"),      { tax: 154.00,  acc: 17.50,   total: 171.50 });
  t("M monthly $5,000",      paye(5000, "MONTHLY"),     { tax: 851.71,  acc: 87.50,   total: 939.21 });
  t("M annual $156,641 cap", paye(156641, "ANNUAL"),    { tax: 41569.03,acc: 2741.22, total: 44310.25 });
  t("M annual $200,000 cap", paye(200000, "ANNUAL"),    { tax: 57077.50,acc: 2741.22, total: 59818.72 });

  // Secondary codes — COMBINED rates
  t("SB weekly $1,000",      paye(1000, "WEEKLY", mk({ taxCode: "SB" })),     { tax: 122.50,  acc: 0, total: 122.50 });
  t("S weekly $1,000",       paye(1000, "WEEKLY", mk({ taxCode: "S" })),      { tax: 192.50,  acc: 0, total: 192.50 });
  t("SH weekly $1,000",      paye(1000, "WEEKLY", mk({ taxCode: "SH" })),     { tax: 317.50,  acc: 0, total: 317.50 });
  t("ST weekly $1,000",      paye(1000, "WEEKLY", mk({ taxCode: "ST" })),     { tax: 347.50,  acc: 0, total: 347.50 });
  t("SA weekly $1,000",      paye(1000, "WEEKLY", mk({ taxCode: "SA" })),     { tax: 407.50,  acc: 0, total: 407.50 });
  t("ND weekly $1,000",      paye(1000, "WEEKLY", mk({ taxCode: "ND" })),     { tax: 467.50,  acc: 0, total: 467.50 });
  t("CAE weekly $1,000",     paye(1000, "WEEKLY", mk({ taxCode: "CAE" })),    { tax: 192.50,  acc: 0, total: 192.50 });

  // STC (rate on the 0–1 scale)
  t("STC 18% INC $5,000",    paye(5000, "MONTHLY", mk({ taxCode: "STC", taxCodeSpecialRate: 0.18, stcAccTreatment: "INC" })),  { tax: 900.00, acc: 0, total: 900.00 });
  t("STC 18% PLUS $5,000",   paye(5000, "MONTHLY", mk({ taxCode: "STC", taxCodeSpecialRate: 0.18, stcAccTreatment: "PLUS" })), { tax: 900.00, acc: 87.50, total: 987.50 });

  // KiwiSaver (enrolled 3.5/3.5, ESCT override 17.5%)
  const ksProfile = mk({ kiwiSaverStatus: "ACTIVE", kiwiSaverRate: 0.035, employerKiwiSaverRate: 0.035, esctRateOverride: 0.175 });
  const resolution = resolveKiwiSaverDecision(ksProfile, new Date("2027-01-31"));
  const ks = calculateKiwiSaver({ gross: 5000, frequency: "MONTHLY", taxProfile: ksProfile, resolution, kiwiSaver, esctTiers });
  t("KS 3.5% enrolled", { employee: r2(ks.employee), employerGross: r2(ks.employerGross), esct: r2(ks.esct), employerNet: r2(ks.employerNet) },
                        { employee: 175.00, employerGross: 175.00, esct: 30.63, employerNet: 144.37 });

  // Casual auto-enrol
  const pEnd = new Date("2027-01-31");
  t("Temp 20 days",     resolveKiwiSaverStatus(mk({ employmentCategory: "TEMPORARY", employmentStartDate: new Date("2027-01-11") }), pEnd), "NOT_ENROLLED");
  t("Temp 30 days",     resolveKiwiSaverStatus(mk({ employmentCategory: "TEMPORARY", employmentStartDate: new Date("2027-01-01") }), pEnd), "ENROLLED");
  t("Casual agri 2mo",  resolveKiwiSaverStatus(mk({ employmentCategory: "CASUAL_AGRICULTURAL", employmentStartDate: new Date("2026-11-30") }), pEnd), "NOT_ENROLLED");
  t("Casual agri 4mo",  resolveKiwiSaverStatus(mk({ employmentCategory: "CASUAL_AGRICULTURAL", employmentStartDate: new Date("2026-09-15") }), pEnd), "ENROLLED");

  // Student loan (canonical params; threshold computed = 2010.66 monthly / 464 weekly)
  t("M SL monthly $3,000", r2(calculateStudentLoan({ gross: 3000, frequency: "MONTHLY", taxProfile: mk({ taxCode: "M SL" }), studentLoan })), 118.72);
  t("S SL monthly $3,000", r2(calculateStudentLoan({ gross: 3000, frequency: "MONTHLY", taxProfile: mk({ taxCode: "S SL" }), studentLoan })), 360.00);

  console.log(`\nCALC CHECKS: PASS=${pass} FAIL=${fail}`);
  process.exit(fail > 0 ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
