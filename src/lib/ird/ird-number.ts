// ---------------------------------------------------------------------------
// Phase 2 (payday filing) — IRD number validation, EXACTLY as IRD's
// "Payday Filing File Upload Specification" appendix 5.8 specifies it
// (2026-27 edition, downloaded and verified against its four worked
// examples). This is the validator the FILE layer uses: a number myIR
// would reject must never reach a generated EI/ED line.
//
// Why a new validator instead of reusing isValidIrdNumber
// (lib/payroll/tax-profile-preview.ts)? The Phase 1 helper transposes the
// remainder-0 and remainder-1 rules (it returns check digit 10 when the
// remainder is 0 and 0 when it is 1; the spec — and its own worked
// examples 1 and 3 — say the opposite). Concretely, the Phase 1 helper
// rejects IRD's own example numbers 49091850 (spec example 1: VALID) and
// 136410132 (spec example 3: VALID), and it also omits the issued-range
// check. Phase 1 code is frozen for this phase, so the filing layer
// carries this spec-exact copy instead; see ADR-018.
//
// Pure: no DB, no clock.
// ---------------------------------------------------------------------------

/** IRD's issued range: numbers outside [10,000,000 … 200,000,000] have
 * never been issued and are invalid (spec 5.8 step 1). */
const IRD_MIN = 10_000_000;
const IRD_MAX = 200_000_000;

const WEIGHTS_A = [3, 2, 7, 6, 5, 4, 3, 2] as const;
const WEIGHTS_B = [7, 4, 3, 2, 5, 2, 7, 6] as const;

function checkDigit(base: readonly number[], weights: readonly number[]): number {
  let sum = 0;
  for (let i = 0; i < 8; i += 1) sum += weights[i] * base[i];
  const rem = sum % 11;
  // Spec: remainder 0 → check digit 0; otherwise 11 − remainder.
  return rem === 0 ? 0 : 11 - rem;
}

/**
 * Spec mod-11 validation (8–9 digits, two weight sets) — the check the
 * FILE layer applies to EMPLOYEE IRD numbers (spec §3.4.1.2 field 2:
 * "a 9digit number, modulus 11 checked"; out-of-range numbers draw a
 * myIR WARNING, not an error, so the range is NOT part of the filed
 * check — see isInIrdIssuedRange for the employer-side strict check).
 *
 * "000000000" is NOT a valid number — it is the not-supplied sentinel
 * allowed (with tax code ND) on employee lines; use isUnsuppliedIrd for
 * that case.
 */
export function isValidIrdNumberForFiling(raw: string): boolean {
  const digits = raw.replace(/\D/g, "");
  if (!/^\d{8,9}$/.test(digits)) return false;
  if (digits === "000000000") return false; // the sentinel is not a number
  const n = digits.padStart(9, "0").split("").map(Number);
  const base = n.slice(0, 8);
  let c = checkDigit(base, WEIGHTS_A);
  if (c === 10) c = checkDigit(base, WEIGHTS_B);
  if (c === 10) return false; // both weight sets exhausted — invalid
  return c === n[8];
}

/** IRD's issued range (spec §5.8 step 1): numbers outside
 * [10,000,000 … 200,000,000] have never been issued. */
export function isInIrdIssuedRange(raw: string): boolean {
  const digits = raw.replace(/\D/g, "");
  if (!/^\d{8,9}$/.test(digits)) return false;
  const value = Number(digits);
  return value >= IRD_MIN && value <= IRD_MAX;
}

/**
 * The STRICT check for the EMPLOYER IRD number (HEI2 field 2 / HED2
 * field 2 / EIA2 field 2): mod-11 AND inside the issued range AND not
 * the 000000000 sentinel. A bad employer IRD rejects the whole file
 * ("Employer IRD number does not match IRD for this account"), so the
 * strictest spec-conformant check belongs here.
 */
export function isValidEmployerIrdNumber(raw: string): boolean {
  const digits = raw.replace(/\D/g, "");
  if (isUnsuppliedIrd(digits)) return false;
  return isInIrdIssuedRange(digits) && isValidIrdNumberForFiling(digits);
}

/** The not-supplied sentinel (DEI field 2 / DED field 2). */
export function isUnsuppliedIrd(raw: string): boolean {
  return raw.replace(/\D/g, "") === "000000000";
}

/** Normalise any stored IRD to the 9-digit filing form (zero-padded). */
export function normaliseIrd(raw: string): string {
  return raw.replace(/\D/g, "").padStart(9, "0");
}
