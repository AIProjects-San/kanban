// ---------------------------------------------------------------------------
// P5 (PR-15–18, PR-B04, F3.2) — the flexible-benefits kernel (pure).
// docs/Fernly_HR_Payroll_Enhancement_Plan.md §7.2.1 payroll sweep, item 5.
//
// A mini-ledger with the leave ledger's discipline:
//
//   • planBenefitElection — the cap rule: Σ ANNUAL elected amounts for an
//     employee-year may not exceed the structure's maxBenefits (0 = no
//     cap). Re-electing a component REPLACES its amount (upsert by
//     user+year+code), so the cap counts the NEW total, never the old.
//   • accrualAmount — one lock's accrual for one election: annual ÷ 12,
//     scaled to the slip's paid days (S5's window discipline — benefits
//     accrue on paid days only; a half-month joiner accrues half).
//   • planBenefitClaim — a claim may not exceed the ACCRUED balance of its
//     component (Σ ledger deltas — elections are not balance; only locked
//     accruals are).
//
// No I/O, no clock, no db.
// ---------------------------------------------------------------------------

import { round2 } from "@/lib/payroll/payroll-math";

/** Validate + price an election against the structure's cap. */
export function planBenefitElection(input: {
  maxBenefits: number;
  currentAnnualTotal: number;
  /** The amount the same componentCode currently contributes to the total
   * (re-election replaces, so only the delta counts against the cap). */
  currentComponentAnnual: number;
  annualAmount: number;
}): { ok: true; annualAmount: number } | { ok: false; reason: string } {
  const { maxBenefits, currentAnnualTotal, currentComponentAnnual, annualAmount } = input;
  if (!Number.isFinite(annualAmount) || annualAmount <= 0) {
    return { ok: false, reason: "The elected annual amount must be positive." };
  }
  const newTotal = round2(currentAnnualTotal - currentComponentAnnual + annualAmount);
  if (maxBenefits > 0 && newTotal > maxBenefits) {
    return {
      ok: false,
      reason: `The workspace caps this employee's benefits at $${maxBenefits.toLocaleString("en-NZ")}/year — the new election would total $${newTotal.toLocaleString("en-NZ")}.`,
    };
  }
  return { ok: true, annualAmount: round2(annualAmount) };
}

/** One lock's accrual for one election: annual ÷ 12, paid-days-scaled. */
export function accrualAmount(input: {
  annualAmount: number;
  paidDays: number | null | undefined;
  workingDays: number;
}): number {
  const { annualAmount, paidDays, workingDays } = input;
  if (!Number.isFinite(annualAmount) || annualAmount <= 0) return 0;
  const monthly = annualAmount / 12;
  if (
    paidDays == null ||
    !Number.isFinite(workingDays) ||
    workingDays <= 0 ||
    paidDays >= workingDays
  ) {
    return round2(monthly);
  }
  return round2((monthly * paidDays) / workingDays);
}

/** The projected balance of one component: Σ ledger deltas. */
export function benefitBalance(deltas: ReadonlyArray<{ delta: number }>): number {
  return round2(deltas.reduce((s, d) => s + (Number.isFinite(d.delta) ? d.delta : 0), 0));
}

/** Validate a claim against the accrued balance (per component). */
export function planBenefitClaim(input: {
  balance: number;
  amount: number;
}): { ok: true; amount: number } | { ok: false; reason: string } {
  const { balance, amount } = input;
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, reason: "The claim amount must be positive." };
  }
  if (amount > balance) {
    return {
      ok: false,
      reason: `Only $${balance.toLocaleString("en-NZ")} has accrued for this benefit — claims cannot outrun locked accruals.`,
    };
  }
  return { ok: true, amount: round2(amount) };
}

/** The adjustment label for a benefit payout (test-pinned). */
export function benefitPayoutLabel(componentCode: string, label: string): string {
  return `Benefit claim — ${label || componentCode}`;
}
