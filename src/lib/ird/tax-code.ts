// ---------------------------------------------------------------------------
// Phase 2 (payday filing) — the tax codes valid on EI/ED file lines
// (DEI field 4 / DTI-DAI field 4 / TED field 2).
//
// CONFIRMED against IRD's Payday Filing File Upload Specification
// (2026-27, §5.3 "Table of Tax Codes as at 31 Jul 2024"):
//   M, ME, M SL, ME SL, NSW, SB, S, SH, ST, SA, SB SL, S SL, SH SL,
//   ST SL, SA SL, CAE, EDW, ND, STC, WT
//
// Every code files AS-IS (the sample files show "M SL" with the space and
// both letters inside the single tax-code field). SLCIR/SLBOR/ESS were
// retired as tax codes by IRD and are rejected. Anything not in this set
// makes the file invalid, so the builder REFUSES instead of guessing.
//
// Pure: no DB, no clock.
// ---------------------------------------------------------------------------

/** The closed set of tax codes IRD accepts on filing lines. */
export const EI_TAX_CODES: ReadonlySet<string> = new Set([
  "M", "ME", "M SL", "ME SL",
  "NSW",
  "SB", "S", "SH", "ST", "SA",
  "SB SL", "S SL", "SH SL", "ST SL", "SA SL",
  "CAE", "EDW", "ND", "STC", "WT",
]);

/**
 * Validate a tax code for filing. Fernly stores the IR330 declaration
 * (base code, optional " SL" suffix) — exactly the shape IRD expects.
 * Returns the filed form (as-is); throws on anything outside the set.
 */
export function fileTaxCode(taxCode: string): string {
  const code = taxCode.trim();
  if (code === "") {
    throw new Error(
      "The payslip has no tax code applied — the IR330 declaration is missing, so the return cannot be filed. Fix the employee's tax profile and re-price the payslip before filing.",
    );
  }
  if (!EI_TAX_CODES.has(code)) {
    throw new Error(
      `"${code}" is not a tax code IRD accepts on an employment information line (valid codes: M, ME, SB, S, SH, ST, SA, STC, ND, CAE, NSW, EDW, WT — each optionally with an SL suffix). Fix the employee's tax code before filing.`,
    );
  }
  return code;
}
