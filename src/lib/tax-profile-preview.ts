// ---------------------------------------------------------------------------
// NZ statutory engine — Phase 3 (Task 3.4) shared preview helpers.
//
// Client-safe and PURE: the employee tax-profile editor computes the
// auto-enrolment preview LIVE on every field change (this module), while
// the server action saves through the same engine vocabulary. No DB, no
// clock, no filesystem — `today` is always a parameter.
// ---------------------------------------------------------------------------

import { autoEnrolDueDate, resolveKiwiSaverStatus } from "@/lib/payroll/nz/kiwisaver";
import { parseNzTaxCode } from "@/lib/payroll/nz/types";
import type { EmployeeTaxProfileT, TaxProfilePreviewT } from "@/lib/types";

/** UTC midnight for a YYYY-MM-DD string (the house date-only convention). */
export function utcMidnight(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

/** YYYY-MM-DD for a Date (null passes through). */
export function isoDay(d: Date | null | undefined): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

/** Decimal (0.175) → wire percent (17.5), float-noise-safe. NaN → null. */
export function pct(v: number | null | undefined): number | null {
  if (v == null || !Number.isFinite(v)) return null;
  return Math.round(v * 100 * 10_000) / 10_000;
}

/** Wire percent (17.5) → decimal (0.175), float-noise-safe. */
export function dec(v: number): number {
  return Math.round(v * 10_000) / 1_000_000;
}

const KNOWN_TAX_CODES = new Set([
  "M", "ME", "SB", "S", "SH", "ST", "SA", "ND", "STC", "CAE", "NSW", "EDW",
]);

/** Parse an IR330 declaration into base + student-loan flag (unknown bases
 * fall back to M — the editor's dropdown only offers known codes). */
export function splitTaxCode(taxCode: string): { base: string; studentLoan: boolean } {
  const { base, studentLoan } = parseNzTaxCode(taxCode);
  return { base: KNOWN_TAX_CODES.has(base) ? base : "M", studentLoan };
}

/** NZ IRD number mod-11 check (IRD's published algorithm: two weight sets,
 * 8–9 digits, zero-padded to 9). Empty is allowed ("not recorded"). */
export function isValidIrdNumber(raw: string): boolean {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 0) return true;
  if (!/^\d{8,9}$/.test(digits)) return false;
  const n = digits.padStart(9, "0").split("").map(Number);
  const weightsA = [3, 2, 7, 6, 5, 4, 3, 2];
  const weightsB = [7, 4, 3, 2, 5, 2, 7, 6];
  const checkDigit = (weights: number[]): number => {
    const sum = weights.reduce((acc, w, i) => acc + w * n[i], 0);
    const rem = sum % 11;
    if (rem === 0) return 10;
    return rem === 1 ? 0 : 11 - rem;
  };
  let c = checkDigit(weightsA);
  if (c === 10) c = checkDigit(weightsB);
  return c === n[8];
}

/** The live auto-enrolment preview: resolved KiwiSaver status against
 * `today`, the reason line, and the pending trigger date (e.g. "Temporary
 * — 28-day rule: auto-enrol on 2027-03-29"). Pure. */
export function buildTaxProfilePreview(p: EmployeeTaxProfileT, today: Date): TaxProfilePreviewT {
  const start = p.employmentStartDate ? utcMidnight(p.employmentStartDate) : null;
  const due = autoEnrolDueDate(p.employmentType, start);
  const resolution = resolveKiwiSaverStatus(
    {
      taxCode: p.studentLoan ? `${p.taxCodeBase} SL` : p.taxCodeBase,
      isCasual: p.employmentType === "CASUAL" || p.employmentType === "CASUAL_AGRICULTURAL",
      employmentCategory: p.employmentType,
      employmentStartDate: start,
      casualHolidayPayInWages: p.casualHolidayPayInWages,
      kiwiSaverStatus: p.kiwiSaverStatus,
      kiwiSaverRate: p.kiwiSaverEmployeeRate == null ? null : dec(p.kiwiSaverEmployeeRate),
      employerKiwiSaverRate: p.kiwiSaverEmployerRate == null ? null : dec(p.kiwiSaverEmployerRate),
      esctRateOverride: p.esctRateOverride == null ? null : dec(p.esctRateOverride),
      taxCodeSpecialRate: p.stcCertificateRate == null ? null : dec(p.stcCertificateRate),
      stcAccTreatment: p.stcAccTreatment,
      stcStudentLoanRate: p.stcStudentLoanRate == null ? null : dec(p.stcStudentLoanRate),
      stcStudentLoanThresholdApplies: true,
    },
    today,
  );
  return {
    resolvedStatus: resolution.status,
    reason: resolution.reason,
    autoEnrolTriggered: resolution.autoEnrolTriggered,
    dueDate: isoDay(due),
  };
}
