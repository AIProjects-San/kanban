// ---------------------------------------------------------------------------
// Phase 2 (payday filing) — the Employment Information (EI) file builder.
//
// Builds the myIR file-upload CSV: ONE HEI2 header (28 fields) + one DEI
// line (27 fields) per employee. Field order and every validation are
// CONFIRMED against IRD's Payday Filing File Upload Specification
// (2026-27, §3.4.1) and the myIR help page's field list + sample file:
//
//   HEI2  1 indicator 2 employer IRD 3 pay date 4 final return 5 nil
//        return 6 intermediary IRD 7 contact name 8 contact phone
//        9 contact email 10 employee lines 11 gross 12 prior gross adj
//        13 not-liable-ACC 14 PAYE 15 prior PAYE adj 16 child support
//        17 student loan 18 SLCIR 19 SLBOR 20 KiwiSaver deductions
//        21 net employer KiwiSaver 22 ESCT 23 total deducted 24 donations
//        25 family tax credit 26 share scheme 27 package id 28 form version
//   DEI  1 indicator 2 employee IRD 3 name 4 tax code 5 employment start
//        6 employment finish 7 period start 8 period end 9 pay cycle
//        10 hours paid 11 gross 12 prior gross adj 13 not-liable-ACC
//        14 lump sum 15 PAYE 16 prior PAYE adj 17 child support
//        18 child support code 19 student loan 20 SLCIR 21 SLBOR
//        22 KiwiSaver deductions 23 net employer KiwiSaver 24 ESCT
//        25 donations 26 family tax credit 27 share scheme
//
// PAYE (field 15) is INCOME TAX ONLY — the ACC earners' levy is a separate
// payslip line and is deliberately NOT filed here (IRd derives the levy);
// see the reconciliation module for the internal ACC cross-check.
//
// Hard assertions (all THROW — a warning that lets a bad file reach myIR
// burns a filing cycle):
//   1. Every HEI2 total equals the sum of its DEI lines.
//   2. Every amount is a non-negative integer (cents).
//   3. No field contains a comma or newline.
//   4. Every date is a valid CCYYMMDD calendar date.
//   5. At least one employee line (never generate a nil EI — the nil
//      return indicator exists for that).
//   6. Every employee IRD is 000000000 or spec-mod-11 valid.
//   7. A 000000000 IRD requires tax code ND.
//   8. PAYE ≤ gross per line.
//
// Pure: no DB, no clock, no filesystem.
// ---------------------------------------------------------------------------

import {
  assertCents,
  assertSafeText,
  ccyyMMdd,
  IrdFormatError,
  joinRecord,
} from "./format";
import { isUnsuppliedIrd, isValidEmployerIrdNumber, isValidIrdNumberForFiling, normaliseIrd } from "./ird-number";
import { fileTaxCode } from "./tax-code";
import { mapPayCycle } from "./pay-cycle";

/** The pay-date + contact block the header needs (from PayrollSettings). */
export interface EiHeaderInput {
  /** 9-digit employer IRD number (validated; never 000000000). */
  employerIrd: string;
  payDate: Date;
  /** Blank/null unless a registered PAYE intermediary files for the employer. */
  payeIntermediaryIrd: string | null;
  /** HEI2 field 7 — ≤ 20 chars, no commas. */
  contactName: string;
  /** HEI2 field 8 — ≤ 12 alphanumeric chars, no commas. */
  contactPhone: string;
  /** HEI2 field 9 — ≤ 60 chars, must look like an email. */
  contactEmail: string;
  /** HEI2 field 27 — ≤ 80 chars, no commas. */
  packageIdentifier: string;
  /** HEI2 field 28 — IRD requires exactly "0001". */
  irFormVersion: string;
}

/** One DEI line. Amounts and hours are ALREADY integer cents. */
export interface EiEmployeeLine {
  employeeIrd: string;
  /** "Surname Firstnames" — single space, no commas. */
  employeeName: string;
  taxCode: string;
  /** Set ONLY when the date falls inside the pay period being filed
   * (spec: otherwise leave blank). */
  employmentStart: Date | null;
  employmentEnd: Date | null;
  periodStart: Date;
  periodEnd: Date;
  /** Fernly cadence — mapped to the spec code here (throws on QUARTERLY/
   * ANNUAL, which have no confirmed code). */
  frequency: string;
  /** Hours × 100 (0 = not held — the spec's explicit default). */
  hoursPaidCents: number;
  /** Taxable gross earnings (the statutory engine's taxable gross). */
  grossCents: number;
  priorGrossAdjCents: number;
  /** Filed as 0 — the YTD ACC-cap excess is deferred (ADR-018). */
  notLiableAccCents: number;
  /** 0 | 1 exactly. */
  lumpSumIndicator: string;
  /** Income tax ONLY (ACC levy excluded). */
  payeCents: number;
  priorPayeAdjCents: number;
  childSupportCents: number;
  childSupportCode: string | null;
  studentLoanCents: number;
  slcirCents: number;
  slborCents: number;
  kiwisaverEmployeeCents: number;
  kiwisaverEmployerNetCents: number;
  esctCents: number;
  donationsCents: number;
  familyTaxCreditCents: number;
  shareSchemeCents: number;
}

/** The totals block, mirroring HEI2 fields 10–26 (all integer cents). */
export interface EiTotals {
  employeeLines: number;
  grossCents: number;
  priorGrossAdjCents: number;
  notLiableAccCents: number;
  payeCents: number;
  priorPayeAdjCents: number;
  childSupportCents: number;
  studentLoanCents: number;
  slcirCents: number;
  slborCents: number;
  kiwisaverEmployeeCents: number;
  kiwisaverEmployerNetCents: number;
  esctCents: number;
  /** (PAYE − donations) + CS + SL + KS + employer KS + ESCT + SLCIR +
   * SLBOR — the spec's HEI2 field 23 formula (payroll giving reduces the
   * PAYE component). */
  totalDeductedCents: number;
  donationsCents: number;
  familyTaxCreditCents: number;
  shareSchemeCents: number;
}

export interface EiFileInput {
  header: EiHeaderInput;
  lines: EiEmployeeLine[];
}

export interface BuiltEiFile {
  content: string;
  totals: EiTotals;
}

function sum(lines: EiEmployeeLine[], pick: (l: EiEmployeeLine) => number): number {
  return lines.reduce((acc, l) => acc + pick(l), 0);
}

/** Build + validate the whole EI file. Throws IrdFormatError on any
 * structural problem; returns the exact file content and the totals. */
export function buildEiFile(input: EiFileInput): BuiltEiFile {
  const h = input.header;

  // ---- Header fixed fields -------------------------------------------------
  const employerIrd = normaliseIrd(assertSafeText(h.employerIrd, "HEI2 field 2 (employer IRD)", { required: true, maxLength: 9 }));
  if (!isValidEmployerIrdNumber(employerIrd)) {
    throw new IrdFormatError(`HEI2 field 2: "${h.employerIrd}" is not a valid employer IRD number — update the payroll filing settings before generating.`);
  }
  const payDate = ccyyMMdd(h.payDate, "HEI2 field 3 (pay date)");
  const contactName = assertSafeText(h.contactName, "HEI2 field 7 (payroll contact name)", { required: true, maxLength: 20 });
  const contactPhone = assertSafeText(h.contactPhone, "HEI2 field 8 (contact phone)", { required: true, maxLength: 12 });
  if (!/^[A-Za-z0-9]+$/.test(contactPhone)) {
    throw new IrdFormatError(`HEI2 field 8: the contact phone "${contactPhone}" must be 12 alphanumeric characters or fewer with no spaces or symbols.`);
  }
  const contactEmail = assertSafeText(h.contactEmail, "HEI2 field 9 (contact email)", { required: true, maxLength: 60 });
  if (!/^[A-Za-z0-9@._-]+$/.test(contactEmail) || !contactEmail.includes("@") || contactEmail.startsWith("@") || contactEmail.endsWith("@") || contactEmail.includes("..")) {
    throw new IrdFormatError(`HEI2 field 9: "${contactEmail}" is not a valid email address.`);
  }
  const intermediaryRaw = (h.payeIntermediaryIrd ?? "").trim();
  let intermediary = "";
  if (intermediaryRaw !== "") {
    intermediary = normaliseIrd(intermediaryRaw);
    if (isUnsuppliedIrd(intermediary) || !isValidIrdNumberForFiling(intermediary)) {
      throw new IrdFormatError(`HEI2 field 6: "${intermediaryRaw}" is not a valid PAYE intermediary IRD number — leave it blank if no intermediary files for this employer.`);
    }
  }
  const packageId = assertSafeText(h.packageIdentifier, "HEI2 field 27 (payroll package identifier)", { required: true, maxLength: 80 });
  const formVersion = assertSafeText(h.irFormVersion, "HEI2 field 28 (IR form version)", { required: true, maxLength: 4 });
  if (formVersion !== "0001") {
    throw new IrdFormatError(`HEI2 field 28: the IR form version must be "0001" (got "${formVersion}").`);
  }

  // ---- Detail lines ---------------------------------------------------------
  // Assertion 5 — never generate a nil EI (the nil-return indicator on a
  // hand-written HEI2 exists for that; a software-generated empty file is
  // always a bug upstream).
  if (input.lines.length < 1) {
    throw new IrdFormatError("Cannot generate an Employment Information file with no employee lines — file a nil return in myIR instead.");
  }

  const detailFields: string[] = [];
  for (const [idx, l] of input.lines.entries()) {
    const where = `DEI line ${idx + 1} (${l.employeeName || "unknown employee"})`;

    // Field 2 — IRD (assertions 6 + 7).
    const ird = normaliseIrd(l.employeeIrd ?? "");
    if (isUnsuppliedIrd(ird)) {
      // Allowed, but only with the ND tax code.
      const code = l.taxCode.trim();
      if (code !== "ND") {
        throw new IrdFormatError(`${where}: the employee has no IRD number, so the tax code must be ND (non-notified) — got "${code}".`);
      }
    } else if (!isValidIrdNumberForFiling(ird)) {
      throw new IrdFormatError(`${where}: "${l.employeeIrd}" is not a valid IRD number (mod-11 check failed) — fix the employee's tax profile before filing.`);
    }

    // Field 3 — name ("Surname Firstnames", ≤ 255, no commas).
    const name = assertSafeText(l.employeeName, `${where} field 3 (employee name)`, { required: true, maxLength: 255 });
    if (!name.trim().includes(" ")) {
      throw new IrdFormatError(`${where} field 3: the employee name "${name}" must be "Surname Firstnames" — a single word cannot be filed.`);
    }

    // Field 4 — tax code (validated against the spec's closed set).
    const taxCode = fileTaxCode(l.taxCode);

    // Fields 5–8 — dates (assertion 4; employment dates are optional but
    // must be real dates when present).
    const empStart = l.employmentStart ? ccyyMMdd(l.employmentStart, `${where} field 5 (employment start)`) : "";
    const empEnd = l.employmentEnd ? ccyyMMdd(l.employmentEnd, `${where} field 6 (employment finish)`) : "";
    const periodStart = ccyyMMdd(l.periodStart, `${where} field 7 (pay period start)`);
    const periodEnd = ccyyMMdd(l.periodEnd, `${where} field 8 (pay period end)`);
    if (parseGuaranteed(periodStart) >= parseGuaranteed(periodEnd)) {
      throw new IrdFormatError(`${where}: the pay period start (${periodStart}) must be before the pay period end (${periodEnd}).`);
    }

    // Field 9 — pay cycle (spec-confirmed code; throws on unmapped cadence).
    const payCycle = mapPayCycle(l.frequency);

    // Field 10 — hours paid (× 100; 0 = not held).
    const hours = assertCents(l.hoursPaidCents, `${where} field 10 (hours paid)`);

    // Fields 11–27 — amounts (assertion 2: integer, non-negative).
    const gross = assertCents(l.grossCents, `${where} field 11 (gross earnings)`);
    const priorGross = assertCents(l.priorGrossAdjCents, `${where} field 12 (prior gross adjustment)`);
    const notLiable = assertCents(l.notLiableAccCents, `${where} field 13 (earnings not liable for ACC)`);
    const lump = l.lumpSumIndicator === "1" ? "1" : l.lumpSumIndicator === "0" ? "0" : null;
    if (lump === null) {
      throw new IrdFormatError(`${where} field 14: the lump sum indicator must be exactly 0 or 1 (got "${l.lumpSumIndicator}").`);
    }
    if (notLiable > gross) {
      throw new IrdFormatError(`${where} field 13: earnings not liable for ACC (${notLiable}) cannot exceed gross earnings (${gross}).`);
    }
    const paye = assertCents(l.payeCents, `${where} field 15 (PAYE)`);
    const priorPaye = assertCents(l.priorPayeAdjCents, `${where} field 16 (prior PAYE adjustment)`);
    const childSupport = assertCents(l.childSupportCents, `${where} field 17 (child support)`);
    const csCode = l.childSupportCode ? assertSafeText(l.childSupportCode, `${where} field 18 (child support code)`, { maxLength: 1 }) : "";
    if (csCode !== "" && !"ACDOPS".includes(csCode)) {
      throw new IrdFormatError(`${where} field 18: child support code must be blank or one of A, C, D, O, P, S (got "${csCode}").`);
    }
    const studentLoan = assertCents(l.studentLoanCents, `${where} field 19 (student loan)`);
    const slcir = assertCents(l.slcirCents, `${where} field 20 (SLCIR)`);
    const slbor = assertCents(l.slborCents, `${where} field 21 (SLBOR)`);
    const ks = assertCents(l.kiwisaverEmployeeCents, `${where} field 22 (KiwiSaver deductions)`);
    const ksEmployer = assertCents(l.kiwisaverEmployerNetCents, `${where} field 23 (net employer KiwiSaver)`);
    const esct = assertCents(l.esctCents, `${where} field 24 (ESCT)`);
    const donations = assertCents(l.donationsCents, `${where} field 25 (payroll donations)`);
    const ftc = assertCents(l.familyTaxCreditCents, `${where} field 26 (family tax credit)`);
    const ess = assertCents(l.shareSchemeCents, `${where} field 27 (employee share scheme)`);

    // Assertion 8 — PAYE cannot exceed gross (income tax only, so the
    // ACC levy never trips this even at the ND 46.75% combined rate).
    if (paye > gross) {
      throw new IrdFormatError(`${where}: PAYE (${paye}) cannot exceed gross earnings (${gross}).`);
    }
    // The spec's companion rule: donations are capped by PAYE.
    if (donations > paye) {
      throw new IrdFormatError(`${where}: tax credits for payroll donations (${donations}) cannot exceed PAYE (${paye}).`);
    }

    detailFields.push(joinRecord([
      "DEI", ird, name, taxCode, empStart, empEnd, periodStart, periodEnd,
      payCycle, hours, gross, priorGross, notLiable, lump, paye, priorPaye,
      childSupport, csCode, studentLoan, slcir, slbor, ks, ksEmployer, esct,
      donations, ftc, ess,
    ]));
  }

  // ---- Totals (assertion 1 — computed FROM the validated lines, so the
  // header can never disagree with the detail it froze). ----------------------
  const totals: EiTotals = {
    employeeLines: input.lines.length,
    grossCents: sum(input.lines, (l) => l.grossCents),
    priorGrossAdjCents: sum(input.lines, (l) => l.priorGrossAdjCents),
    notLiableAccCents: sum(input.lines, (l) => l.notLiableAccCents),
    payeCents: sum(input.lines, (l) => l.payeCents),
    priorPayeAdjCents: sum(input.lines, (l) => l.priorPayeAdjCents),
    childSupportCents: sum(input.lines, (l) => l.childSupportCents),
    studentLoanCents: sum(input.lines, (l) => l.studentLoanCents),
    slcirCents: sum(input.lines, (l) => l.slcirCents),
    slborCents: sum(input.lines, (l) => l.slborCents),
    kiwisaverEmployeeCents: sum(input.lines, (l) => l.kiwisaverEmployeeCents),
    kiwisaverEmployerNetCents: sum(input.lines, (l) => l.kiwisaverEmployerNetCents),
    esctCents: sum(input.lines, (l) => l.esctCents),
    totalDeductedCents: 0, // filled below
    donationsCents: sum(input.lines, (l) => l.donationsCents),
    familyTaxCreditCents: sum(input.lines, (l) => l.familyTaxCreditCents),
    shareSchemeCents: sum(input.lines, (l) => l.shareSchemeCents),
  };
  totals.totalDeductedCents =
    totals.payeCents - totals.donationsCents +
    totals.childSupportCents + totals.studentLoanCents +
    totals.kiwisaverEmployeeCents + totals.kiwisaverEmployerNetCents +
    totals.esctCents + totals.slcirCents + totals.slborCents;
  if (totals.totalDeductedCents < 0) {
    throw new IrdFormatError("HEI2 field 23: total amounts deducted computed negative — donations exceed PAYE across the return.");
  }

  const headerRecord = joinRecord([
    "HEI2", employerIrd, payDate, "N", "N", intermediary,
    contactName, contactPhone, contactEmail,
    totals.employeeLines,
    totals.grossCents, totals.priorGrossAdjCents, totals.notLiableAccCents,
    totals.payeCents, totals.priorPayeAdjCents, totals.childSupportCents,
    totals.studentLoanCents, totals.slcirCents, totals.slborCents,
    totals.kiwisaverEmployeeCents, totals.kiwisaverEmployerNetCents,
    totals.esctCents, totals.totalDeductedCents, totals.donationsCents,
    totals.familyTaxCreditCents, totals.shareSchemeCents,
    packageId, formVersion,
  ]);

  const content = [headerRecord, ...detailFields].join("\n") + "\n";

  // Final belt-and-braces: the whole file is comma/newline structurally
  // sound by construction (joinRecord is the only comma source), but a
  // line-count + field-count audit is cheap and catches regressions.
  const outLines = content.split("\n").filter((l) => l !== "");
  if (outLines.length !== 1 + input.lines.length) {
    throw new IrdFormatError("Internal error: built line count does not match the input — refusing to emit.");
  }
  for (const [i, line] of outLines.entries()) {
    const fields = line.split(",").length;
    const expected = i === 0 ? 28 : 27;
    if (fields !== expected) {
      throw new IrdFormatError(`Internal error: line ${i + 1} has ${fields} fields (expected ${expected}) — refusing to emit.`);
    }
  }

  return { content, totals };
}

/** ccyyMMdd output is always parseable — a tiny helper for comparisons. */
function parseGuaranteed(raw: string): number {
  return Number(raw);
}
