// ---------------------------------------------------------------------------
// Phase 2 (payday filing) — shared formatting + structural guards for the
// IRD CSV record builders (EI / ED / EIA2). Every rule here is a hard
// myIR validation: a violation rejects the whole file, so the builders
// THROW instead of emitting a bad line.
//
//   • Amounts are INTEGER CENTS — never a decimal point, never a comma
//     ("37.5 hours worked is entered as 3750. A deduction of $3.50 is
//     entered as 350." — myIR error catalogue).
//   • Dates are CCYYMMDD with no separators and must be real calendar
//     dates.
//   • No field may contain a comma or a newline (commas are the record
//     separator; Excel round-trips are forbidden).
//
// Pure: no DB, no clock.
// ---------------------------------------------------------------------------

/** A structural problem in a would-be IRD file line. Always fatal. */
export class IrdFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IrdFormatError";
  }
}

/**
 * Dollars (float, the Fernly payslip convention) → integer cents. Throws
 * on non-finite input. Callers assert non-negativity where the spec
 * demands it (every field in Phase 2's builders — downward corrections
 * go through an EIA2 amendment, never a negative EI field).
 */
export function toCents(amount: number, field: string): number {
  if (!Number.isFinite(amount)) {
    throw new IrdFormatError(`${field}: amount is not a finite number.`);
  }
  const cents = Math.round(amount * 100);
  if (Math.abs(cents) > Number.MAX_SAFE_INTEGER) {
    throw new IrdFormatError(`${field}: amount out of range.`);
  }
  return cents;
}

/** Assert an integer-cents amount is a valid filed value (integer,
 * non-negative — no decimals, no minus signs ever reach the file). */
export function assertCents(cents: number, field: string): number {
  if (!Number.isInteger(cents)) {
    throw new IrdFormatError(`${field}: must be integer cents (got ${cents}) — decimals are never written to an IRD file.`);
  }
  if (cents < 0) {
    throw new IrdFormatError(`${field}: negative amounts (${cents}) are never written to an IRD file — correct the source data or file an EIA2 amendment instead.`);
  }
  return cents;
}

/** Date → CCYYMMDD (UTC — every filing date is a date-only UTC value in
 * Fernly). Throws for invalid Date objects. */
export function ccyyMMdd(d: Date, field: string): string {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) {
    throw new IrdFormatError(`${field}: not a valid date.`);
  }
  const y = d.getUTCFullYear();
  if (y < 1000 || y > 9999) {
    throw new IrdFormatError(`${field}: year ${y} outside the CCYYMMDD format.`);
  }
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${y}${mm}${dd}`;
}

/** Parse a CCYYMMDD string back to its UTC midnight — validates the
 * format AND the calendar (rejects 20260230). Returns null on failure. */
export function parseCcyyMMdd(raw: string): Date | null {
  if (!/^\d{8}$/.test(raw)) return null;
  const y = Number(raw.slice(0, 4));
  const m = Number(raw.slice(4, 6));
  const d = Number(raw.slice(6, 8));
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return date;
}

/**
 * Guard a text field: no commas, no newlines, and (when required) not
 * blank. Returns the value unchanged.
 */
export function assertSafeText(value: string, field: string, opts: { required?: boolean; maxLength?: number } = {}): string {
  const v = value ?? "";
  if (/[,`\r\n]/.test(v)) {
    throw new IrdFormatError(`${field}: commas and line breaks are never allowed inside an IRD file field (found in "${v.slice(0, 40)}").`);
  }
  if (opts.required && v.trim() === "") {
    throw new IrdFormatError(`${field}: this field is required and cannot be blank.`);
  }
  if (opts.maxLength != null && v.length > opts.maxLength) {
    throw new IrdFormatError(`${field}: ${v.length} characters exceeds the maximum of ${opts.maxLength}.`);
  }
  return v;
}

export interface SplitName {
  first: string;
  middle: string;
  last: string;
  /** The EI/ED filed form: "Surname Firstnames" — single space, no
   * commas (DEI field 3 / DED field 3, matching IRD's sample files). */
  surnameFirstnames: string;
}

/**
 * Split Fernly's single full-name field into first/middle/last.
 *
 * Fernly stores one display name ("Hana Park", "Mary Jane Smith"). The
 * ED file REQUIRES separate first and last name fields (since Oct 2026 a
 * missing first or last name fails myIR validation outright), so the
 * split is: FIRST token = first name, LAST token = last name, everything
 * between = middle name(s). A single-token name cannot be split and is
 * REFUSED (filed nowhere, guessed nowhere). Documented in ADR-018.
 */
export function splitFullName(fullName: string, context: string): SplitName {
  const raw = fullName ?? "";
  if (/[,\r\n]/.test(raw)) {
    throw new IrdFormatError(
      `${context}: the employee name "${raw.slice(0, 40)}" contains a comma or line break — IRD file fields never do.`,
    );
  }
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 2) {
    throw new IrdFormatError(
      `${context}: the employee name "${fullName}" cannot be split into a first and last name, and IRD requires both on an Employee Details line. Record the employee's full name (first and last) before filing.`,
    );
  }
  const first = tokens[0];
  const last = tokens[tokens.length - 1];
  const middle = tokens.slice(1, -1).join(" ");
  const firstnames = middle ? `${first} ${middle}` : first;
  return { first, middle, last, surnameFirstnames: `${last} ${firstnames}` };
}

/** Join record fields with the CSV separator — the ONE place commas are
 * introduced, so the builders never interpolate a comma by accident. */
export function joinRecord(fields: Array<string | number>): string {
  return fields.map((f) => String(f)).join(",");
}
