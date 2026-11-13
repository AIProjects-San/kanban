// ---------------------------------------------------------------------------
// Phase 2 (payday filing) — the Employee Details (ED) file builder.
//
// IRD requires new and departing employee details "no later than the next
// filing of Employment Information" (TAA s 23L; the use-case sequence is
// ED first, then the EI that includes them). Builds the myIR CSV:
//
//   HED2  1 indicator 2 employer IRD 3 payroll package id 4 employee lines
//   DED   41 fields (spec §3.2.2, confirmed field-by-field):
//         1 DED 2 IRD 3 name on EI return 4 title 5 first 6 middle
//         7 last 8 DOB 9 employment start 10 employment end
//         11 KiwiSaver eligibility (NE/EE/EA) 12 KiwiSaver status
//         (AE/AK/OK/NK/CT) 13 exempt income 14 email 15-17 mobile
//         18-20 daytime phone 21 country 22-31 postal address
//         32 opted out (Y/N) 33-38 bank 39 opt-out notice date
//         40 late opt-out reason 41 other reason
//   TED   2 fields: "TED",<tax code> — MANDATORY with every DED
//         (spec §3.2.3: "A TED record must be included with every
//         Employee detail line record (DED) filed, otherwise a validation
//         error will be returned").
//
// What Fernly can and cannot source (ADR-018):
//   • Title, address, bank — not held → filed BLANK (all optional).
//   • Email — held (User.email), and "required if known" → always filed.
//   • Phone — EmployeeProfile.phone; NZ mobiles start "02" → filed as
//     the mobile block, anything else as the daytime block.
//   • Opted-out employees — REFUSED: IRD requires the opt-out notice
//     date AND the employee's bank account (the refund target) when the
//     opt-out flag is Y, and Fernly holds neither.
//   • KiwiSaver eligibility — NE for a new joiner, EE for a departure
//     (EA exists for not-yet-auto-enrolled existing employees; Fernly's
//     auto-enrol runs at the first pay, so EE is the honest code).
//
// Pure: no DB, no clock, no filesystem.
// ---------------------------------------------------------------------------

import {
  assertSafeText,
  ccyyMMdd,
  IrdFormatError,
  joinRecord,
  splitFullName,
} from "./format";
import { isUnsuppliedIrd, isValidEmployerIrdNumber, isValidIrdNumberForFiling, normaliseIrd } from "./ird-number";
import { fileTaxCode } from "./tax-code";

export type EdFilingKind = "NEW" | "DEPARTING";

/** KiwiSaver eligibility codes (spec §3.2.2 field 11). */
export type KsEligibility = "NE" | "EE" | "EA";

/** New-employee KiwiSaver status codes (spec §3.2.2 field 12). */
export type KsStatus = "AE" | "AK" | "OK" | "NK" | "CT";

export interface EdHeaderInput {
  /** 9-digit employer IRD number (validated; never 000000000). */
  employerIrd: string;
  /** HED2 field 3 — ≤ 80 chars, no commas. */
  packageIdentifier: string;
}

/** One employee notification. Amounts are not involved — the ED file
 * carries identity, not money. */
export interface EdEmployeeLine {
  /** NEW (employment start) or DEPARTING (employment end). */
  kind: EdFilingKind;
  employeeIrd: string;
  /** Fernly's single full-name field; split into first/middle/last here. */
  fullName: string;
  taxCode: string;
  /** EmployeeProfile.birthDate (optional). */
  dateOfBirth: Date | null;
  /** REQUIRED (DED field 9) — refusal is loud when missing. */
  employmentStart: Date;
  /** REQUIRED for DEPARTING (DED field 10); null for NEW. */
  employmentEnd: Date | null;
  /** EmployeeTaxProfile.kiwiSaverStatus (Fernly vocabulary). */
  kiwiSaverStatus: string;
  /** EmployeeTaxProfile.isCasual / CASUAL employment types. */
  isCasual: boolean;
  /** User.email — "required if known", and Fernly always knows it. */
  email: string;
  /** EmployeeProfile.phone — "" when not held. */
  phone: string;
}

export interface BuiltEdFile {
  content: string;
  employeeLineCount: number;
}

/** Map Fernly's KiwiSaver status onto the spec's status codes. */
function ksStatusCode(status: string, isCasual: boolean): KsStatus {
  if (isCasual) return "CT"; // casual/temporary — the spec's own category
  switch (status) {
    case "ACTIVE":
    case "ON_HOLIDAY":
      return "AK"; // member (a savings suspension is still a member)
    case "NOT_ENROLLED":
      return "AE"; // subject to auto-enrol — Fernly enrols at first pay
    case "NOT_ELIGIBLE":
      return "NK";
    default:
      throw new IrdFormatError(
        `KiwiSaver status "${status}" cannot be mapped onto an IRD Employee Details status code (AK/AE/OK/NK/CT). Fix the employee's tax profile before filing.`,
      );
  }
}

/** Build + validate the whole ED file. Throws IrdFormatError on any
 * structural problem or unsourced mandatory field. */
export function buildEdFile(header: EdHeaderInput, lines: EdEmployeeLine[]): BuiltEdFile {
  if (lines.length < 1) {
    throw new IrdFormatError("Cannot generate an Employee Details file with no employee lines.");
  }

  const employerIrd = normaliseIrd(
    assertSafeText(header.employerIrd, "HED2 field 2 (employer IRD)", { required: true, maxLength: 9 }),
  );
  if (!isValidEmployerIrdNumber(employerIrd)) {
    throw new IrdFormatError(`HED2 field 2: "${header.employerIrd}" is not a valid employer IRD number — update the payroll filing settings before generating.`);
  }
  const packageId = assertSafeText(header.packageIdentifier, "HED2 field 3 (payroll package identifier)", { required: true, maxLength: 80 });

  const records: string[] = [];

  for (const [idx, l] of lines.entries()) {
    const where = `DED line ${idx + 1} (${l.fullName || "unknown employee"})`;

    // Field 2 — IRD (000000000 allowed with ND; otherwise spec-valid).
    const ird = normaliseIrd(l.employeeIrd ?? "");
    if (isUnsuppliedIrd(ird)) {
      if (l.taxCode.trim() !== "ND") {
        throw new IrdFormatError(`${where}: the employee has no IRD number, so the tax code must be ND (non-notified) — got "${l.taxCode}".`);
      }
    } else if (!isValidIrdNumberForFiling(ird)) {
      throw new IrdFormatError(`${where}: "${l.employeeIrd}" is not a valid IRD number (mod-11 check failed) — fix the employee's tax profile before filing.`);
    }

    // Fields 5/6/7 + 3 — the mandatory name split ("Surname Firstnames"
    // on the EI return must match the DED's separate name fields).
    const name = splitFullName(l.fullName, where);

    // Field 8 — DOB (optional, never in the future).
    const dob = l.dateOfBirth ? ccyyMMdd(l.dateOfBirth, `${where} field 8 (date of birth)`) : "";
    if (l.dateOfBirth && l.dateOfBirth.getTime() > Date.now() + 86_400_000) {
      throw new IrdFormatError(`${where} field 8: the date of birth is in the future.`);
    }

    // Fields 9/10 — employment dates.
    const empStart = ccyyMMdd(l.employmentStart, `${where} field 9 (employment start)`);
    let empEnd = "";
    if (l.kind === "DEPARTING") {
      if (!l.employmentEnd) {
        throw new IrdFormatError(`${where} field 10: a departing employee needs an employment end date — record it on the tax profile before filing.`);
      }
      empEnd = ccyyMMdd(l.employmentEnd, `${where} field 10 (employment end)`);
    }

    // Fields 11/12/32 + 33-39 — KiwiSaver. OPTED_OUT employees cannot be
    // sourced (IRD requires the signed opt-out notice date and the
    // employee's bank account; Fernly holds neither) → loud refusal.
    if (l.kiwiSaverStatus === "OPTED_OUT") {
      throw new IrdFormatError(
        `${where}: this employee is recorded as opted out of KiwiSaver, and an opt-out Employee Details line requires the signed opt-out notice date and the employee's bank account — neither is held. Record the opt-out date and bank details (or file this employee's ED in myIR on-screen) before generating.`,
      );
    }
    const eligibility: KsEligibility = l.kind === "NEW" ? "NE" : "EE";
    const ksStatus = ksStatusCode(l.kiwiSaverStatus, l.isCasual);
    // Spec: eligibility NE + status AE = auto-enrolment; the opted-out
    // flag is Y only for opt-outs (refused above), so it is always N.
    const optedOut = "N";

    // Field 13 — exempt income: not modelled → blank.
    const exemptIncome = "";

    // Field 14 — email ("required if known" — always held).
    const email = assertSafeText(l.email, `${where} field 14 (email)`, { required: true, maxLength: 510 });
    if (!/^[A-Za-z0-9@._-]+$/.test(email) || !email.includes("@") || email.startsWith("@") || email.endsWith("@") || email.includes("..")) {
      throw new IrdFormatError(`${where} field 14: "${email}" is not a valid email address.`);
    }

    // Fields 15-20 — phone: NZ mobile prefixes are 02; anything else
    // files as the daytime block. No phone → all six blank.
    const phoneDigits = (l.phone ?? "").replace(/[^\d]/g, "");
    let mobileCountry = "";
    let mobileNumber = "";
    let daytimeCountry = "";
    let daytimeNumber = "";
    if (phoneDigits !== "") {
      if (phoneDigits.startsWith("02")) {
        mobileCountry = "NZL";
        mobileNumber = phoneDigits;
      } else {
        daytimeCountry = "NZL";
        daytimeNumber = phoneDigits;
      }
    }

    // Fields 21-31 — postal address: not held; the email above satisfies
    // IRD's "postal address must be supplied if none of email/mobile/
    // daytime phone is known" rule, so the whole block files blank.
    const address: string[] = ["", "", "", "", "", "", "", "", "", "", ""];

    // Fields 33-41 — bank + opt-out tail: all blank (optedOut is N).
    const tail: string[] = ["", "", "", "", "", "", "", "", ""];

    records.push(joinRecord([
      "DED", ird, name.surnameFirstnames, "", name.first, name.middle, name.last,
      dob, empStart, empEnd, eligibility, ksStatus, exemptIncome, email,
      mobileCountry, mobileNumber, "", daytimeCountry, daytimeNumber, "",
      ...address, optedOut, ...tail,
    ]));

    // The mandatory tax-code line that follows every DED.
    const taxCode = fileTaxCode(l.taxCode);
    records.push(joinRecord(["TED", taxCode]));
  }

  const headerRecord = joinRecord(["HED2", employerIrd, packageId, lines.length]);
  const content = [headerRecord, ...records].join("\n") + "\n";

  // Field-count audit: HED2 = 4, DED = 41, TED = 2.
  const outLines = content.split("\n").filter((l) => l !== "");
  if (outLines.length !== 1 + lines.length * 2) {
    throw new IrdFormatError("Internal error: built line count does not match the input — refusing to emit.");
  }
  for (const [i, line] of outLines.entries()) {
    const fields = line.split(",").length;
    const expected = i === 0 ? 4 : line.startsWith("TED,") ? 2 : 41;
    if (fields !== expected) {
      throw new IrdFormatError(`Internal error: line ${i + 1} has ${fields} fields (expected ${expected}) — refusing to emit.`);
    }
  }

  return { content, employeeLineCount: lines.length };
}
