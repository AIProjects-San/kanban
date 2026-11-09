// ---------------------------------------------------------------------------
// P11 (PR-B09) — read-time payslip aggregates: YTD gross/net, MTD net and
// per-component YTD, the benchmark's Salary Slip period aggregates.
// docs/Fernly_HR_Payroll_Enhancement_Plan.md §7.2.1 payroll sweep.
//
// ONE pure kernel serves BOTH surfaces (the HR console's getPayrollRun and
// the employee's getMyPayslips — the caller decides the basis by which
// slips it feeds in):
//   • ordering + attribution by the run's REAL window END (P10 — mixed
//     cadences order chronologically only by date; a run belongs to the
//     calendar year/month its window ends in),
//   • YTD resets with the calendar year; MTD resets with the calendar month,
//   • WITHHELD/RELEASED slips never accumulate (P8 — a held net is not
//     paid; they carry the last accumulated values forward),
//   • component YTD merges by side+line key across slips (same-key lines
//     like a recurring "basic" sum; statistical lines are not money).
//
// Read-time by design (the plan row's scope): nothing is snapshotted, so
// OPEN-run edits are reflected on the next read and LOCKED history is
// never rewritten.
//
// No I/O, no clock, no db — the action layer owns rows and transactions.
// ---------------------------------------------------------------------------

import { fiscalYearOf } from "@/lib/payroll-windows";
import { parsePayslipLines, round2, type PayslipLine } from "@/lib/payroll-math";

/** One slip as the kernel consumes it (the stored columns + the run's
 * window end; the caller joins the run in). */
export interface AggregateSlip {
  id: string;
  userId: string;
  slipNo: string;
  gross: number;
  net: number;
  /** "" | WITHHELD | RELEASED (the Payslip column). */
  withholdStatus: string;
  /** Stored PayslipLine[] JSON (earnings). */
  earnings: string;
  /** Stored PayslipLine[] JSON (deductions). */
  deductions: string;
  /** The run's window END in ms (0 sorts first when unknown). */
  windowEndMs: number;
}

/** One per-component YTD row (side + line key + running year total). */
export interface ComponentYtdRow {
  key: string;
  label: string;
  side: "EARNING" | "DEDUCTION";
  amount: number;
}

/** The aggregates attached to one slip (values THROUGH that slip). */
export interface SlipAggregates {
  ytdNet: number;
  ytdGross: number;
  mtdNet: number;
  /** The year's component rows through this slip, largest amount first
   * (display order; the modal also looks rows up by side+key). */
  componentYtd: ComponentYtdRow[];
}

/** P16 (PR-04 opening balances) — one employee's YTD opening rows for one
 * fiscal year (annual amounts earned before this system; the caller maps
 * SalaryStructure.openingYtd + its effectiveFrom into the fiscal year).
 * gross/net openings DERIVE from the rows so Σ lines == the totals, the
 * same discipline payslip lines follow. */
export interface OpeningYtdEntry {
  userId: string;
  /** The fiscal year the opening belongs to (the year it STARTS — as
   * computed by fiscalYearOf for the structure's effectiveFrom). */
  fiscalStartYear: number;
  components: ComponentYtdRow[];
}

/** P16 (PR-11) — options for the kernel. fiscalYearStartMonth 1 (the
 * default) keeps the pre-P16 calendar-year resets byte-for-byte; openings
 * seed the given fiscal years before the first slip. */
export interface AggregateOptions {
  fiscalYearStartMonth?: number;
  openings?: OpeningYtdEntry[];
}

function monthKeyOf(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function sideKey(side: "EARNING" | "DEDUCTION", key: string): string {
  return `${side}:${key}`;
}

/** Snapshot the year's current component rows (largest first). */
function snapshotComponents(
  byYear: Map<string, Map<string, ComponentYtdRow>>,
  year: string,
): ComponentYtdRow[] {
  const rows = byYear.get(year);
  if (!rows) return [];
  return [...rows.values()].sort((a, b) => b.amount - a.amount || a.key.localeCompare(b.key));
}

/**
 * Compute running aggregates over a set of slips (any mix of users,
 * statuses and cadences). Returns per-slip values; the input array is never
 * mutated. Slips are processed in window-end order (slipNo breaks ties),
 * per USER — users never see each other's money.
 *
 * P16: with fiscalYearStartMonth ≠ 1 the YTD basis is the fiscal year
 * (resets at the fiscal boundary, not January 1 — MTD stays the calendar
 * month); openings seed each user's fiscal year BEFORE the first slip, so
 * a WITHHELD first slip still carries the opening forward (a held net is
 * not paid, but the opening is history, not this year's pay).
 */
export function computeRunningAggregates(
  slips: AggregateSlip[],
  options: AggregateOptions = {},
): Map<string, SlipAggregates> {
  const out = new Map<string, SlipAggregates>();
  const startMonth = options.fiscalYearStartMonth ?? 1;
  const sorted = [...slips].sort(
    (a, b) => a.windowEndMs - b.windowEndMs || a.slipNo.localeCompare(b.slipNo),
  );

  // Per-user running state, keyed so year/month resets are cheap. The
  // "year" key is the FISCAL year (== the calendar year at startMonth 1).
  const netByUserYear = new Map<string, number>();
  const grossByUserYear = new Map<string, number>();
  const netByUserMonth = new Map<string, number>();
  const compsByUserYear = new Map<string, Map<string, ComponentYtdRow>>();

  // P16 — openings first: seed each user's fiscal year before any slip.
  // gross/net derive from the rows (Σ earnings − Σ deductions).
  for (const o of options.openings ?? []) {
    const yk = `${o.userId}|FY${o.fiscalStartYear}`;
    let gross = 0;
    let net = 0;
    let comps = compsByUserYear.get(yk);
    if (!comps) {
      comps = new Map();
      compsByUserYear.set(yk, comps);
    }
    for (const c of o.components) {
      if (!Number.isFinite(c.amount)) continue;
      const amount = round2(c.amount);
      if (c.side === "DEDUCTION") {
        net = round2(net - amount);
      } else {
        gross = round2(gross + amount);
        net = round2(net + amount);
      }
      const sk = sideKey(c.side, c.key);
      const existing = comps.get(sk);
      if (existing) {
        existing.amount = round2(existing.amount + amount);
      } else {
        comps.set(sk, { key: c.key, label: c.label || c.key, side: c.side, amount });
      }
    }
    netByUserYear.set(yk, round2((netByUserYear.get(yk) ?? 0) + net));
    grossByUserYear.set(yk, round2((grossByUserYear.get(yk) ?? 0) + gross));
  }

  for (const s of sorted) {
    const year = String(fiscalYearOf(s.windowEndMs, startMonth));
    const yk = `${s.userId}|FY${year}`;
    const monthKey = monthKeyOf(s.windowEndMs);
    const mk = `${s.userId}|${monthKey}`;

    const held = s.withholdStatus === "WITHHELD" || s.withholdStatus === "RELEASED";
    if (!held) {
      netByUserYear.set(yk, round2((netByUserYear.get(yk) ?? 0) + s.net));
      grossByUserYear.set(yk, round2((grossByUserYear.get(yk) ?? 0) + s.gross));
      netByUserMonth.set(mk, round2((netByUserMonth.get(mk) ?? 0) + s.net));

      // Component YTD — merge by side+key; statistical lines are not money.
      let comps = compsByUserYear.get(yk);
      if (!comps) {
        comps = new Map();
        compsByUserYear.set(yk, comps);
      }
      const merge = (lines: PayslipLine[], side: "EARNING" | "DEDUCTION") => {
        for (const l of lines) {
          if (!Number.isFinite(l.amount) || l.statistical) continue;
          const sk = sideKey(side, l.key);
          const existing = comps.get(sk);
          if (existing) {
            existing.amount = round2(existing.amount + l.amount);
          } else {
            comps.set(sk, { key: l.key, label: l.label || l.key, side, amount: round2(l.amount) });
          }
        }
      };
      merge(parsePayslipLines(s.earnings), "EARNING");
      merge(parsePayslipLines(s.deductions), "DEDUCTION");
    }

    out.set(s.id, {
      // Through THIS slip: the held/released rows carry the last paid
      // values (they never accumulate), the paid rows their own totals
      // included — matching the pre-P11 ytdNet behavior on both surfaces.
      ytdNet: netByUserYear.get(yk) ?? 0,
      ytdGross: grossByUserYear.get(yk) ?? 0,
      mtdNet: netByUserMonth.get(mk) ?? 0,
      componentYtd: snapshotComponents(compsByUserYear, yk),
    });
  }

  return out;
}

/** Look up one line's component YTD amount (0 when the component has no
 * year history). Pure helper for the modal's per-line display. */
export function componentYtdAmount(
  aggregates: Pick<SlipAggregates, "componentYtd"> | undefined,
  side: "EARNING" | "DEDUCTION",
  key: string,
): number {
  const row = aggregates?.componentYtd.find((r) => r.side === side && r.key === key);
  return row ? row.amount : 0;
}
