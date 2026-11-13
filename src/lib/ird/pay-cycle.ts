// ---------------------------------------------------------------------------
// Phase 2 (payday filing) — the pay cycle codes for EI/ED file fields
// ("Employee pay cycle", DEI field 9 / DTI-DAI field 9).
//
// CONFIRMED against IRD's Payday Filing File Upload Specification
// (2026-27, §3.4.1.2 field 9):
//   Weekly (WK) · Four-weekly (4W) · Fortnightly (FT) · Monthly (MT) ·
//   Daily (DA) · Ad hoc/Irregularly (AH) · Half monthly (HM, twice a month)
//
// NOTE — two codes deliberately differ from the Phase 2 task brief, which
// asked for confirmation rather than trust: the brief's tentative "FN"
// (fortnightly) is actually FT, and "SM" does not exist — the twice-a-month
// code is HM. Fernly's BIMONTHLY cadence is twice a month (1st–15th /
// 16th–end, lib/payroll/payroll-windows.ts), so it maps to HM, NOT to 4W.
//
// QUARTERLY and ANNUAL have no pay cycle code in the spec and are REFUSED:
// guessing a code burns a filing cycle. (AH exists for ad hoc/irregular
// payments, but silently mapping a quarterly salary run onto it would be a
// guess, not a confirmation.)
//
// Pure: no DB, no clock.
// ---------------------------------------------------------------------------

import type { PayrollFrequency } from "@/lib/payroll/payroll-windows";

/** The spec-confirmed pay cycle codes (the closed set IRD accepts). */
export const PAY_CYCLE_CODES = ["WK", "4W", "FT", "MT", "DA", "AH", "HM"] as const;

export type PayCycleCode = (typeof PAY_CYCLE_CODES)[number];

/** Fernly cadence → IRD pay cycle code. Throws for QUARTERLY/ANNUAL (no
 * confirmed code exists — the caller surfaces the refusal). */
export function mapPayCycle(frequency: PayrollFrequency | string): PayCycleCode {
  switch (frequency) {
    case "WEEKLY":
      return "WK";
    case "FORTNIGHTLY":
      return "FT";
    case "MONTHLY":
      return "MT";
    case "BIMONTHLY":
      return "HM"; // twice a month — NOT four-weekly
    case "DAILY":
      return "DA";
    default:
      throw new Error(
        `No IRD pay cycle code is confirmed for the "${frequency}" cadence — payday filing supports weekly, fortnightly, monthly, twice-monthly and daily runs only (spec codes WK/FT/MT/HM/DA). File this run on a supported cadence or confirm the mapping with IRD before filing.`,
      );
  }
}

/** IRD pay cycle code → Fernly cadence — the inverse table. Ad hoc (AH)
 *  and four-weekly (4W) have no Fernly cadence and pass through unchanged. */
export function payCycleToFrequency(code: string): string {
  switch (code) {
    case "WK":
      return "WEEKLY";
    case "FT":
      return "FORTNIGHTLY";
    case "HM":
      return "BIMONTHLY";
    case "DA":
      return "DAILY";
    case "MT":
      return "MONTHLY";
    default:
      return code;
  }
}

/** True when the cadence has a confirmed pay cycle code (UI gating). */
export function isFilingCadence(frequency: PayrollFrequency | string): boolean {
  return ["WEEKLY", "FORTNIGHTLY", "MONTHLY", "BIMONTHLY", "DAILY"].includes(frequency);
}
