// ---------------------------------------------------------------------------
// Phase 2 (payday filing) — the Employment Information Amendment (EIA2)
// file builder.
//
// Corrects a FILED EI return (spec §3.5, confirmed field-by-field):
//
//   EIA2  7 fields: 1 indicator 2 employer IRD 3 pay date (of the
//        ORIGINAL payment) 4 PAYE intermediary IRD 5 payroll contact name
//        6 payroll contact phone 7 IR form version (0001). NOTE: unlike
//        the HEI2 there is NO email field and NO totals block.
//   DTI   the ORIGINAL line as filed — 27 fields, SAME order as DEI
//        (employment start/finish fields 5/6 ARE present and optional;
//        hours paid field 10 present since April 2021).
//   DAI   the AMENDED line — 27 fields, same order.
//
// Pairing rules (spec §3.5 + the myIR error catalogue):
//   • Every DAI must be immediately preceded by its DTI (contiguous).
//   • ADD a line the original return did not have: nil DTI (blank text
//     fields, zero amounts) + DAI with the new values.
//   • DELETE a line: DTI with the filed values + nil DAI.
//   • UPDATE a line: DTI with the filed values + DAI with corrections.
//   • An EIA2 may only amend a paydate whose EI was already filed.
//
// The DTI side is reconstructed from the PaydayFilingLine rows frozen at
// generation time — exactly what the uploaded file contained (fileHash
// proves it), never re-derived from payslips that may have moved on.
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
import { mapPayCycle } from "./pay-cycle";
import { fileTaxCode } from "./tax-code";

/** The 27-field money/identity block shared by DEI/DTI/DAI. Same shape
 * as EiEmployeeLine from ei-file.ts — re-declared locally so the
 * amendment module owns its contract explicitly (the two builders must
 * not drift, and the field-count tests pin both to 27). */
export interface AmendmentLineValues {
  employeeIrd: string;
  employeeName: string;
  taxCode: string;
  employmentStart: Date | null;
  employmentEnd: Date | null;
  periodStart: Date;
  periodEnd: Date;
  frequency: string;
  hoursPaidCents: number;
  grossCents: number;
  priorGrossAdjCents: number;
  notLiableAccCents: number;
  lumpSumIndicator: string;
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

export interface AmendmentHeaderInput {
  employerIrd: string;
  /** The pay date of the ORIGINAL filing being amended. */
  payDate: Date;
  payeIntermediaryIrd: string | null;
  contactName: string;
  contactPhone: string;
  irFormVersion: string;
}

/** One correction. `original` null = add a new employee line;
 * `amended` null = delete the line; both present = update. */
export interface AmendmentCorrection {
  original: AmendmentLineValues | null;
  amended: AmendmentLineValues | null;
}

export interface BuiltAmendmentFile {
  content: string;
  pairCount: number;
}

/** The nil record IRD's own examples use: blank identity, zero amounts,
 * blank child-support code — 27 fields exactly (fields 2–9 blank, hours
 * (field 10) 0, seven money zeros, blank CS code, nine tail zeros). */
function nilRecord(indicator: "DTI" | "DAI"): string {
  return joinRecord([
    indicator, "", "", "", "", "", "", "", "",
    0, 0, 0, 0, 0, 0, 0, 0, "",
    0, 0, 0, 0, 0, 0, 0, 0, 0,
  ]);
}

/** Serialize one 27-field DTI/DAI record from validated values. */
function detailRecord(indicator: "DTI" | "DAI", l: AmendmentLineValues, where: string): string {
  const ird = normaliseIrd(l.employeeIrd ?? "");
  if (isUnsuppliedIrd(ird)) {
    if (l.taxCode.trim() !== "ND") {
      throw new IrdFormatError(`${where} (${indicator}): the employee has no IRD number, so the tax code must be ND — got "${l.taxCode}".`);
    }
  } else if (!isValidIrdNumberForFiling(ird)) {
    throw new IrdFormatError(`${where} (${indicator}): "${l.employeeIrd}" is not a valid IRD number (mod-11 check failed).`);
  }
  const name = assertSafeText(l.employeeName, `${where} (${indicator}) employee name`, { required: true, maxLength: 255 });
  const taxCode = fileTaxCode(l.taxCode);
  const empStart = l.employmentStart ? ccyyMMdd(l.employmentStart, `${where} (${indicator}) employment start`) : "";
  const empEnd = l.employmentEnd ? ccyyMMdd(l.employmentEnd, `${where} (${indicator}) employment finish`) : "";
  const periodStart = ccyyMMdd(l.periodStart, `${where} (${indicator}) pay period start`);
  const periodEnd = ccyyMMdd(l.periodEnd, `${where} (${indicator}) pay period end`);
  const payCycle = mapPayCycle(l.frequency);
  const hours = assertCents(l.hoursPaidCents, `${where} (${indicator}) hours paid`);
  const gross = assertCents(l.grossCents, `${where} (${indicator}) gross`);
  const priorGross = assertCents(l.priorGrossAdjCents, `${where} (${indicator}) prior gross adjustment`);
  const notLiable = assertCents(l.notLiableAccCents, `${where} (${indicator}) not-liable-ACC`);
  if (l.lumpSumIndicator !== "0" && l.lumpSumIndicator !== "1") {
    throw new IrdFormatError(`${where} (${indicator}): the lump sum indicator must be 0 or 1 (got "${l.lumpSumIndicator}").`);
  }
  const paye = assertCents(l.payeCents, `${where} (${indicator}) PAYE`);
  const priorPaye = assertCents(l.priorPayeAdjCents, `${where} (${indicator}) prior PAYE adjustment`);
  const cs = assertCents(l.childSupportCents, `${where} (${indicator}) child support`);
  const csCode = l.childSupportCode ?? "";
  const sl = assertCents(l.studentLoanCents, `${where} (${indicator}) student loan`);
  const slcir = assertCents(l.slcirCents, `${where} (${indicator}) SLCIR`);
  const slbor = assertCents(l.slborCents, `${where} (${indicator}) SLBOR`);
  const ks = assertCents(l.kiwisaverEmployeeCents, `${where} (${indicator}) KiwiSaver deductions`);
  const ksEmployer = assertCents(l.kiwisaverEmployerNetCents, `${where} (${indicator}) net employer KiwiSaver`);
  const esct = assertCents(l.esctCents, `${where} (${indicator}) ESCT`);
  const donations = assertCents(l.donationsCents, `${where} (${indicator}) donations`);
  const ftc = assertCents(l.familyTaxCreditCents, `${where} (${indicator}) family tax credit`);
  const ess = assertCents(l.shareSchemeCents, `${where} (${indicator}) employee share scheme`);

  return joinRecord([
    indicator, ird, name, taxCode, empStart, empEnd, periodStart, periodEnd,
    payCycle, hours, gross, priorGross, notLiable, l.lumpSumIndicator,
    paye, priorPaye, cs, csCode, sl, slcir, slbor, ks, ksEmployer, esct,
    donations, ftc, ess,
  ]);
}

/** Build + validate the EIA2 file. Throws IrdFormatError on any
 * structural problem; the DTI of an update/delete is the caller's frozen
 * as-filed record. */
export function buildEia2File(header: AmendmentHeaderInput, corrections: AmendmentCorrection[]): BuiltAmendmentFile {
  if (corrections.length < 1) {
    throw new IrdFormatError("An amendment file needs at least one DTI/DAI pair.");
  }
  for (const [i, c] of corrections.entries()) {
    if (!c.original && !c.amended) {
      throw new IrdFormatError(`Correction ${i + 1}: both the original and amended sides are empty — nothing to file.`);
    }
  }

  const employerIrd = normaliseIrd(
    assertSafeText(header.employerIrd, "EIA2 field 2 (employer IRD)", { required: true, maxLength: 9 }),
  );
  if (!isValidEmployerIrdNumber(employerIrd)) {
    throw new IrdFormatError(`EIA2 field 2: "${header.employerIrd}" is not a valid employer IRD number.`);
  }
  const payDate = ccyyMMdd(header.payDate, "EIA2 field 3 (pay date)");
  const intermediaryRaw = (header.payeIntermediaryIrd ?? "").trim();
  let intermediary = "";
  if (intermediaryRaw !== "") {
    intermediary = normaliseIrd(intermediaryRaw);
    if (isUnsuppliedIrd(intermediary) || !isValidIrdNumberForFiling(intermediary)) {
      throw new IrdFormatError(`EIA2 field 4: "${intermediaryRaw}" is not a valid PAYE intermediary IRD number.`);
    }
  }
  const contactName = assertSafeText(header.contactName, "EIA2 field 5 (payroll contact name)", { required: true, maxLength: 20 });
  const contactPhone = assertSafeText(header.contactPhone, "EIA2 field 6 (contact phone)", { required: true, maxLength: 12 });
  if (!/^[A-Za-z0-9]+$/.test(contactPhone)) {
    throw new IrdFormatError(`EIA2 field 6: the contact phone "${contactPhone}" must be 12 alphanumeric characters or fewer.`);
  }
  if (header.irFormVersion !== "0001") {
    throw new IrdFormatError(`EIA2 field 7: the IR form version must be "0001" (got "${header.irFormVersion}").`);
  }

  const records: string[] = [];
  for (const [i, c] of corrections.entries()) {
    const where = `correction ${i + 1}`;
    // DTI FIRST, DAI immediately after — the contiguity myIR enforces.
    records.push(c.original ? detailRecord("DTI", c.original, where) : nilRecord("DTI"));
    records.push(c.amended ? detailRecord("DAI", c.amended, where) : nilRecord("DAI"));
  }

  const headerRecord = joinRecord(["EIA2", employerIrd, payDate, intermediary, contactName, contactPhone, header.irFormVersion]);
  const content = [headerRecord, ...records].join("\n") + "\n";

  // Field-count audit: EIA2 = 7, DTI/DAI = 27, pairs contiguous.
  const outLines = content.split("\n").filter((l) => l !== "");
  if (outLines.length !== 1 + corrections.length * 2) {
    throw new IrdFormatError("Internal error: built line count does not match the input — refusing to emit.");
  }
  for (const [i, line] of outLines.entries()) {
    const fields = line.split(",").length;
    const expected = i === 0 ? 7 : 27;
    if (fields !== expected) {
      throw new IrdFormatError(`Internal error: line ${i + 1} has ${fields} fields (expected ${expected}) — refusing to emit.`);
    }
  }
  for (let i = 1; i < outLines.length; i += 2) {
    if (!outLines[i].startsWith("DTI,") || !outLines[i + 1].startsWith("DAI,")) {
      throw new IrdFormatError("Internal error: DTI/DAI pairs are not contiguous — refusing to emit.");
    }
  }

  return { content, pairCount: corrections.length };
}
