// ---------------------------------------------------------------------------
// NZ statutory engine — Phase 3 (Task 3.4) shared preview helpers.
//
// Client-safe and PURE: the employee tax-profile editor computes the
// auto-enrolment preview LIVE on every field change (this module), while
// the server action saves through the same engine vocabulary. No DB, no
// clock, no filesystem — `today` is always a parameter.
// ---------------------------------------------------------------------------

import { autoEnrolDueDate, resolveKiwiSaverDecision } from "@/lib/payroll/nz/kiwisaver";
import { isValidIrdNumberForFiling } from "@/lib/ird/ird-number";
import { parseNzTaxCode } from "@/lib/payroll/nz/types";
import { IR330_BASE_CODES } from "@/lib/payroll/nz/tax-codes";
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

const KNOWN_TAX_CODES = new Set<string>(IR330_BASE_CODES);

/** Parse an IR330 declaration into base + student-loan flag (unknown bases
 * fall back to M — the editor's dropdown only offers known codes). */
export function splitTaxCode(taxCode: string): { base: string; studentLoan: boolean } {
  const { base, studentLoan } = parseNzTaxCode(taxCode);
  return { base: KNOWN_TAX_CODES.has(base) ? base : "M", studentLoan };
}

/** NZ IRD number mod-11 check — delegates to the spec-exact validator
 * (IRD "Payday Filing File Upload Specification" appendix 5.8, verified
 * against its four worked examples). Empty is allowed ("not recorded").
 * The pre-Phase-2 local copy transposed the remainder-0/remainder-1 rules
 * and rejected IRD's own example numbers; the write path and the filing
 * layer must never disagree. */
export function isValidIrdNumber(raw: string): boolean {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 0) return true;
  return isValidIrdNumberForFiling(digits);
}

/** The live auto-enrolment preview: resolved KiwiSaver status against
 * `today`, the reason line, and the pending trigger date (e.g. "Temporary
 * — 28-day rule: auto-enrol on 2027-03-29"). Pure. */
export function buildTaxProfilePreview(p: EmployeeTaxProfileT, today: Date): TaxProfilePreviewT {
  const start = p.employmentStartDate ? utcMidnight(p.employmentStartDate) : null;
  const due = autoEnrolDueDate(p.employmentType, start);
  const decision = resolveKiwiSaverDecision(
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
    resolvedStatus: decision.status,
    reason: decision.reason,
    autoEnrolTriggered: decision.autoEnrolTriggered,
    dueDate: isoDay(due),
  };
}
