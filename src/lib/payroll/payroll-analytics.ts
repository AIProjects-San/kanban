// ---------------------------------------------------------------------------
// P22 (PR-C01–04, PR-N01–06) — read-time payroll analytics: the benchmark's
// four payroll charts (outgoing salary, department-wise salary, designation-
// wise salary, benefit claims) and its six number cards, Fernly-shaped.
// docs/Fernly_HR_Payroll_Enhancement_Plan.md §7.2.1 payroll sweep, item P22.
//
// ONE pure kernel builds every number the Payroll view's analytics panel
// renders; the caller (getPayrollAnalytics) owns rows and permissions:
//   • month attribution by the run's REAL window END (P10 — mixed cadences
//     order and bucket chronologically only by date; a run belongs to the
//     month its window ends in, the same discipline payslip-aggregates uses),
//   • outgoing salary counts DISBURSED money only — a WITHHELD slip's net is
//     not paid in its own month, and a RELEASED slip's money pays exactly
//     once, in the later period whose slip carries the WITHHELD_RELEASE
//     earnings line (P8 — the adapter pays it there, so the trend counts it
//     there; the held original stays excluded, money never double-counts),
//   • department/designation slices cover the LATEST PAID MONTH (the
//     benchmark's "last month"), gross-based ("salary" = the gross cost),
//     honest "No department" / "No job title" buckets for unprofiled rows,
//   • the two statutory cards (tax exemption proofs, declarations submitted)
//     carry `statutoryDeclined` instead of a fake zero — ADR-014 keeps the
//     statutory machinery out, so the surface renders "—" with the banner.
//
// Read-time by design: nothing is snapshotted, OPEN-run edits reflect on the
// next read, LOCKED history is never rewritten.
//
// No I/O, no clock, no db — the action layer owns rows and transactions.
// ---------------------------------------------------------------------------

import { round2 } from "@/lib/payroll/payroll-math";

/** One LOCKED-run payslip as the kernel consumes it (stored columns + the
 * joined profile dimensions + the run's window end). */
export interface AnalyticsSlip {
  userId: string;
  gross: number;
  net: number;
  /** "" | WITHHELD | RELEASED (the Payslip column). */
  withholdStatus: string;
  /** EmployeeProfile.department ("" = none on record). */
  department: string;
  /** EmployeeProfile.jobTitle ("" = none on record). */
  jobTitle: string;
  /** The run's window END in ms (0 falls out of every bucket). */
  windowEndMs: number;
}

/** One benefit claim (a negative CLAIM row on the BenefitAccrual ledger). */
export interface AnalyticsClaim {
  /** Claimed magnitude (positive; the ledger row's delta is negative). */
  amount: number;
  /** The claim's window END in ms (the consuming month). */
  windowEndMs: number;
}

/** One incentive row (a PayAdjustment with sourceType INCENTIVE). */
export interface AnalyticsIncentive {
  amount: number;
}

/** One month bucket of the outgoing-salary trend. */
export interface MonthPoint {
  /** "YYYY-MM" (UTC, window-end attribution). */
  monthKey: string;
  /** "Nov 2026" (display). */
  label: string;
  net: number;
  gross: number;
}

/** One categorical row of a salary-by-dimension chart. */
export interface DimensionRow {
  label: string;
  amount: number;
  slipCount: number;
}

/** One month bucket of the benefit-claims trend. */
export interface ClaimPoint {
  monthKey: string;
  label: string;
  amount: number;
  count: number;
}

/** The six number cards (PR-N01–06). */
export interface PayrollCards {
  /** Σ disbursed net over the trend window (the honest window rides the
   * panel label — the chart and the card agree by construction). */
  totalOutgoingSalary: number;
  /** Months the card total covers (0 = no locked runs yet). */
  outgoingSalaryMonths: number;
  /** Count of ACTIVE salary structures. */
  totalSalaryStructures: number;
  /** All-time claimed magnitude + claim count. */
  benefitClaimsTotal: number;
  benefitClaimsCount: number;
  /** All-time INCENTIVE PayAdjustment magnitude + row count. */
  incentiveTotal: number;
  incentiveCount: number;
  /** Always true — the two statutory cards render "—" with the ADR-014
   * banner instead of a misleading zero (tax machinery is declined). */
  statutoryDeclined: true;
}

/** The full analytics payload one action call produces. */
export interface PayrollAnalytics {
  outgoing: MonthPoint[];
  departmentSalary: { anchorMonth: string | null; rows: DimensionRow[]; total: number };
  designationSalary: { anchorMonth: string | null; rows: DimensionRow[]; total: number };
  benefitClaims: ClaimPoint[];
  cards: PayrollCards;
}

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** "2026-11" style key of a ms timestamp (UTC). */
function monthKeyOf(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** "Nov 2026" display label for a "YYYY-MM" key. */
export function monthLabelOf(monthKey: string): string {
  const [y, m] = monthKey.split("-").map(Number);
  if (!y || !m || m < 1 || m > 12) return monthKey;
  return `${MONTHS[m - 1]} ${y}`;
}

/** Disbursed-only filter: WITHHELD nets were never paid in their month and
 * RELEASED money returns through its release-period slip (P8). */
function disbursed(s: AnalyticsSlip): boolean {
  return s.withholdStatus === "";
}

// ---------------------------------------------------------------------------
// PR-C01 — outgoing salary (disbursed net per month, trailing window)
// ---------------------------------------------------------------------------

/** The trailing-N-months disbursed trend (N = months, default 12; the LAST
 * N buckets that actually have money — a sparse early history is not padded
 * with zero months the chart would render as empty bars). */
export function buildOutgoingSalarySeries(
  slips: AnalyticsSlip[],
  months = 12,
): MonthPoint[] {
  const byMonth = new Map<string, MonthPoint>();
  for (const s of slips) {
    if (!disbursed(s) || !Number.isFinite(s.windowEndMs) || s.windowEndMs <= 0) continue;
    const key = monthKeyOf(s.windowEndMs);
    const row = byMonth.get(key) ?? { monthKey: key, label: monthLabelOf(key), net: 0, gross: 0 };
    row.net = round2(row.net + s.net);
    row.gross = round2(row.gross + s.gross);
    byMonth.set(key, row);
  }
  const sorted = [...byMonth.values()].sort((a, b) => a.monthKey.localeCompare(b.monthKey));
  const n = Math.max(1, Math.floor(months));
  return sorted.slice(Math.max(0, sorted.length - n));
}

// ---------------------------------------------------------------------------
// PR-C02 / PR-C03 — salary by department / designation (latest paid month)
// ---------------------------------------------------------------------------

/** The latest monthKey that carries any DISBURSED slip (null = nothing paid
 * yet — the charts render their honest empty state). */
export function latestPaidMonth(slips: AnalyticsSlip[]): string | null {
  let latest: string | null = null;
  for (const s of slips) {
    if (!disbursed(s) || !Number.isFinite(s.windowEndMs) || s.windowEndMs <= 0) continue;
    const key = monthKeyOf(s.windowEndMs);
    if (latest === null || key > latest) latest = key;
  }
  return latest;
}

/** Group the anchor month's disbursed gross by one profile dimension,
 * largest bucket first. Missing values get their own honest bucket. */
export function buildSalaryByDimension(
  slips: AnalyticsSlip[],
  dimension: "department" | "jobTitle",
  anchorMonth: string | null,
): DimensionRow[] {
  if (!anchorMonth) return [];
  const fallback = dimension === "department" ? "No department" : "No job title";
  const byLabel = new Map<string, DimensionRow>();
  for (const s of slips) {
    if (!disbursed(s) || !Number.isFinite(s.windowEndMs) || s.windowEndMs <= 0) continue;
    if (monthKeyOf(s.windowEndMs) !== anchorMonth) continue;
    const label = (dimension === "department" ? s.department : s.jobTitle).trim() || fallback;
    const row = byLabel.get(label) ?? { label, amount: 0, slipCount: 0 };
    row.amount = round2(row.amount + s.gross);
    row.slipCount += 1;
    byLabel.set(label, row);
  }
  return [...byLabel.values()].sort((a, b) => b.amount - a.amount || a.label.localeCompare(b.label));
}

// ---------------------------------------------------------------------------
// PR-C04 — benefit claims (claimed magnitude per month, trailing window)
// ---------------------------------------------------------------------------

export function buildBenefitClaimsSeries(claims: AnalyticsClaim[], months = 12): ClaimPoint[] {
  const byMonth = new Map<string, ClaimPoint>();
  for (const c of claims) {
    if (!Number.isFinite(c.windowEndMs) || c.windowEndMs <= 0) continue;
    const key = monthKeyOf(c.windowEndMs);
    const row = byMonth.get(key) ?? { monthKey: key, label: monthLabelOf(key), amount: 0, count: 0 };
    row.amount = round2(row.amount + c.amount);
    row.count += 1;
    byMonth.set(key, row);
  }
  const sorted = [...byMonth.values()].sort((a, b) => a.monthKey.localeCompare(b.monthKey));
  const n = Math.max(1, Math.floor(months));
  return sorted.slice(Math.max(0, sorted.length - n));
}

// ---------------------------------------------------------------------------
// PR-N01–06 — the number cards
// ---------------------------------------------------------------------------

/** Derive the card values from the built series + the caller's counts.
 * `activeStructures` is the count the caller read (the Payroll view's own
 * active count must agree with it — same source, one action). */
export function buildPayrollCards(input: {
  outgoing: MonthPoint[];
  activeStructures: number;
  claims: AnalyticsClaim[];
  incentives: AnalyticsIncentive[];
}): PayrollCards {
  const claimsTotal = input.claims.reduce((sum, c) => sum + (Number.isFinite(c.amount) ? c.amount : 0), 0);
  const incentiveTotal = input.incentives.reduce((sum, i) => sum + (Number.isFinite(i.amount) ? i.amount : 0), 0);
  return {
    totalOutgoingSalary: round2(input.outgoing.reduce((sum, m) => sum + m.net, 0)),
    outgoingSalaryMonths: input.outgoing.length,
    totalSalaryStructures: Math.max(0, Math.floor(input.activeStructures)),
    benefitClaimsTotal: round2(claimsTotal),
    benefitClaimsCount: input.claims.length,
    incentiveTotal: round2(incentiveTotal),
    incentiveCount: input.incentives.length,
    statutoryDeclined: true,
  };
}

// ---------------------------------------------------------------------------
// The composer — ONE call builds the whole payload
// ---------------------------------------------------------------------------

/** Build the full analytics payload (the action feeds raw rows in, the view
 * renders the result out — no derived state in between). */
export function buildPayrollAnalytics(input: {
  slips: AnalyticsSlip[];
  claims: AnalyticsClaim[];
  incentives: AnalyticsIncentive[];
  activeStructures: number;
  months?: number;
}): PayrollAnalytics {
  const months = input.months ?? 12;
  const outgoing = buildOutgoingSalarySeries(input.slips, months);
  const anchorMonth = latestPaidMonth(input.slips);
  const dimension = (dim: "department" | "jobTitle") => {
    const rows = buildSalaryByDimension(input.slips, dim, anchorMonth);
    return {
      anchorMonth,
      rows,
      total: round2(rows.reduce((sum, r) => sum + r.amount, 0)),
    };
  };
  return {
    outgoing,
    departmentSalary: dimension("department"),
    designationSalary: dimension("jobTitle"),
    benefitClaims: buildBenefitClaimsSeries(input.claims, months),
    cards: buildPayrollCards({
      outgoing,
      activeStructures: input.activeStructures,
      claims: input.claims,
      incentives: input.incentives,
    }),
  };
}
