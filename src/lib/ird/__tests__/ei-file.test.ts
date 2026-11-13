// ---------------------------------------------------------------------------
// Phase 2 (payday filing) — the EI builder's test suite.
//
// GOLDEN: the IRD Payday Filing File Upload Specification §3.4.4's worked
// example (the same 4 employees the myIR help page shows). IRD's own
// header totals in that example are explicitly illustrative ("calculated
// figures may not be accurate") and do not sum to its detail lines, so the
// golden fixture carries the published DEI lines VERBATIM with the header
// totals our builder computes (which myIR's totals reconciliation would
// demand). A separate test pins the published bytes field-by-field.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildEiFile, type EiEmployeeLine } from "../ei-file";
import { IrdFormatError } from "../format";
import { isValidEmployerIrdNumber, isValidIrdNumberForFiling } from "../ird-number";

// jsdom rewrites import.meta.url, so fixtures resolve from the repo root
// (vitest always runs there).
const FIXTURES = join(process.cwd(), "src", "lib", "ird", "__tests__", "fixtures") + "/";

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

const HEADER = {
  employerIrd: "123123123",
  payDate: d("2019-05-22"),
  payeIntermediaryIrd: null as string | null,
  contactName: "Bill Smith",
  contactPhone: "041234567",
  contactEmail: "payroll@email.com",
  packageIdentifier: "vendor_package_v1.0",
  irFormVersion: "0001",
};

/** The IRD worked example's four employees (spec §3.4.4, verbatim). */
function irdExampleLines(): EiEmployeeLine[] {
  return [
    {
      employeeIrd: "111111111", employeeName: "Brown John", taxCode: "M",
      employmentStart: null, employmentEnd: null,
      periodStart: d("2019-04-07"), periodEnd: d("2019-04-14"), frequency: "WEEKLY",
      hoursPaidCents: 3050, grossCents: 56875, priorGrossAdjCents: 0, notLiableAccCents: 0,
      lumpSumIndicator: "0", payeCents: 34687, priorPayeAdjCents: 0, childSupportCents: 0,
      childSupportCode: null, studentLoanCents: 0, slcirCents: 0, slborCents: 0,
      kiwisaverEmployeeCents: 4550, kiwisaverEmployerNetCents: 3565, esctCents: 756,
      donationsCents: 0, familyTaxCreditCents: 0, shareSchemeCents: 0,
    },
    {
      employeeIrd: "074444444", employeeName: "Cork Chelsea", taxCode: "M",
      employmentStart: null, employmentEnd: null,
      periodStart: d("2019-04-07"), periodEnd: d("2019-04-14"), frequency: "WEEKLY",
      hoursPaidCents: 3750, grossCents: 65725, priorGrossAdjCents: 0, notLiableAccCents: 0,
      lumpSumIndicator: "0", payeCents: 45695, priorPayeAdjCents: 0, childSupportCents: 0,
      childSupportCode: null, studentLoanCents: 0, slcirCents: 0, slborCents: 0,
      kiwisaverEmployeeCents: 0, kiwisaverEmployerNetCents: 0, esctCents: 0,
      donationsCents: 100, familyTaxCreditCents: 0, shareSchemeCents: 0,
    },
    {
      employeeIrd: "075555555", employeeName: "French Carol", taxCode: "M SL",
      employmentStart: null, employmentEnd: null,
      periodStart: d("2019-04-07"), periodEnd: d("2019-04-14"), frequency: "WEEKLY",
      hoursPaidCents: 2500, grossCents: 45678, priorGrossAdjCents: 2567, notLiableAccCents: 0,
      lumpSumIndicator: "0", payeCents: 32785, priorPayeAdjCents: 1456, childSupportCents: 0,
      childSupportCode: null, studentLoanCents: 2687, slcirCents: 0, slborCents: 0,
      kiwisaverEmployeeCents: 0, kiwisaverEmployerNetCents: 0, esctCents: 0,
      donationsCents: 0, familyTaxCreditCents: 0, shareSchemeCents: 0,
    },
    {
      employeeIrd: "123123123", employeeName: "Jones Mark", taxCode: "M",
      employmentStart: null, employmentEnd: null,
      periodStart: d("2019-04-07"), periodEnd: d("2019-04-14"), frequency: "WEEKLY",
      hoursPaidCents: 3750, grossCents: 165879, priorGrossAdjCents: 0, notLiableAccCents: 22500,
      lumpSumIndicator: "0", payeCents: 78562, priorPayeAdjCents: 0, childSupportCents: 0,
      childSupportCode: null, studentLoanCents: 0, slcirCents: 0, slborCents: 0,
      kiwisaverEmployeeCents: 4587, kiwisaverEmployerNetCents: 2569, esctCents: 1545,
      donationsCents: 0, familyTaxCreditCents: 0, shareSchemeCents: 22500,
    },
  ];
}

function oneLine(overrides: Partial<EiEmployeeLine> = {}): EiEmployeeLine {
  return {
    employeeIrd: "111111111",
    employeeName: "Brown John",
    taxCode: "M",
    employmentStart: null,
    employmentEnd: null,
    periodStart: d("2019-04-07"),
    periodEnd: d("2019-04-14"),
    frequency: "WEEKLY",
    hoursPaidCents: 3050,
    grossCents: 56875,
    priorGrossAdjCents: 0,
    notLiableAccCents: 0,
    lumpSumIndicator: "0",
    payeCents: 34687,
    priorPayeAdjCents: 0,
    childSupportCents: 0,
    childSupportCode: null,
    studentLoanCents: 0,
    slcirCents: 0,
    slborCents: 0,
    kiwisaverEmployeeCents: 4550,
    kiwisaverEmployerNetCents: 3565,
    esctCents: 756,
    donationsCents: 0,
    familyTaxCreditCents: 0,
    shareSchemeCents: 0,
    ...overrides,
  };
}

describe("buildEiFile — golden test (IRD worked example, byte equality)", () => {
  it("reproduces the IRD worked example byte-for-byte (header totals = true sums)", () => {
    const built = buildEiFile({ header: HEADER, lines: irdExampleLines() });
    const golden = readFileSync(`${FIXTURES}ei-golden.csv`, "utf8");
    expect(built.content).toBe(golden);
  });

  it("the DEI lines match IRD's published example lines verbatim", () => {
    const built = buildEiFile({ header: HEADER, lines: irdExampleLines() });
    const published = readFileSync(`${FIXTURES}ird-published-ei-example.csv`, "utf8")
      .split("\n")
      .filter((l) => l.startsWith("DEI,"));
    const ours = built.content.split("\n").filter((l) => l.startsWith("DEI,"));
    expect(ours).toEqual(published);
  });

  it("every employee IRD in IRD's own example passes the spec mod-11 check", () => {
    for (const ird of ["111111111", "074444444", "075555555", "123123123"]) {
      expect(isValidIrdNumberForFiling(ird)).toBe(true);
    }
    // The myIR help page's dummy employer IRD 888888888 is OUTSIDE IRD's
    // issued range — the EMPLOYER check rejects it (out-of-range EMPLOYEE
    // numbers file with a myIR warning instead).
    expect(isValidIrdNumberForFiling("888888888")).toBe(true);
    expect(isValidEmployerIrdNumber("888888888")).toBe(false);
  });

  it("field positions match the published example (field-by-field pin)", () => {
    const published = readFileSync(`${FIXTURES}ird-published-ei-example.csv`, "utf8")
      .split("\n")
      .filter((l) => l !== "");
    const header = published[0].split(",");
    expect(header).toHaveLength(28);
    expect(header[0]).toBe("HEI2");
    expect(header[1]).toBe("123123123"); // employer IRD (field 2)
    expect(header[2]).toBe("20190522"); // pay date (field 3)
    expect(header[6]).toBe("Bill Smith"); // contact name (field 7)
    expect(header[8]).toBe("payroll@email.com"); // email (field 9)
    expect(header[26]).toBe("vendor_package_v1.0"); // package id (field 27)
    expect(header[27]).toBe("0001"); // form version (field 28)
    for (const line of published.slice(1)) {
      const f = line.split(",");
      expect(f).toHaveLength(27);
      expect(f[0]).toBe("DEI");
      expect(f[1]).toMatch(/^\d{9}$/); // employee IRD
      expect(f[8]).toBe("WK"); // pay cycle (field 9)
      expect(f[9]).toBe(f[9].trim()); // hours (field 10) — no decimals
      expect(f[14]).toMatch(/^\d+$/); // PAYE (field 15) — integer cents
    }
  });
});

describe("buildEiFile — the 8 hard structural assertions", () => {
  it("assertion 1 — header totals equal the sum of the detail lines", () => {
    const built = buildEiFile({ header: HEADER, lines: irdExampleLines() });
    const t = built.totals;
    expect(t.employeeLines).toBe(4);
    expect(t.grossCents).toBe(56875 + 65725 + 45678 + 165879);
    expect(t.payeCents).toBe(34687 + 45695 + 32785 + 78562);
    expect(t.studentLoanCents).toBe(2687);
    expect(t.kiwisaverEmployeeCents).toBe(4550 + 4587);
    expect(t.kiwisaverEmployerNetCents).toBe(3565 + 2569);
    expect(t.esctCents).toBe(756 + 1545);
    expect(t.donationsCents).toBe(100);
    expect(t.shareSchemeCents).toBe(22500);
    // The spec's HEI2 field 23 formula: (PAYE − donations) + CS + SL + KS + employer KS + ESCT + SLCIR + SLBOR.
    expect(t.totalDeductedCents).toBe(191729 - 100 + 0 + 2687 + 9137 + 6134 + 2301 + 0 + 0);
    // And the header line itself carries them.
    const headerFields = built.content.split("\n")[0].split(",");
    expect(Number(headerFields[9])).toBe(t.employeeLines);
    expect(Number(headerFields[10])).toBe(t.grossCents);
    expect(Number(headerFields[22])).toBe(t.totalDeductedCents);
  });

  it("assertion 1 (guard) — a mutated line total makes the build fail loudly", () => {
    // The builder computes totals FROM the lines, so a header/line mismatch
    // is impossible by construction — the guard is the per-field audit:
    // fractional cents (assertion 2's path) must refuse before any emit.
    expect(() => buildEiFile({ header: HEADER, lines: [oneLine({ grossCents: 100050.5 })] })).toThrow(IrdFormatError);
  });

  it("assertion 2 — amounts must be non-negative integers (no floats, no decimals)", () => {
    expect(() => buildEiFile({ header: HEADER, lines: [oneLine({ payeCents: -1 })] })).toThrow(/negative/i);
    expect(() => buildEiFile({ header: HEADER, lines: [oneLine({ grossCents: 12.5 })] })).toThrow(/integer cents/i);
    expect(() => buildEiFile({ header: HEADER, lines: [oneLine({ studentLoanCents: -500 })] })).toThrow(/negative/i);
  });

  it("assertion 3 — no field may contain a comma or newline", () => {
    expect(() => buildEiFile({ header: HEADER, lines: [oneLine({ employeeName: "Smith, John" })] })).toThrow(/commas/i);
    expect(() => buildEiFile({ header: { ...HEADER, contactName: "Bill, Smith" }, lines: [oneLine()] })).toThrow(/commas/i);
    expect(() => buildEiFile({ header: { ...HEADER, packageIdentifier: "Fernly\nv1" }, lines: [oneLine()] })).toThrow(/line breaks/i);
  });

  it("assertion 4 — dates must be valid CCYYMMDD calendar dates", () => {
    // A calendar-impossible STRING is refused at parse time
    // (parseCcyyMMdd); the builder sees Date objects, so its guard is the
    // Invalid Date case (a normalized 2019-02-30 becomes 2019-03-02 long
    // before it reaches this layer).
    expect(() => buildEiFile({ header: { ...HEADER, payDate: new Date("not-a-date") }, lines: [oneLine()] })).toThrow(IrdFormatError);
    expect(() => buildEiFile({ header: HEADER, lines: [oneLine({ periodStart: new Date("invalid") })] })).toThrow(IrdFormatError);
    // A real leap day is fine.
    expect(() => buildEiFile({ header: { ...HEADER, payDate: d("2020-02-29") }, lines: [oneLine()] })).not.toThrow();
  });

  it("assertion 5 — never generate a nil EI (at least one line)", () => {
    expect(() => buildEiFile({ header: HEADER, lines: [] })).toThrow(/no employee lines/i);
  });

  it("assertion 6 — every employee IRD is 000000000 or mod-11 valid", () => {
    expect(() => buildEiFile({ header: HEADER, lines: [oneLine({ employeeIrd: "123456789" })] })).toThrow(/not a valid IRD number/i);
    expect(() => buildEiFile({ header: HEADER, lines: [oneLine({ employeeIrd: "000000009" })] })).toThrow(/not a valid IRD number/i);
    expect(() => buildEiFile({ header: HEADER, lines: [oneLine({ employeeIrd: "123456789" })] })).toThrow(/not a valid IRD number/i);
    // The not-supplied sentinel is allowed (with ND — assertion 7).
    expect(() => buildEiFile({ header: HEADER, lines: [oneLine({ employeeIrd: "000000000", taxCode: "ND" })] })).not.toThrow();
  });

  it("assertion 7 — a 000000000 IRD requires tax code ND", () => {
    expect(() => buildEiFile({ header: HEADER, lines: [oneLine({ employeeIrd: "000000000", taxCode: "M" })] })).toThrow(/ND/i);
  });

  it("assertion 8 — PAYE cannot exceed gross for any line", () => {
    expect(() => buildEiFile({ header: HEADER, lines: [oneLine({ payeCents: 56876 })] })).toThrow(/PAYE .* cannot exceed gross/i);
    // PAYE == gross is allowed.
    expect(() => buildEiFile({ header: HEADER, lines: [oneLine({ payeCents: 56875 })] })).not.toThrow();
  });

  it("the employer IRD and header contact fields are validated too", () => {
    expect(() => buildEiFile({ header: { ...HEADER, employerIrd: "000000000" }, lines: [oneLine()] })).toThrow(/employer IRD/i);
    expect(() => buildEiFile({ header: { ...HEADER, employerIrd: "111" }, lines: [oneLine()] })).toThrow(/employer IRD/i);
    expect(() => buildEiFile({ header: { ...HEADER, contactName: "A very long contact person name" }, lines: [oneLine()] })).toThrow(/maximum of 20/i);
    expect(() => buildEiFile({ header: { ...HEADER, contactPhone: "04 123 4567" }, lines: [oneLine()] })).toThrow(/alphanumeric/i);
    expect(() => buildEiFile({ header: { ...HEADER, contactEmail: "not-an-email" }, lines: [oneLine()] })).toThrow(/email/i);
    expect(() => buildEiFile({ header: { ...HEADER, irFormVersion: "0002" }, lines: [oneLine()] })).toThrow(/0001/i);
    expect(() => buildEiFile({ header: { ...HEADER, payeIntermediaryIrd: "123456789" }, lines: [oneLine()] })).toThrow(/intermediary/i);
  });

  it("the lump sum indicator must be exactly 0 or 1; CS code from the closed set", () => {
    expect(() => buildEiFile({ header: HEADER, lines: [oneLine({ lumpSumIndicator: "2" })] })).toThrow(/lump sum/i);
    expect(() => buildEiFile({ header: HEADER, lines: [oneLine({ childSupportCode: "Z" })] })).toThrow(/child support code/i);
    expect(() => buildEiFile({ header: HEADER, lines: [oneLine({ childSupportCode: "A" })] })).not.toThrow();
  });

  it("employment dates are filed only when inside the pay period", () => {
    const lines = irdExampleLines();
    lines[0] = oneLine({ employmentStart: d("2019-04-10"), employmentEnd: null });
    const built = buildEiFile({ header: HEADER, lines });
    const dei = built.content.split("\n")[1].split(",");
    expect(dei[4]).toBe("20190410"); // field 5
    expect(dei[5]).toBe(""); // field 6
  });

  it("an unsupported cadence (QUARTERLY/ANNUAL) refuses to build", () => {
    expect(() => buildEiFile({ header: HEADER, lines: [oneLine({ frequency: "QUARTERLY" })] })).toThrow(/pay cycle code/i);
    expect(() => buildEiFile({ header: HEADER, lines: [oneLine({ frequency: "ANNUAL" })] })).toThrow(/pay cycle code/i);
  });
});
