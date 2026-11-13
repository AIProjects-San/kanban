// F1.2 — leave ledger projection, pure core
// (docs/Fernly_HR_Payroll_Enhancement_Plan.md §7.1).
//
// Pure and dependency-free so BOTH sides import it:
//   • server actions — the approve-time overdraft guard and the cache sync
//     both project balances from ledger aggregate rows
//     (src/server-actions/hr-leave.ts, src/server-actions/hr-shared.ts);
//   • unit tests — the full invariant matrix lives here, not in mocks.
//
// Semantics (entryType → which cache column a delta settles into):
//   • GRANT    → entitled      (positive; the year-start entitlement)
//   • CARRY    → carriedOver   (positive; year rollover, F2.4 writer)
//   • CONSUME  → used          (negative on approval; positive reversal on
//                cancel — reversals count into the SAME sum, so a
//                consume/reverse pair nets to zero and `used` equals the
//                days of APPROVED-but-not-cancelled requests)
//   • EXPIRE   → adjustments   (negative; year-end cap enforcement, F2.4)
//   • ADJUST   → adjustments   (signed; drift reconciliation / manual trues)
//   available  = entitled + carriedOver + adjustments − used = Σ(all deltas)
//
// EXPIRE deliberately does NOT touch `used`: expiry is an entitlement-side
// reduction (days that were granted and then lapsed), not consumption — the
// benchmark books it the same way (negative allocation-side ledger row).
//
// All output fields are rounded to 2 decimals to kill float dust (the
// 0.5/0.25 day fractions of F1.1 are binary-exact, but ADJUST rows may
// carry legacy values that are not).
//
// Rows come from a `groupBy entryType` aggregate — the shape is
// { entryType, delta } per group, NOT individual rows.

import { round2 } from "@/lib/payroll/payroll-math";

export type LeaveLedgerEntryType =
  | "GRANT"
  | "CARRY"
  | "CONSUME"
  | "EXPIRE"
  | "ADJUST";

/** One aggregated ledger group: an entryType and its summed delta. */
export interface LeaveLedgerGroup {
  entryType: string;
  delta: number;
}

/** The projected balance a (userId, leaveTypeId, year) ledger stands for. */
export interface LeaveLedgerProjection {
  /** Σ GRANT deltas — entitlement granted this year. */
  entitled: number;
  /** Σ CARRY deltas — days carried over from the previous year. */
  carriedOver: number;
  /** −Σ CONSUME deltas (reversals included) — days consumed, net. */
  used: number;
  /** Σ EXPIRE + ADJUST deltas — entitlement-side corrections, net. */
  adjustments: number;
  /** Σ ALL deltas — the number every overdraft guard must compare against. */
  available: number;
}

/**
 * Project the balance columns from aggregated ledger groups. Unknown
 * entryTypes count into `available` only (their column is none of the
 * cache's business, but their days are still real days) — a forward-only
 * reading that keeps the guard honest if a future writer adds a type.
 */
export function projectLeaveBalance(
  groups: ReadonlyArray<LeaveLedgerGroup>,
): LeaveLedgerProjection {
  let entitled = 0;
  let carriedOver = 0;
  let used = 0; // accumulated NEGATIVE (the raw Σ of CONSUME deltas)
  let adjustments = 0;
  let total = 0;

  for (const g of groups) {
    const d = Number.isFinite(g.delta) ? g.delta : 0;
    total += d;
    switch (g.entryType) {
      case "GRANT":
        entitled += d;
        break;
      case "CARRY":
        carriedOver += d;
        break;
      case "CONSUME":
        used += d; // negative (or a positive reversal)
        break;
      case "EXPIRE":
      case "ADJUST":
        adjustments += d;
        break;
      default:
        // Unknown type — already folded into `total`, touches no column.
        break;
    }
  }

  return {
    entitled: round2(entitled),
    carriedOver: round2(carriedOver),
    used: round2(-used),
    adjustments: round2(adjustments),
    available: round2(total),
  };
}

/**
 * LV-10 (S9) — plan an HR leave adjustment against the floor. Pure: given
 * the CURRENT available balance, the signed delta, and the policy's
 * negative floor (0 when allowNegative is off), returns the resulting
 * balance and whether it stays within the floor. Consumption and
 * corrections share the same bound — an adjustment can never dig a deeper
 * hole than the policy's advance-leave floor.
 */
export function planLeaveAdjustment(input: {
  available: number;
  delta: number;
  negativeFloor: number;
}): { newAvailable: number; withinFloor: boolean } {
  const newAvailable = round2(input.available + input.delta);
  const floor = Math.max(0, input.negativeFloor);
  return { newAvailable, withinFloor: newAvailable >= -floor };
}
