// The IR330 tax-code vocabulary — the one list every consumer derives from.
//
//   • IR330_BASE_CODES — the base codes an employee can declare (the
//     editor dropdown, the write-path validation, the simulator input).
//   • SECONDARY_RATE_CODES — the codes the IR340 combined-rate table
//     prices (the engine's flat-percentage branches).
//   • FILING_ONLY_CODES — codes myIR accepts on an employment information
//     line that the IR330 editor never offers (withholding).
//
// The filing set (lib/ird/tax-code.ts) is the base codes + the SL-suffixed
// forms of the codes that combine with a student loan + the filing-only
// codes. Before this module the same lists lived in seven hand-synced
// copies that had already drifted.

export const IR330_BASE_CODES = [
  "M",
  "ME",
  "SB",
  "S",
  "SH",
  "ST",
  "SA",
  "ND",
  "STC",
  "CAE",
  "NSW",
  "EDW",
] as const;

export type Ir330BaseCode = (typeof IR330_BASE_CODES)[number];

/** The codes the IR340 combined (PAYE + ACC) rate table prices. */
export const SECONDARY_RATE_CODES = ["SB", "S", "SH", "ST", "SA"] as const;

/** Codes myIR accepts on filing lines but the IR330 editor never offers. */
export const FILING_ONLY_CODES = ["WT"] as const;

/** Base codes that may carry a " SL" (student loan) suffix. */
const SL_CAPABLE_CODES = new Set(["M", "ME", "SB", "S", "SH", "ST", "SA"]);

/** The full closed set of tax codes an employment information line accepts. */
export function filingTaxCodes(): string[] {
  return [
    ...IR330_BASE_CODES.flatMap((base) =>
      SL_CAPABLE_CODES.has(base) ? [base, `${base} SL`] : [base],
    ),
    ...FILING_ONLY_CODES,
  ];
}

/** Short display labels for the IR330 employment categories (the table/
 *  badge form; the tax-profile editor's dropdown adds its rule hints). */
export const EMPLOYMENT_CATEGORY_LABELS: Record<string, string> = {
  PERMANENT: "Permanent",
  CASUAL: "Casual",
  TEMPORARY: "Temporary",
  CASUAL_AGRICULTURAL: "Casual agricultural",
};
