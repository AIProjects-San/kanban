// ---------------------------------------------------------------------------
// Phase 2 — the spec-exact IRD number validator, pinned to the FOUR
// worked examples in IRD's Payday Filing File Upload Specification
// appendix 5.8 (2026-27 edition). These examples are normative: a
// validator that disagrees with them disagrees with myIR.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { isInIrdIssuedRange, isValidEmployerIrdNumber, isValidIrdNumberForFiling, isUnsuppliedIrd, normaliseIrd } from "../ird-number";
import { isValidIrdNumber as phaseOneHelper } from "@/lib/tax-profile-preview";

describe("isValidIrdNumberForFiling — IRD spec 5.8 worked examples", () => {
  it("example 1: 49091850 is VALID (remainder 0 → check digit 0)", () => {
    expect(isValidIrdNumberForFiling("49091850")).toBe(true);
  });

  it("example 2: 35901981 is VALID (remainder 10 → check digit 1)", () => {
    expect(isValidIrdNumberForFiling("35901981")).toBe(true);
  });

  it("example 3: 136410132 is VALID (secondary weight set → check digit 2)", () => {
    expect(isValidIrdNumberForFiling("136410132")).toBe(true);
  });

  it("example 4: 9125568 is INVALID (below the issued range 10,000,000)", () => {
    expect(isInIrdIssuedRange("9125568")).toBe(false);
    // 7 digits also fail the filed 8-9 digit + mod-11 check.
    expect(isValidIrdNumberForFiling("9125568")).toBe(false);
  });

  it("8-digit numbers are zero-padded to 9 for the check", () => {
    expect(isValidIrdNumberForFiling("49091850")).toBe(true);
    expect(isValidIrdNumberForFiling("049091850")).toBe(true);
  });

  it("wrong check digits are rejected", () => {
    expect(isValidIrdNumberForFiling("49091851")).toBe(false);
    expect(isValidIrdNumberForFiling("136410131")).toBe(false);
  });

  it("separator-laden and malformed inputs are handled", () => {
    expect(isValidIrdNumberForFiling("490-918-50")).toBe(true);
    expect(isValidIrdNumberForFiling("")).toBe(false);
    expect(isValidIrdNumberForFiling("abc")).toBe(false);
    expect(isValidIrdNumberForFiling("12345")).toBe(false);
  });

  it("the issued range is its own check (spec 5.8 step 1) — the EMPLOYER gate", () => {
    expect(isInIrdIssuedRange("49091850")).toBe(true);
    expect(isInIrdIssuedRange("123123123")).toBe(true);
    expect(isInIrdIssuedRange("888888888")).toBe(false); // the myIR page's dummy
    expect(isInIrdIssuedRange("200000001")).toBe(false);
    // The seeded demo IRDs (e.g. 752783373) sit OUTSIDE the issued range
    // but pass mod-11 — they file with a myIR warning, not an error.
    expect(isInIrdIssuedRange("752783373")).toBe(false);
    expect(isValidIrdNumberForFiling("752783373")).toBe(true);
  });

  it("the employer check is the strict one: mod-11 AND range AND not the sentinel", () => {
    expect(isValidEmployerIrdNumber("123123123")).toBe(true);
    expect(isValidEmployerIrdNumber("888888888")).toBe(false); // out of range
    expect(isValidEmployerIrdNumber("000000000")).toBe(false); // sentinel
    expect(isValidEmployerIrdNumber("123456789")).toBe(false); // mod-11 fail
    expect(isValidEmployerIrdNumber("752783373")).toBe(false); // mod-11 ok, range fail
  });

  it("the not-supplied sentinel is NOT a valid number (it is its own concept)", () => {
    expect(isUnsuppliedIrd("000000000")).toBe(true);
    expect(isUnsuppliedIrd("000-000-000")).toBe(true);
    expect(isValidIrdNumberForFiling("000000000")).toBe(false);
  });

  it("normaliseIrd pads to exactly 9 digits", () => {
    expect(normaliseIrd("49091850")).toBe("049091850");
    expect(normaliseIrd("123-456-789")).toBe("123456789");
  });
});

describe("the write-path helper delegates to the spec validator", () => {
  it("accepts IRD's worked examples 1 and 3 (the old copy rejected them)", () => {
    expect(phaseOneHelper("49091850")).toBe(true);
    expect(phaseOneHelper("136410132")).toBe(true);
  });

  it("agrees with the filing validator on every non-empty input", () => {
    for (const ird of ["35901981", "075555555", "111111111", "123123123", "49091851", "136410131", "583639137"]) {
      expect(phaseOneHelper(ird)).toBe(isValidIrdNumberForFiling(ird));
    }
  });

  it("keeps the write path's not-recorded semantics: empty is allowed", () => {
    expect(phaseOneHelper("")).toBe(true);
    expect(isValidIrdNumberForFiling("")).toBe(false);
  });
});
