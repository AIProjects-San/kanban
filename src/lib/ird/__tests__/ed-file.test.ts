// ---------------------------------------------------------------------------
// Phase 2 — the Employee Details (ED) file builder: HED2 (4 fields) +
// per employee DED (41 fields) + the MANDATORY TED tax-code line (2
// fields). Structure mirrors IRD spec §3.2.2/§3.2.3 and the §3.3.3
// sample file.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { buildEdFile, type EdEmployeeLine } from "../ed-file";
import { IrdFormatError } from "../format";

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

function joiner(overrides: Partial<EdEmployeeLine> = {}): EdEmployeeLine {
  return {
    kind: "NEW",
    employeeIrd: "123018635",
    fullName: "Mary Jane Smith",
    taxCode: "M",
    dateOfBirth: d("1985-06-14"),
    employmentStart: d("2019-10-15"),
    employmentEnd: null,
    kiwiSaverStatus: "ACTIVE",
    isCasual: false,
    email: "mary.smith@company.co.nz",
    phone: "021123456",
    ...overrides,
  };
}

describe("buildEdFile — structure", () => {
  it("builds HED2 + (DED + TED) per employee with exact field counts", () => {
    const built = buildEdFile(
      { employerIrd: "123250265", packageIdentifier: "SoftwarePlatform" },
      [joiner()],
    );
    const lines = built.content.split("\n").filter((l) => l !== "");
    expect(lines).toHaveLength(3); // HED2 + DED + TED
    expect(lines[0].split(",")).toHaveLength(4);
    expect(lines[0]).toBe("HED2,123250265,SoftwarePlatform,1");
    expect(lines[1].split(",")).toHaveLength(41);
    expect(lines[2].split(",")).toHaveLength(2);
    expect(lines[2]).toBe("TED,M");
    expect(built.employeeLineCount).toBe(1);
  });

  it("the DED line mirrors IRD's sample layout field-by-field", () => {
    // IRD §3.3.3 sample: DED,123018635,Smith Mary,Mrs,Mary,,Smith,19850614,
    // 20191015,,NE,AK,,mary.smith@company.co.nz,NZL,021123456,,,,,NZL,…address…,,N,,,,,
    const built = buildEdFile(
      { employerIrd: "123250265", packageIdentifier: "SoftwarePlatform" },
      [joiner({ fullName: "Mary Smith" })], // two tokens → no middle name
    );
    const f = built.content.split("\n")[1].split(",");
    expect(f[0]).toBe("DED");
    expect(f[1]).toBe("123018635"); // IRD
    expect(f[2]).toBe("Smith Mary"); // name on the EI return — Surname Firstnames
    expect(f[3]).toBe(""); // title (not held)
    expect(f[4]).toBe("Mary"); // first
    expect(f[5]).toBe(""); // middle
    expect(f[6]).toBe("Smith"); // last
    expect(f[7]).toBe("19850614"); // DOB
    expect(f[8]).toBe("20191015"); // employment start
    expect(f[9]).toBe(""); // employment end
    expect(f[10]).toBe("NE"); // KiwiSaver eligibility (new employee)
    expect(f[11]).toBe("AK"); // KiwiSaver status
    expect(f[12]).toBe(""); // exempt income
    expect(f[13]).toBe("mary.smith@company.co.nz");
    expect(f[14]).toBe("NZL"); // mobile country
    expect(f[15]).toBe("021123456"); // mobile number
    expect(f[16]).toBe(""); // mobile ext
    expect(f[17]).toBe(""); // daytime country
    expect(f[18]).toBe(""); // daytime number
    expect(f[19]).toBe(""); // daytime ext
    expect(f[20]).toBe(""); // country (no address held)
    expect(f[31]).toBe("N"); // opted out = N
    expect(f[32]).toBe(""); // bank
    expect(f[40]).toBe(""); // other late opt-out reason
  });

  it("a DEPARTING employee files EE eligibility + the end date", () => {
    const built = buildEdFile(
      { employerIrd: "123250265", packageIdentifier: "SoftwarePlatform" },
      [joiner({ kind: "DEPARTING", employmentEnd: d("2026-11-20"), kiwiSaverStatus: "NOT_ENROLLED" })],
    );
    const f = built.content.split("\n")[1].split(",");
    expect(f[9]).toBe("20261120"); // employment end
    expect(f[10]).toBe("EE"); // existing employee
    expect(f[11]).toBe("AE"); // auto-enrol status
    expect(f[31]).toBe("N");
  });

  it("a landline-looking phone files as the daytime block", () => {
    const built = buildEdFile(
      { employerIrd: "123250265", packageIdentifier: "SoftwarePlatform" },
      [joiner({ phone: "041234567" })],
    );
    const f = built.content.split("\n")[1].split(",");
    expect(f[14]).toBe(""); // mobile country
    expect(f[17]).toBe("NZL"); // daytime country
    expect(f[18]).toBe("041234567");
  });

  it("multiple employees share one HED2 with the right count", () => {
    const built = buildEdFile(
      { employerIrd: "123250265", packageIdentifier: "SoftwarePlatform" },
      [joiner(), joiner({ employeeIrd: "000000000", fullName: "Brian Jack Hall", taxCode: "ND", email: "brian@company.co.nz", phone: "" })],
    );
    const lines = built.content.split("\n").filter((l) => l !== "");
    expect(lines).toHaveLength(5); // HED2 + 2×(DED+TED)
    expect(lines[0].split(",")[3]).toBe("2");
    expect(built.employeeLineCount).toBe(2);
  });

  it("a three-token name splits first/middle/last and files 'Last First Middle'", () => {
    const built = buildEdFile(
      { employerIrd: "123250265", packageIdentifier: "SoftwarePlatform" },
      [joiner({ fullName: "Brian Jack Hall" })],
    );
    const f = built.content.split("\n")[1].split(",");
    expect(f[2]).toBe("Hall Brian Jack");
    expect(f[4]).toBe("Brian");
    expect(f[5]).toBe("Jack");
    expect(f[6]).toBe("Hall");
  });
});

describe("buildEdFile — assertions (every myIR structural rule)", () => {
  it("no commas anywhere (the CSV structure is comma-delimited)", () => {
    expect(() =>
      buildEdFile({ employerIrd: "123250265", packageIdentifier: "SoftwarePlatform" }, [joiner({ fullName: "Smith, Mary" })]),
    ).toThrow(/comma/i);
  });

  it("no decimals, no negative amounts — the ED file carries no amounts at all", () => {
    // (Structural: the DED has no money fields; the guard is the 41-field
    // count audit below plus the no-comma rule above.)
    const built = buildEdFile({ employerIrd: "123250265", packageIdentifier: "SoftwarePlatform" }, [joiner()]);
    expect(built.content).not.toMatch(/\.\d/);
    expect(built.content).not.toMatch(/-\d/);
  });

  it("dates must be valid CCYYMMDD", () => {
    expect(() =>
      buildEdFile({ employerIrd: "123250265", packageIdentifier: "SoftwarePlatform" }, [joiner({ dateOfBirth: new Date("nope") })]),
    ).toThrow(IrdFormatError);
  });

  it("a single-token name refuses (first AND last are mandatory since Oct 2026)", () => {
    expect(() =>
      buildEdFile({ employerIrd: "123250265", packageIdentifier: "SoftwarePlatform" }, [joiner({ fullName: "Cher" })]),
    ).toThrow(/first and last name/i);
  });

  it("an invalid employee IRD refuses; 000000000 requires ND", () => {
    expect(() =>
      buildEdFile({ employerIrd: "123250265", packageIdentifier: "SoftwarePlatform" }, [joiner({ employeeIrd: "123456789" })]),
    ).toThrow(/not a valid IRD number/i);
    expect(() =>
      buildEdFile({ employerIrd: "123250265", packageIdentifier: "SoftwarePlatform" }, [joiner({ employeeIrd: "000000000" })]),
    ).toThrow(/ND/i);
    expect(() =>
      buildEdFile({ employerIrd: "123250265", packageIdentifier: "SoftwarePlatform" }, [joiner({ employeeIrd: "000000000", taxCode: "ND" })]),
    ).not.toThrow();
  });

  it("an OPTED_OUT employee refuses — the opt-out date and bank account are not held (ADR-018)", () => {
    expect(() =>
      buildEdFile({ employerIrd: "123250265", packageIdentifier: "SoftwarePlatform" }, [joiner({ kiwiSaverStatus: "OPTED_OUT" })]),
    ).toThrow(/opted out/i);
  });

  it("a departing employee without an end date refuses", () => {
    expect(() =>
      buildEdFile({ employerIrd: "123250265", packageIdentifier: "SoftwarePlatform" }, [joiner({ kind: "DEPARTING", employmentEnd: null })]),
    ).toThrow(/end date/i);
  });

  it("a missing employment start date refuses (DED field 9 is required)", () => {
    expect(() =>
      buildEdFile({ employerIrd: "123250265", packageIdentifier: "SoftwarePlatform" }, [joiner({ employmentStart: new Date("bad") })]),
    ).toThrow(IrdFormatError);
  });

  it("a bad employer IRD / package id refuses", () => {
    expect(() => buildEdFile({ employerIrd: "000000000", packageIdentifier: "x" }, [joiner()])).toThrow(/employer IRD/i);
    expect(() => buildEdFile({ employerIrd: "123250265", packageIdentifier: "" }, [joiner()])).toThrow(/required/i);
  });

  it("an invalid tax code refuses (TED must carry a spec-valid code)", () => {
    expect(() =>
      buildEdFile({ employerIrd: "123250265", packageIdentifier: "SoftwarePlatform" }, [joiner({ taxCode: "MSL" })]),
    ).toThrow(/not a tax code/i);
  });

  it("an empty employee list refuses", () => {
    expect(() => buildEdFile({ employerIrd: "123250265", packageIdentifier: "SoftwarePlatform" }, [])).toThrow(/no employee lines/i);
  });

  it("KiwiSaver status codes map onto the spec's closed set", () => {
    const cases: Array<[string, boolean, string]> = [
      ["ACTIVE", false, "AK"],
      ["NOT_ENROLLED", false, "AE"],
      ["NOT_ELIGIBLE", false, "NK"],
      ["ON_HOLIDAY", false, "AK"],
      ["ACTIVE", true, "CT"], // casual → CT
    ];
    for (const [status, casual, expected] of cases) {
      const built = buildEdFile(
        { employerIrd: "123250265", packageIdentifier: "SoftwarePlatform" },
        [joiner({ kiwiSaverStatus: status, isCasual: casual })],
      );
      expect(built.content.split("\n")[1].split(",")[11]).toBe(expected);
    }
    expect(() =>
      buildEdFile({ employerIrd: "123250265", packageIdentifier: "SoftwarePlatform" }, [joiner({ kiwiSaverStatus: "MYSTERY" })]),
    ).toThrow(/KiwiSaver status/i);
  });
});
