// Leave types — statuses, the holiday-calendar entry, the leave-type master
// (allocation strategy vocabulary), requests, compensatory claims, balances,
// and encashment. Client-safe mirrors of the Prisma models.
// (Split from the former lib/types/index.ts god-file.)


// HR module — leave management (docs/HR_MODULE_PLAN.md)
export type LeaveStatus = "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED";
export type LeaveDecision = "APPROVE" | "REJECT";

/** F1.1 — one holiday-calendar entry, client-shaped ("yyyy-mm-dd"). kind is
 * labeling (PUBLIC = statutory/national, WEEKLY_OFF = scheduled non-working
 * day); both kinds are excluded from working-day counting. */
export interface HolidayT {
  id: string;
  date: string;
  label: string;
  kind: "PUBLIC" | "WEEKLY_OFF";
  isHalfDay: boolean;
}

// F2.4 — leave allocation strategy vocabulary (docs/Fernly_Policy_Engine_
// Design.md §4.1). Unions live here so lib/types stays dependency-free; the
// pure kernel (lib/leave/leave-policy.ts) and the DTOs share them.
export type LeaveAllocationStrategy = "MANUAL" | "ANNUAL_LUMP_SUM" | "EARNED" | "AFTER_SERVICE";
export type LeaveAccrualFrequency = "MONTHLY" | "QUARTERLY" | "HALF_YEARLY" | "ANNUAL";
export type LeaveAllocateOnDay = "FIRST" | "LAST" | "DOJ_DAY";
export type LeaveAccrualRounding = "FLOOR_QUARTER" | "NEAREST";
export type LeaveGrantOn = "PERIOD_START" | "ANNIVERSARY";

export interface LeaveTypeT {
  id: string;
  name: string;
  code: string;
  requiresDoc: boolean;
  paid: boolean;
  /** P15 (PR-06) — fraction of daily salary paid per leave day (paid types
   * only; 1 = fully paid). Optional in the wire type (older snapshots
   * default to 1 via `?? 1`); the server DTO always fills it. */
  salaryFraction?: number;
  /** P30 (LV-01) — optional-leave types: applications landing entirely on
   * holidays/weekends consume no balance (zero-day requests allowed).
   * Optional in the wire type for snapshot compat; the server DTO fills it. */
  isOptionalLeave?: boolean;
  /** P30 (LV-01/LV-11) — compensatory types: days arrive only through
   * approved worked-holiday claims (CompensatoryLeaveRequest). */
  isCompensatory?: boolean;
  color: string;
  active: boolean;
  policy: {
    annualDays: number;
    maxCarryOver: number;
    minNoticeDays: number;
    maxConsecutiveDays: number;
    // F2.4 strategy block — optional in the wire type because the server
    // DTO always fills them from the DB row (post-migration defaults), but
    // older snapshots/tests may omit them; readers default via
    // resolveLeavePolicy, never by guessing.
    allocationStrategy?: LeaveAllocationStrategy;
    accrualFrequency?: LeaveAccrualFrequency;
    allocateOnDay?: LeaveAllocateOnDay;
    accrualRounding?: LeaveAccrualRounding;
    accrualCap?: number | null;
    grantOn?: LeaveGrantOn;
    prorateForJoiners?: boolean;
    minServiceMonths?: number;
    accrueDuringProbation?: boolean;
    allowNegative?: boolean;
    negativeFloor?: number;
    carryExpiresAfterMonths?: number | null;
    countHolidaysInLeave?: boolean;
    // P2 (LV-09, F2.2) — encashment knobs (optional for the same
    // snapshot-compat reason as the strategy block above).
    encashable?: boolean;
    maxEncashableDays?: number;
    nonEncashableDays?: number;
    // P30 (LV-01) — the optional-holiday count cap (the benchmark's Max Days
    // Leave Allowed; null = no cap).
    maxOptionalHolidaysPerYear?: number | null;
  } | null;
}

export interface LeaveRequestT {
  id: string;
  leaveTypeId: string;
  typeName: string;
  typeColor: string;
  userId: string;
  userName: string;
  startDate: string;
  endDate: string;
  days: number;
  reason: string;
  status: LeaveStatus;
  decidedById: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string;
  createdAt: string;
}

/** P30 (LV-01/LV-11) — one worked-holiday compensatory claim: the span the
 * member filed, the days the walk priced, the decision pair. Status rides
 * the same PENDING/APPROVED/REJECTED labels + LEAVE_STATUS_LABELS. */
export interface CompLeaveRequestT {
  id: string;
  userId: string;
  userName: string;
  leaveTypeId: string;
  typeName: string;
  typeColor: string;
  workFromDate: string;
  workToDate: string;
  days: number;
  reason: string;
  status: LeaveStatus;
  decidedById: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string;
  createdAt: string;
}

export interface LeaveBalanceT {
  leaveTypeId: string;
  typeName: string;
  typeColor: string;
  year: number;
  entitled: number;
  carriedOver: number;
  used: number;
  available: number;
}

/** P2 (LV-09, F2.2) — one encashment request: days sold back from a leave
 * balance, paying through the P1 PayAdjustment adapter on the payout
 * period's run. status: PENDING → APPROVED | REJECTED; APPROVED → PAID
 * when the consuming run locks. amount/dailyRate snapshot at approval. */
export interface LeaveEncashmentT {
  id: string;
  userId: string;
  userName: string;
  leaveTypeId: string;
  typeName: string;
  typeColor: string;
  year: number;
  days: number;
  status: "PENDING" | "APPROVED" | "REJECTED" | "PAID";
  payoutPeriod: string;
  amount: number;
  dailyRate: number;
  reason: string;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string;
  /** The consuming run's id (paidRunId) while PAID; null otherwise. */
  paidRunPeriod: string | null;
  createdAt: string;
}
