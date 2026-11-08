// F2.4 — leave policy engine, pure core
// (docs/Fernly_Policy_Engine_Design.md §4; docs/Fernly_HR_Payroll_
// Enhancement_Plan.md §7.2 F2.4).
//
// Pure and dependency-free (only date arithmetic) so BOTH sides import it:
//   • server actions — the request/approve balance guards (floor-aware),
//     the strategy-aware materialization writers, the day count's
//     include-holiday mode, and the service-eligibility gate
//     (src/server-actions/hr-leave.ts, hr-shared.ts);
//   • the cron job — runLeaveAllocationJob advances every strategy with
//     the same dueGrantOps rule (src/lib/leave-allocation-core.ts);
//   • unit tests — the full strategy matrix lives here, not in mocks.
//
// The two laws of the policy design (docs/Fernly_Policy_Engine_Design.md
// §2) apply to this file verbatim: RULES DECIDE (deterministic, clock-free,
// I/O-free — `asOf` is always an injected "YYYY-MM-DD"), POLICY IS DATA
// (resolveLeavePolicy turns DB-shaped rows into the defaulted object every
// rule consumes; unknown enum values fail LOUD, never silently default).
//
// Strategy semantics (one leave type = one strategy, F2.4 §9.5):
//   MANUAL          grant-on-first-use materialization (the pre-F2.4 path;
//                   the SERVICE handles it — dueGrantOps returns [] because
//                   nothing is scheduled).
//   ANNUAL_LUMP_SUM the whole year at once: Jan 1 (grantOn PERIOD_START,
//                   optional DOJ pro-rata by calendar days remaining) or on
//                   each hire anniversary (grantOn ANNIVERSARY).
//   EARNED          accrual in periods (MONTHLY/QUARTERLY/HALF_YEARLY/
//                   ANNUAL); each period's grant lands on allocateOnDay;
//                   the last period of the year true-ups so a full-year
//                   employee accrues EXACTLY annualDays despite rounding.
//   AFTER_SERVICE   annualDays deposited once hireDate + minServiceMonths
//                   elapses, repeating every 12 months after that.
//
// Shared rules:
//   • Employment eligibility: a period is granted only if the employee was
//     hired on or before the period's landing date (hireDate <= dueDate).
//     With allocateOnDay DOJ_DAY the hire month's grant lands on the join
//     day itself; with FIRST/LAST the hire month is skipped (a partial
//     month never accrues under those modes — the conservative reading).
//     No hireDate on record = full eligibility (the pre-F2.4 materializer
//     never needed one either).
//   • Probation gate (accrueDuringProbation=false): the landing moment is
//     deferred to probationEndsAt when it is known and later; a PROBATION
//     employee with no probationEndsAt accrues nothing until HR records the
//     date (honest: unmanaged is unmanaged).
//   • Cap (EARNED only, accrualCap null → annualDays): a STANDING cap —
//     room = cap − availableNow, so consumed days free room and the
//     strategy may re-earn up to the cap (never past it).
//   • Idempotency: every op carries a deterministic periodKey that becomes
//     the ledger GRANT row's sourceId (sourceType "POLICY"); writers skip
//     keys that already exist. Double-run ⇒ single row.
//
// All dates are "YYYY-MM-DD" strings; arithmetic is UTC-midnight based.

import type {
  LeaveAccrualFrequency,
  LeaveAccrualRounding,
  LeaveAllocationStrategy,
  LeaveAllocateOnDay,
  LeaveGrantOn,
} from "@/lib/types";

// ---------------------------------------------------------------------------
// Policy resolution — DB row → defaulted rule input
// ---------------------------------------------------------------------------

/** The DB-shaped policy row (Prisma LeavePolicy, nullable columns as-is). */
export interface LeavePolicyRow {
  annualDays: number;
  maxCarryOver: number;
  minNoticeDays: number;
  maxConsecutiveDays: number;
  allocationStrategy?: string | null;
  accrualFrequency?: string | null;
  allocateOnDay?: string | null;
  accrualRounding?: string | null;
  accrualCap?: number | null;
  grantOn?: string | null;
  prorateForJoiners?: boolean | null;
  minServiceMonths?: number | null;
  accrueDuringProbation?: boolean | null;
  allowNegative?: boolean | null;
  negativeFloor?: number | null;
  carryExpiresAfterMonths?: number | null;
  countHolidaysInLeave?: boolean | null;
}

/** The defaulted policy every rule consumes (no nulls, no unknowns). */
export interface ResolvedLeavePolicy {
  annualDays: number;
  maxCarryOver: number;
  minNoticeDays: number;
  maxConsecutiveDays: number;
  allocationStrategy: LeaveAllocationStrategy;
  accrualFrequency: LeaveAccrualFrequency;
  allocateOnDay: LeaveAllocateOnDay;
  accrualRounding: LeaveAccrualRounding;
  /** EARNED standing cap; null cap resolves to annualDays. */
  accrualCap: number;
  grantOn: LeaveGrantOn;
  prorateForJoiners: boolean;
  minServiceMonths: number;
  accrueDuringProbation: boolean;
  allowNegative: boolean;
  /** How far below zero the balance may go (days). Only read when
   * allowNegative — a floor without the switch is inert data. */
  negativeFloor: number;
  carryExpiresAfterMonths: number | null;
  countHolidaysInLeave: boolean;
}

const STRATEGIES: LeaveAllocationStrategy[] = ["MANUAL", "ANNUAL_LUMP_SUM", "EARNED", "AFTER_SERVICE"];
const FREQUENCIES: LeaveAccrualFrequency[] = ["MONTHLY", "QUARTERLY", "HALF_YEARLY", "ANNUAL"];
const ALLOCATE_ON: LeaveAllocateOnDay[] = ["FIRST", "LAST", "DOJ_DAY"];
const ROUNDINGS: LeaveAccrualRounding[] = ["FLOOR_QUARTER", "NEAREST"];
const GRANT_ON: LeaveGrantOn[] = ["PERIOD_START", "ANNIVERSARY"];

function pickEnum<T extends string>(value: string | null | undefined, allowed: T[], fallback: T, field: string): T {
  if (value === null || value === undefined || value === "") return fallback;
  if ((allowed as string[]).includes(value)) return value as T;
  // Design doc §10.6 — fail LOUD: a corrupt policy row must stop the
  // request (surfacing as the action's typed error), never quietly change
  // entitlement math.
  throw new Error(`Unknown ${field} on leave policy: "${value}"`);
}

function pickNumber(value: number | null | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function pickBool(value: boolean | null | undefined, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/** Resolve a policy row (or null = no policy at all) into rule input.
 * Every default is the pre-F2.4 behavior — resolve(null) is the classic
 * overdraft-guard world. */
export function resolveLeavePolicy(row: LeavePolicyRow | null | undefined): ResolvedLeavePolicy {
  return {
    annualDays: pickNumber(row?.annualDays, 0),
    maxCarryOver: pickNumber(row?.maxCarryOver, 0),
    minNoticeDays: pickNumber(row?.minNoticeDays, 1),
    maxConsecutiveDays: pickNumber(row?.maxConsecutiveDays, 15),
    allocationStrategy: pickEnum(row?.allocationStrategy, STRATEGIES, "MANUAL", "allocationStrategy"),
    accrualFrequency: pickEnum(row?.accrualFrequency, FREQUENCIES, "MONTHLY", "accrualFrequency"),
    allocateOnDay: pickEnum(row?.allocateOnDay, ALLOCATE_ON, "FIRST", "allocateOnDay"),
    accrualRounding: pickEnum(row?.accrualRounding, ROUNDINGS, "FLOOR_QUARTER", "accrualRounding"),
    accrualCap:
      typeof row?.accrualCap === "number" && Number.isFinite(row.accrualCap)
        ? Math.max(0, row.accrualCap)
        : pickNumber(row?.annualDays, 0),
    grantOn: pickEnum(row?.grantOn, GRANT_ON, "PERIOD_START", "grantOn"),
    prorateForJoiners: pickBool(row?.prorateForJoiners, true),
    minServiceMonths: Math.max(0, Math.round(pickNumber(row?.minServiceMonths, 0))),
    accrueDuringProbation: pickBool(row?.accrueDuringProbation, true),
    allowNegative: pickBool(row?.allowNegative, false),
    negativeFloor: Math.max(0, pickNumber(row?.negativeFloor, 0)),
    carryExpiresAfterMonths:
      typeof row?.carryExpiresAfterMonths === "number" && Number.isFinite(row.carryExpiresAfterMonths)
        ? Math.max(1, Math.round(row.carryExpiresAfterMonths))
        : null,
    countHolidaysInLeave: pickBool(row?.countHolidaysInLeave, false),
  };
}

// ---------------------------------------------------------------------------
// Date arithmetic ("YYYY-MM-DD" strings, UTC-midnight)
// ---------------------------------------------------------------------------

function parseDayStr(s: string): Date {
  return new Date(`${s}T00:00:00.000Z`);
}

function dayStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function daysBetween(a: string, b: string): number {
  return Math.round((parseDayStr(b).getTime() - parseDayStr(a).getTime()) / 86_400_000);
}

function addDays(s: string, n: number): string {
  return dayStr(new Date(parseDayStr(s).getTime() + n * 86_400_000));
}

/** Add whole months with end-of-month clamping (Jan 31 + 1 → Feb 28/29). */
export function addMonths(s: string, n: number): string {
  const d = parseDayStr(s);
  const targetY = d.getUTCFullYear();
  const targetM = d.getUTCMonth() + n;
  const lastDay = new Date(Date.UTC(targetY, targetM + 1, 0)).getUTCDate();
  return dayStr(new Date(Date.UTC(targetY, targetM, Math.min(d.getUTCDate(), lastDay))));
}

/** Whole calendar months from a to b (negative when b precedes a). */
export function monthsBetween(a: string, b: string): number {
  const da = parseDayStr(a);
  const db = parseDayStr(b);
  let m = (db.getUTCFullYear() - da.getUTCFullYear()) * 12 + (db.getUTCMonth() - da.getUTCMonth());
  // Partial month: Mar 15 → Apr 10 is 0 months (not 1); Apr 10 → Apr 15 is 0.
  if (db.getUTCDate() < da.getUTCDate()) m -= 1;
  return m;
}

/** Rounding to 0.25-day steps per the policy's accrualRounding. */
function roundDays(n: number, mode: LeaveAccrualRounding): number {
  return mode === "NEAREST" ? Math.round(n * 4) / 4 : Math.floor(n * 4) / 4;
}

// ---------------------------------------------------------------------------
// Employment facts — the (only) employee inputs the engine needs
// ---------------------------------------------------------------------------

/** Profile facts the engine reads. Dates are "YYYY-MM-DD" or null. */
export interface EmploymentFacts {
  hireDate: string | null;
  employmentStatus: string;
  probationEndsAt: string | null;
}

/** Probation deferral: the date grants may start landing on, or null when
 * no deferral applies. A PROBATION employee with no probationEndsAt blocks
 * accrual entirely (unmanaged is unmanaged — the job reports it as skipped,
 * HR records the date, accrual resumes; nothing is silently granted). */
function probationDeferredUntil(policy: ResolvedLeavePolicy, employment: EmploymentFacts | null): string | null {
  if (policy.accrueDuringProbation || !employment) return null;
  if (employment.employmentStatus !== "PROBATION") return null; // probation past or never asserted
  // PROBATION now: defer to the recorded end (null = block, see above).
  return employment.probationEndsAt ?? "∞";
}

// ---------------------------------------------------------------------------
// The grant rule — one pure function for every strategy
// ---------------------------------------------------------------------------

/** One due grant: becomes a ledger GRANT row (sourceType "POLICY",
 * sourceId = periodKey — the writer's idempotency key). */
export interface GrantOp {
  /** Deterministic idempotency key, unique within (user, type, year). */
  periodKey: string;
  /** Signed day delta (positive grant). */
  delta: number;
  /** The date the grant became due (audit note / documentation). */
  dueDate: string;
  note: string;
}

export interface DueGrantsInput {
  policy: ResolvedLeavePolicy;
  employment: EmploymentFacts | null;
  /** The ledger year being advanced (the calendar year of the grants). */
  year: number;
  /** "today" — injected, never read from the clock. */
  asOf: string;
  /** Σ GRANT deltas already written for (user, type, year) — true-up math. */
  grantedSoFar: number;
  /** The standing balance for (user, type, year) — EARNED cap room. */
  availableNow: number;
  /** periodKeys already on the ledger — idempotency input. */
  existingPeriodKeys: ReadonlySet<string>;
}

interface PeriodPlan {
  periodKey: string;
  /** Nominal (pre-rounding, pre-cap) share of annualDays this period pays. */
  nominal: number;
  dueDate: string;
}

/** ANNUAL_LUMP_SUM / AFTER_SERVICE / EARNED period plans per strategy. */
function planPeriods(input: DueGrantsInput): PeriodPlan[] {
  const { policy, employment, year } = input;
  const hire = employment?.hireDate ?? null;

  if (policy.allocationStrategy === "ANNUAL_LUMP_SUM") {
    if (policy.grantOn === "ANNIVERSARY") {
      if (!hire) {
        // No hire date — treat as "employed since before the year": the
        // grant is due Jan 1, full amount (same facts-free default the
        // pre-F2.4 materializer used).
        return [{ periodKey: `${year}`, nominal: policy.annualDays, dueDate: `${year}-01-01` }];
      }
      const hireY = Number(hire.slice(0, 4));
      // The hire-year grant lands on the hire date itself; later years on
      // each anniversary (addMonths clamps Feb 29 → Feb 28 in non-leap
      // years). Years before the hire have no grant at all.
      if (year < hireY) return [];
      const anniversary = addMonths(hire, 12 * (year - hireY));
      return [{ periodKey: `${year}-${anniversary.slice(5, 7)}`, nominal: policy.annualDays, dueDate: anniversary }];
    }
    // PERIOD_START — the whole year at once: Jan 1 for pre-year hires,
    // the hire date itself for mid-year joiners (whether or not the amount
    // is pro-rated — a Dec 1 joiner must not lose the year's grant to a
    // Jan 1 due date they were not employed for).
    let nominal = policy.annualDays;
    let dueDate = `${year}-01-01`;
    if (hire) {
      const hireY = Number(hire.slice(0, 4));
      if (hireY > year) return []; // not employed this year at all
      if (hireY === year) {
        dueDate = hire;
        if (policy.prorateForJoiners) {
          // Calendar days remaining in the year (the hire day counts — the
          // employee works it), rounded per accrualRounding.
          const remaining = daysBetween(hire, `${year}-12-31`) + 1;
          const yearLen = daysBetween(`${year}-01-01`, `${year}-12-31`) + 1;
          nominal = roundDays((policy.annualDays * remaining) / yearLen, policy.accrualRounding);
        }
      }
    }
    return [{ periodKey: `${year}`, nominal, dueDate }];
  }

  if (policy.allocationStrategy === "AFTER_SERVICE") {
    if (!hire) return []; // service arithmetic without a hire date is
    // fabrication — nothing is due until HR records one.
    const first = addMonths(hire, policy.minServiceMonths);
    // Deposits: first at hire + minServiceMonths, then every 12 months.
    // At most ONE lands in any calendar year (steps are 12 months apart
    // after the first, which itself is a single date).
    const firstY = Number(first.slice(0, 4));
    if (year < firstY) return [];
    const monthsAfterFirst = (year - firstY) * 12;
    const deposit = addMonths(first, monthsAfterFirst);
    if (Number(deposit.slice(0, 4)) !== year) return []; // calendar clamp moved it (e.g. Feb 29)
    return [{ periodKey: `${year}-${deposit.slice(5, 7)}`, nominal: policy.annualDays, dueDate: deposit }];
  }

  // EARNED — accrual periods.
  const freq = policy.accrualFrequency;
  const periodsPerYear = freq === "MONTHLY" ? 12 : freq === "QUARTERLY" ? 4 : freq === "HALF_YEARLY" ? 2 : 1;
  const share = policy.annualDays / periodsPerYear;
  const hireDayOfMonth = hire ? Number(hire.slice(8, 10)) : 1;

  const plans: PeriodPlan[] = [];
  for (let i = 0; i < periodsPerYear; i++) {
    let periodStart: string;
    let periodEnd: string;
    let periodKey: string;
    switch (freq) {
      case "MONTHLY": {
        const mm = String(i + 1).padStart(2, "0");
        periodStart = `${year}-${mm}-01`;
        periodEnd = addDays(i < 11 ? `${year}-${String(i + 2).padStart(2, "0")}-01` : `${year + 1}-01-01`, -1);
        periodKey = `${year}-${mm}`;
        break;
      }
      case "QUARTERLY": {
        const startM = i * 3 + 1;
        const mm = String(startM).padStart(2, "0");
        periodStart = `${year}-${mm}-01`;
        periodEnd = addDays(i < 3 ? `${year}-${String(startM + 3).padStart(2, "0")}-01` : `${year + 1}-01-01`, -1);
        periodKey = `${year}-Q${i + 1}`;
        break;
      }
      case "HALF_YEARLY": {
        periodStart = i === 0 ? `${year}-01-01` : `${year}-07-01`;
        periodEnd = i === 0 ? `${year}-06-30` : `${year}-12-31`;
        periodKey = `${year}-H${i + 1}`;
        break;
      }
      default: {
        periodStart = `${year}-01-01`;
        periodEnd = `${year}-12-31`;
        periodKey = `${year}`;
      }
    }
    // The landing day inside the period.
    let dueDate: string;
    switch (policy.allocateOnDay) {
      case "LAST":
        dueDate = periodEnd;
        break;
      case "DOJ_DAY": {
        // The hire day-of-month, clamped into the period's start month.
        // (Date.UTC month is 0-based; passing the 1-based month number with
        // day 0 yields the last day OF that month.)
        const startMonthLen = new Date(
          Date.UTC(year, Number(periodStart.slice(5, 7)), 0),
        ).getUTCDate();
        const day = Math.min(Math.max(1, hireDayOfMonth), startMonthLen);
        dueDate = `${periodStart.slice(0, 8)}${String(day).padStart(2, "0")}`;
        break;
      }
      default:
        dueDate = periodStart;
    }
    plans.push({ periodKey, nominal: share, dueDate });
  }
  return plans;
}

/**
 * The grants due NOW for one (user, type, year): the single rule behind the
 * lazy materializer AND the cron job. Deterministic; idempotent together
 * with the writer (existingPeriodKeys are skipped).
 */
export function dueGrantOps(input: DueGrantsInput): GrantOp[] {
  const { policy, employment, asOf, grantedSoFar, availableNow, existingPeriodKeys } = input;
  if (policy.allocationStrategy === "MANUAL") {
    // Grant-on-first-use is the SERVICE's materialization path (the
    // pre-F2.4 behavior, kept byte-identical); nothing is scheduled.
    return [];
  }

  const hire = employment?.hireDate ?? null;
  const deferredUntil = probationDeferredUntil(policy, employment);

  const plans = planPeriods(input);
  const lastIdx = plans.length - 1;
  const fullYear = plans.length > 0 && (!hire || hire <= plans[0].dueDate);

  const ops: GrantOp[] = [];
  for (let i = 0; i < plans.length; i++) {
    const p = plans[i];
    if (existingPeriodKeys.has(p.periodKey)) continue;

    // Employment eligibility: hired on or before the landing moment.
    if (hire && hire > p.dueDate) continue;

    // Probation deferral: the grant lands once probation is over.
    let dueDate = p.dueDate;
    if (deferredUntil !== null) {
      if (deferredUntil === "∞") continue; // PROBATION with no recorded end
      if (deferredUntil > dueDate) dueDate = deferredUntil;
    }
    if (asOf < dueDate) continue;

    // Amount: rounding + true-up — the last period of the year makes a
    // full-year EARNED employee's accrual EXACT despite per-period
    // floor-quarter dust. True-up is EARNED-only: the single-plan
    // strategies (ANNUAL_LUMP_SUM / AFTER_SERVICE) carry their whole
    // amount in the one plan's nominal (pro-rated or not) and must not be
    // re-derived from annualDays here. Joiners' partial first years pay
    // nominal per employed period, honestly short by design.
    let delta = roundDays(p.nominal, policy.accrualRounding);
    if (policy.allocationStrategy === "EARNED" && i === lastIdx && fullYear) {
      delta = round2(precision(policy.annualDays - grantedSoFar - sumOf(ops)));
    }

    // EARNED standing cap: room = cap − available (consumption frees room).
    if (policy.allocationStrategy === "EARNED") {
      const already = sumOf(ops);
      const room = round2(policy.accrualCap - availableNow - already);
      if (room <= 0) continue;
      delta = Math.min(delta, room);
    }

    delta = round2(delta);
    if (delta <= 0) continue; // a 0-day grant (deep December hire) writes nothing

    ops.push({
      periodKey: p.periodKey,
      delta,
      dueDate,
      note: grantNote(policy, p.periodKey, delta),
    });
  }
  return ops;
}

function grantNote(policy: ResolvedLeavePolicy, periodKey: string, delta: number): string {
  switch (policy.allocationStrategy) {
    case "EARNED":
      return `Accrued ${delta} day(s) for ${periodKey} (${policy.accrualFrequency.toLowerCase()} earned leave)`;
    case "ANNUAL_LUMP_SUM":
      return `Annual allocation ${delta} day(s) (${policy.grantOn === "ANNIVERSARY" ? "hire anniversary" : "year start"})`;
    case "AFTER_SERVICE":
      return `Annual deposit ${delta} day(s) after ${policy.minServiceMonths} month(s) of service`;
    default:
      return `Entitlement materialized (${delta} days)`;
  }
}

function sumOf(ops: GrantOp[]): number {
  return ops.reduce((s, o) => s + o.delta, 0);
}

function precision(n: number): number {
  return Math.round(n * 100) / 100;
}

function round2(n: number): number {
  const r = Math.round(n * 100) / 100;
  return r === 0 ? 0 : r;
}

// ---------------------------------------------------------------------------
// The guard — floor-aware overdraft check (request + approve share it)
// ---------------------------------------------------------------------------

export interface LeaveGuardResult {
  ok: boolean;
  requestedDays: number;
  available: number;
  /** The advance allowance in days (0 when negative leave is off). */
  floor: number;
}

/**
 * The balance guard: reject when `available − requestedDays < −floor`.
 * With allowNegative false (or floor 0) this is EXACTLY the classic
 * `requestedDays > available` rejection — zero drift at the defaults.
 */
export function checkLeaveRequestAgainstBalance(
  policy: ResolvedLeavePolicy,
  requestedDays: number,
  available: number,
): LeaveGuardResult {
  const floor = policy.allowNegative ? policy.negativeFloor : 0;
  const ok = round2(available - requestedDays) >= -floor;
  return { ok, requestedDays, available, floor };
}

/** The advance hint appended to guard rejections and balance renders. */
export function advanceHint(policy: ResolvedLeavePolicy): string {
  if (!policy.allowNegative || policy.negativeFloor <= 0) return "";
  return ` — advance leave is allowed down to −${policy.negativeFloor} day(s)`;
}

// ---------------------------------------------------------------------------
// The service gate — LV-B07 applicable_after (minServiceMonths > 0)
// ---------------------------------------------------------------------------

export function checkServiceEligibility(
  policy: ResolvedLeavePolicy,
  employment: EmploymentFacts | null,
  requestStart: string,
): { ok: boolean; monthsOfService: number | null } {
  if (policy.minServiceMonths <= 0) return { ok: true, monthsOfService: null };
  if (!employment?.hireDate) return { ok: true, monthsOfService: null }; // no fact ≠ ineligible
  const months = monthsBetween(employment.hireDate, requestStart);
  return { ok: months >= policy.minServiceMonths, monthsOfService: months };
}

// ---------------------------------------------------------------------------
// Year-end rollover + carry lapse (the cron's second and third writers)
// ---------------------------------------------------------------------------

export interface RolloverOps {
  /** CARRY row delta for the new year (≥ 0). */
  carry: number;
  /** EXPIRE row delta for the new year (≤ 0) — the amount above the cap. */
  expire: number;
}

/**
 * Year-end rollover for one (user, type): carry min(prevAvailable,
 * maxCarryOver) into the new year and expire the excess. A non-positive
 * prior balance carries nothing and expires nothing.
 */
export function rolloverOps(prevAvailable: number, maxCarryOver: number): RolloverOps {
  const available = round2(prevAvailable);
  if (available <= 0) return { carry: 0, expire: 0 };
  const carry = round2(Math.min(available, Math.max(0, maxCarryOver)));
  const expire = round2(Math.min(0, carry - available)); // ≤ 0
  return { carry, expire };
}

/**
 * Carry lapse (carryExpiresAfterMonths): the negative EXPIRE delta for the
 * still-unspent carried days at lapse time. FIFO consumption — carried days
 * are spent before current-year grants — so unspent carry is
 * carryGranted − min(used, carryGranted).
 */
export function carryLapseDelta(carryGranted: number, used: number): number {
  const carry = Math.max(0, round2(carryGranted));
  const unspent = round2(carry - Math.min(Math.max(0, used), carry));
  return unspent > 0 ? -unspent : 0;
}

/** COMPLETE months of the new year elapsed at asOf (0 through January,
 * 1 from February 1st on) — a carryExpiresAfterMonths of 3 lapses on
 * April 1st, the first day of the 4th month. */
export function monthsIntoYear(year: number, asOf: string): number {
  return monthsBetween(`${year}-01-01`, asOf);
}
