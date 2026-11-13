// ---------------------------------------------------------------------------
// Phase 2 — the tax code map: every code the engine can apply files
// as-is; anything outside the spec §5.3 table refuses.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { EI_TAX_CODES, fileTaxCode } from "../tax-code";

describe("fileTaxCode", () => {
  it("every plain base code files as-is", () => {
    for (const code of ["M", "ME", "SB", "S", "SH", "ST", "SA", "ND", "STC", "CAE", "WT", "NSW", "EDW"]) {
      expect(fileTaxCode(code)).toBe(code);
    }
  });

  it("student-loan suffixed codes file as-is with the space (IRD sample shows 'M SL')", () => {
    for (const code of ["M SL", "ME SL", "SB SL", "S SL", "SH SL", "ST SL", "SA SL"]) {
      expect(fileTaxCode(code)).toBe(code);
    }
  });

  it("the seeded demo codes all file", () => {
    for (const code of ["M", "M SL", "ME", "STC", "SB SL"]) {
      expect(() => fileTaxCode(code)).not.toThrow();
    }
  });

  it("unknown codes refuse", () => {
    expect(() => fileTaxCode("MSL")).toThrow(/not a tax code/i);
    expect(() => fileTaxCode("SL")).toThrow(/not a tax code/i);
    expect(() => fileTaxCode("ZZZ")).toThrow(/not a tax code/i);
  });

  it("a missing tax code refuses with the IR330 message", () => {
    expect(() => fileTaxCode("")).toThrow(/no tax code applied/i);
    expect(() => fileTaxCode("   ")).toThrow(/no tax code applied/i);
  });

  it("retired codes refuse (SLCIR/SLBOR/ESS are no longer tax codes)", () => {
    expect(() => fileTaxCode("SLCIR")).toThrow(/not a tax code/i);
    expect(() => fileTaxCode("SLBOR")).toThrow(/not a tax code/i);
  });

  it("the closed set matches the spec §5.3 table (20 codes)", () => {
    expect(EI_TAX_CODES.size).toBe(20);
  });
});
