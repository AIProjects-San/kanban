// ---------------------------------------------------------------------------
// Phase 2 — the EIA2 amendment builder: 7-field header, 27-field DTI/DAI
// pairs (same order as DEI — fields 5/6 employment dates ARE present per
// the spec §3.5.2), contiguous pairing, nil records for add/delete.
//
// GOLDEN: the myIR help page's EIA2 sample (one corrected employee),
// with the employer IRD swapped for an in-range number (the page's dummy
// 888888888 sits outside IRD's issued range and the range check is
// spec-mandated).
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildEia2File, type AmendmentLineValues } from "../amendment-file";

const FIXTURES = join(process.cwd(), "src", "lib", "ird", "__tests__", "fixtures") + "/";

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

function line(overrides: Partial<AmendmentLineValues> = {}): AmendmentLineValues {
  return {
    employeeIrd: "111111111",
    employeeName: "Brown John",
    taxCode: "M",
    employmentStart: null,
    employmentEnd: null,
    periodStart: d("2021-05-24"),
    periodEnd: d("2021-06-04"),
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

const HEADER = {
  employerIrd: "123123123",
  payDate: d("2021-06-04"),
  payeIntermediaryIrd: null as string | null,
  contactName: "Bill Smith",
  contactPhone: "0912354321",
  irFormVersion: "0001",
};

describe("buildEia2File — structure", () => {
  it("golden: reproduces the myIR help page's EIA2 sample byte-for-byte (employer IRD in range)", () => {
    const built = buildEia2File(HEADER, [
      { original: line({ grossCents: 56875 }), amended: line({ grossCents: 56785 }) },
    ]);
    const golden = readFileSync(`${FIXTURES}ird-published-eia2-example.csv`, "utf8")
      .replace(/888888888/g, "123123123"); // the page's dummy is out of IRD's issued range
    expect(built.content).toBe(golden);
  });

  it("the header is 7 fields — NO email, NO totals (unlike HEI2)", () => {
    const built = buildEia2File(HEADER, [{ original: line(), amended: line({ grossCents: 100 }) }]);
    const header = built.content.split("\n")[0].split(",");
    expect(header).toHaveLength(7);
    expect(header[0]).toBe("EIA2");
    expect(header[2]).toBe("20210604"); // pay date of the ORIGINAL payment
    expect(header[6]).toBe("0001");
  });

  it("DTI and DAI are contiguous and use the DEI field order (27 fields)", () => {
    const built = buildEia2File(HEADER, [
      { original: line(), amended: line({ payeCents: 1 }) },
      { original: null, amended: line({ employeeIrd: "075555555", employeeName: "Carol French", taxCode: "M SL" }) },
      { original: line({ employeeIrd: "123123123", employeeName: "Mark Jones" }), amended: null },
    ]);
    const rows = built.content.split("\n").filter((l) => l !== "");
    expect(rows).toHaveLength(7); // header + 3 pairs
    expect(built.pairCount).toBe(3);
    for (let i = 1; i < rows.length; i += 2) {
      expect(rows[i].startsWith("DTI,")).toBe(true);
      expect(rows[i + 1].startsWith("DAI,")).toBe(true);
      expect(rows[i].split(",")).toHaveLength(27);
      expect(rows[i + 1].split(",")).toHaveLength(27);
    }
  });

  it("the DTI/DAI field order matches DEI exactly (spot-check against the EI golden)", () => {
    const built = buildEia2File(HEADER, [{ original: line(), amended: line({ grossCents: 1 }) }]);
    const dti = built.content.split("\n")[1].split(",");
    expect(dti[0]).toBe("DTI");
    expect(dti[1]).toBe("111111111"); // field 2 IRD
    expect(dti[3]).toBe("M"); // field 4 tax code
    expect(dti[6]).toBe("20210524"); // field 7 period start
    expect(dti[8]).toBe("WK"); // field 9 pay cycle
    expect(dti[9]).toBe("3050"); // field 10 hours
    expect(dti[10]).toBe("56875"); // field 11 gross
    expect(dti[14]).toBe("34687"); // field 15 PAYE
    expect(dti[21]).toBe("4550"); // field 22 KS employee
    expect(dti[26]).toBe("0"); // field 27 ESS
  });

  it("ADD: a nil DTI (blank identity, zero amounts) precedes the new DAI — IRD's nil-record shape", () => {
    const built = buildEia2File(HEADER, [{ original: null, amended: line({ employeeName: "Cook Cameron", grossCents: 200, payeCents: 300 }) }]);
    const rows = built.content.split("\n").filter((l) => l !== "");
    expect(rows[1]).toBe("DTI,,,,,,,,,0,0,0,0,0,0,0,0,,0,0,0,0,0,0,0,0,0");
    expect(rows[2].split(",")[1]).toBe("111111111");
    expect(rows[2].split(",")[10]).toBe("200");
  });

  it("DELETE: the filed DTI is followed by a nil DAI", () => {
    const built = buildEia2File(HEADER, [{ original: line(), amended: null }]);
    const rows = built.content.split("\n").filter((l) => l !== "");
    expect(rows[1].split(",")[10]).toBe("56875");
    expect(rows[2]).toBe("DAI,,,,,,,,,0,0,0,0,0,0,0,0,,0,0,0,0,0,0,0,0,0");
  });

  it("an empty correction set refuses; both-nil pairs refuse", () => {
    expect(() => buildEia2File(HEADER, [])).toThrow(/at least one DTI\/DAI pair/i);
    expect(() => buildEia2File(HEADER, [{ original: null, amended: null }])).toThrow(/both .* empty/i);
  });

  it("structural guards: commas, bad IRDs, negative amounts, wrong form version", () => {
    expect(() => buildEia2File(HEADER, [{ original: line({ employeeName: "Brown, John" }), amended: line() }])).toThrow(/commas/i);
    expect(() => buildEia2File(HEADER, [{ original: line({ employeeIrd: "123456789" }), amended: line() }])).toThrow(/not a valid IRD/i);
    expect(() => buildEia2File(HEADER, [{ original: line({ payeCents: -5 }), amended: line() }])).toThrow(/negative/i);
    expect(() => buildEia2File({ ...HEADER, irFormVersion: "0002" }, [{ original: line(), amended: line() }])).toThrow(/0001/i);
    expect(() => buildEia2File({ ...HEADER, employerIrd: "888888888" }, [{ original: line(), amended: line() }])).toThrow(/not a valid employer IRD/i);
  });
});
