// ---------------------------------------------------------------------------
// P6 (PR-20/PR-23, PR-T01, F3.2-adjacent) — the retention-bonus kernel (pure).
// docs/Fernly_HR_Payroll_Enhancement_Plan.md §7.2.1 payroll sweep, item 6.
//
// A retention bonus pays a total amount in N monthly installments through
// the P1 adapter (one RECURRING row: first period → endPeriod, the
// per-installment amount). The split rule: equal installments rounded to
// the cent, with the LAST installment absorbing the rounding remainder so
// Σ installments == the total exactly (money never drifts).
//
// No I/O, no clock, no db.
// ---------------------------------------------------------------------------

import { round2 } from "@/lib/payroll-math";

export function planRetentionBonus(input: {
  totalAmount: number;
  installments: number;
}): { ok: true; perInstallment: number; lastInstallment: number } | { ok: false; reason: string } {
  const { totalAmount, installments } = input;
  if (!Number.isFinite(totalAmount) || totalAmount <= 0) {
    return { ok: false, reason: "The bonus total must be positive." };
  }
  if (!Number.isInteger(installments) || installments < 1 || installments > 12) {
    return { ok: false, reason: "Installments run from 1 to 12 (monthly payments)." };
  }
  const perInstallment = round2(totalAmount / installments);
  if (perInstallment <= 0) {
    return { ok: false, reason: "The total is too small to split over that many installments." };
  }
  // The last installment absorbs the rounding remainder: Σ == total exactly.
  const lastInstallment = round2(totalAmount - perInstallment * (installments - 1));
  return { ok: true, perInstallment, lastInstallment };
}

/** The Nth period key after `firstPeriod` ("YYYY-MM" + n months). Pure. */
export function periodPlusMonths(firstPeriod: string, n: number): string {
  const [y, m] = firstPeriod.split("-").map(Number);
  if (!y || !m || m < 1 || m > 12) return firstPeriod;
  const total = (y * 12 + (m - 1)) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return `${ny}-${String(nm).padStart(2, "0")}`;
}

/** The adjustment label for a retention bonus (test-pinned). */
export function retentionBonusLabel(userName: string): string {
  return `Retention bonus — ${userName}`;
}
