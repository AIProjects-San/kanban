// Shared Fernly types — mirror Prisma models but client-safe

import type { PayrollFrequency } from "@/lib/payroll-windows";

/** P10 — the payroll cadence union (lib/payroll-windows.ts owns it). */
export type PayrollFrequencyT = PayrollFrequency;

export type ProjectStatus = "RUNNING" | "ENDED" | "PENDING" | "PAUSED";
export type Priority = "HIGH" | "MEDIUM" | "LOW";
export type TaskStatus = "TODO" | "IN_PROGRESS" | "IN_REVIEW" | "DONE";
export type TaskTag = "FRONTEND" | "BACKEND" | "DESIGN" | "QA" | "MARKETING";
export type Department = "ENGINEERING" | "DESIGN" | "MARKETING" | "MANAGEMENT";
export type EventType = "MEETING" | "DEADLINE" | "REVIEW" | "SOCIAL" | "FOCUS" | "LEAVE";
type AccentColor = "forest" | "ocean" | "plum" | "ember" | "slate";

// Bug tracking lifecycle
export type BugSeverity = "CRITICAL" | "MAJOR" | "MINOR" | "TRIVIAL";
export type BugPriority = "P0" | "P1" | "P2" | "P3";
export type BugStatus =
  | "NEW"
  | "TRIAGED"
  | "IN_PROGRESS"
  | "IN_REVIEW"
  | "RESOLVED"
  | "CLOSED"
  | "REOPENED";
export type BugResolution =
  | "FIXED"
  | "WONT_FIX"
  | "DUPLICATE"
  | "CANNOT_REPRODUCE"
  | "WORKS_AS_INTENDED";

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

/** F1.3 — attendance status (docs/Fernly_HR_Payroll_Enhancement_Plan.md
 * §7.1). HR/admin sets PRESENT/ABSENT/HALF_DAY/WFH (attendance:manage);
 * ON_LEAVE rows are DERIVED from approved leave, never form-submitted. No
 * member self-marking (decision §9.1) — WFH included. */
export type AttendanceStatus = "PRESENT" | "ABSENT" | "HALF_DAY" | "WFH" | "ON_LEAVE";
/** How a row came to be: HR/admin marking, a future bulk import, or
 * derivation from an approved leave request (ADR-009 virtual-event
 * precedent — cancelling that leave removes the derived rows again). */
export type AttendanceSource = "MANUAL" | "DERIVED";
// F-R14 (S16) — the dead "IMPORT" source value was removed: it had no
// writer since F1.3 (imports arrive via direct DB writes if ever needed).

/** One attendance record, client-shaped ("yyyy-mm-dd" date, "HH:mm" times). */
export interface AttendanceT {
  id: string;
  userId: string;
  userName: string;
  date: string;
  status: AttendanceStatus;
  inTime: string | null;
  outTime: string | null;
  /** AT-B02/B03 (S2) — derived at write time against the workspace default
   * day (lib/attendance-flags.ts). null = not computable. */
  lateMinutes: number | null;
  earlyMinutes: number | null;
  workingHours: number | null;
  /** P9 (PR-B26) — minutes past the workspace day end (same S2 write-time
   * derivation); the payroll bridge's input. null = not computable. */
  overtimeMinutes: number | null;
  note: string;
  source: AttendanceSource;
}

/** The HR console's month grid payload: the roster, everyone's records for
 * the month, and the month's holiday entries (so the grid can shade
 * non-working columns). */
export interface AttendanceMonthT {
  year: number;
  month: number; // 1–12
  members: { userId: string; userName: string }[];
  records: AttendanceT[];
  holidays: { date: string; label: string }[];
  /** AT-B02/B03 (S2) — the workspace reference day (HH:MM) the late/early
   * facts were derived against; the marking modal explains "late" with it. */
  dayStart: string;
  dayEnd: string;
}

// F2.4 — leave allocation strategy vocabulary (docs/Fernly_Policy_Engine_
// Design.md §4.1). Unions live here so lib/types stays dependency-free; the
// pure kernel (lib/leave-policy.ts) and the DTOs share them.
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

// HR module feature 2 — employee directory (docs/HR_MODULE_PLAN.md §5).
// HR module feature 3 — performance reviews (docs/HR_MODULE_PLAN.md §6).
export type ReviewStatus = "DRAFT" | "SUBMITTED" | "REVIEWED" | "ACKNOWLEDGED";

// F1.6 — employment lifecycle (docs/Fernly_HR_Payroll_Enhancement_Plan.md
// §7.1). "" = not tracked yet (QA-19 discipline — an HR-owned fact nobody
// has asserted yet renders as "—"), mirroring the department convention.
export type EmploymentStatus = "" | "PROBATION" | "ACTIVE" | "SUSPENDED" | "EXITED";

// ---------------------------------------------------------------------------
// P33 (EM-06/EM-01) — the structured property history (the benchmark's
// Employee Property History child) and the promotion/transfer change that
// writes it. The promotable property registry + the pure diff/raise/retire
// math live in lib/employment-change.ts; this is the shared wire type.
// ---------------------------------------------------------------------------

/** One structured property-history row (property / current / new). */
export interface EmploymentPropertyHistoryT {
  id: string;
  userId: string;
  /** jobTitle | department | manager | salary (registry in
   * lib/employment-change.ts; grade joins at P34). */
  property: string;
  currentValue: string;
  newValue: string;
  /** "yyyy-mm-dd". */
  effectiveAt: string;
  /** PROMOTION | TRANSFER. */
  sourceKind: string;
  createdAt: string;
}

/** F1.6 — separates ordinary review cycles from probation reviews (§9.3 gate). */
export type ReviewKind = "STANDARD" | "PROBATION";

export interface PerformanceReviewT {
  id: string;
  userId: string;
  userName: string;
  title: string;
  periodStart: string;
  periodEnd: string;
  status: ReviewStatus;
  /** F1.6 — STANDARD by default; PROBATION cycles feed the §9.3 hard gate. */
  kind: ReviewKind;
  selfAssessment: string;
  selfRating: number | null;
  managerComment: string;
  managerRating: number | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  acknowledgedAt: string | null;
  createdAt: string;
}

// HR module feature 4 — onboarding (docs/HR_MODULE_PLAN.md §7).
export interface OnboardingTaskT {
  id: string;
  checklistId: string;
  title: string;
  assigneeId: string | null;
  assigneeName: string | null;
  /** P35 (EM-B06) — non-empty = role-scoped task (every holder of the key
   * sees it and may tick it; assigneeId/assigneeName stay null). */
  assigneeRole: string;
  dueOffsetDays: number;
  /** P35 (EM-12) — the holiday-aware due date (ISO); null = undated
   * (pre-P35 row / no checklist start). */
  dueDate: string | null;
  /** P35 (EM-12) — the benchmark's required_for_employee_creation flag. */
  isRequired: boolean;
  done: boolean;
  doneAt: string | null;
  doneBy: string | null;
  notes: string;
  order: number;
}

export interface OnboardingChecklistT {
  id: string;
  newHireId: string;
  hireName: string;
  title: string;
  /** F2.1 — ONBOARDING (new hire) | SEPARATION (exit): which console tab
   * owns the row; the default keeps every pre-F2.1 row onboarding. */
  kind: ChecklistKind;
  completedAt: string | null;
  /** P35 (EM-12) — the working-day-walk anchor the due dates hang off
   * (ISO); null = pre-P35 row. */
  startDate: string | null;
  createdAt: string;
  /** P35 (EM-11) — the DERIVED boarding status: done/total/percent +
   * NOT_STARTED | IN_PROGRESS | COMPLETE + the open-required count.
   * Computed per read (lib/onboarding-template's pure kernel) — never
   * stored, so it can never drift from the task rows. */
  completion: {
    done: number;
    total: number;
    percent: number;
    status: "NOT_STARTED" | "IN_PROGRESS" | "COMPLETE";
    requiredOpen: number;
  };
  tasks: OnboardingTaskT[];
}

/** F2.1 — the two checklist flavors sharing one machinery. */
export type ChecklistKind = "ONBOARDING" | "SEPARATION";

// ---------------------------------------------------------------------------
// F2.1 — offboarding & full-and-final lite
// (docs/Fernly_HR_Payroll_Enhancement_Plan.md §7.2; benchmark EM-14/15/16).
// ---------------------------------------------------------------------------

/** Exit-interview status machine (benchmark EM-15). */
export type ExitInterviewStatus = "PENDING" | "SCHEDULED" | "COMPLETED" | "CANCELLED";

export interface ExitInterviewT {
  id: string;
  userId: string;
  userName: string;
  status: ExitInterviewStatus;
  scheduledAt: string | null;
  interviewerId: string | null;
  interviewerName: string | null;
  notes: string;
  completedAt: string | null;
  createdAt: string;
}

/** One money line on a full-and-final statement. */
export type FnFLineKind = "SALARY" | "ENCASHMENT" | "ADVANCE_LEAVE" | "GRATUITY";

export interface FnFLineT {
  kind: FnFLineKind;
  label: string;
  /** Day count for leave-valued lines (null on pure salary lines). */
  days: number | null;
  /** Per-day rate for leave-valued lines (null on pure salary lines). */
  rate: number | null;
  /** Signed effect on net payable: positive = payable, negative = receivable. */
  amount: number;
}

/** The computed statement (pure output of lib/full-and-final.ts). */
export interface FnFComputedT {
  /** yyyy-mm-dd — the asOf the computation ran at (injected clock). */
  asOf: string;
  lines: FnFLineT[];
  /** Human-readable honesty notes (missing payslip, no structure, …). */
  notes: string[];
  payableTotal: number;
  receivableTotal: number;
  /** payables − receivables; may be negative (the employee owes back). */
  netPayable: number;
  /** P7 (F3.3) — how the gratuity line was computed (null = rule off,
   * uncomputable, or under one completed year). Frozen statements store
   * only the line + totals; this detail is live-view context. */
  gratuity: {
    completedYears: number;
    extraMonths: number;
    /** The rounded average monthly gross the slabs multiplied. */
    averageMonthlyEarnings: number;
    averagingMonths: number;
    /** Which service years paid at which fraction (its own work shown). */
    breakdown: Array<{ year: number; fraction: number; amount: number }>;
  } | null;
  /** How a day of leave was valued. */
  rateBasis: {
    /** The rate-basis period (the last-working-day month, "YYYY-MM"). */
    period: string;
    /** Holiday-aware working days of that period (F1.1 math). */
    workingDays: number;
    /** Monthly gross from the active structure (null = none). */
    monthlyGross: number | null;
    /** monthlyGross ÷ workingDays (0 when uncomputable). */
    dailyRate: number;
  };
}

/** The statement state the UI renders (row + live/frozen computation). */
export type FnFStateT =
  | { status: "NONE"; computed: FnFComputedT | null }
  | { status: "UNSETTLED"; rowId: string; generatedAt: string; generatedBy: string | null; computed: FnFComputedT; snapshot: FnFComputedT }
  | { status: "SETTLED"; rowId: string; generatedAt: string; settledAt: string; settledBy: string | null; frozen: FnFComputedT };

/** One employee's offboarding case (the Offboarding tab card). */
export interface OffboardingCaseT {
  userId: string;
  name: string;
  jobTitle: string;
  department: string;
  employmentStatus: EmploymentStatus;
  hireDate: string | null;
  lastWorkingDay: string | null;
  noticePeriodWeeks: number | null;
  checklist: OnboardingChecklistT | null;
  interview: ExitInterviewT | null;
  fnf: FnFStateT;
}

export interface OffboardingOverviewT {
  cases: OffboardingCaseT[];
  /** User picker options for starting a separation (non-EXITED users). */
  members: { userId: string; name: string }[];
  /** Interviewer picker options (all active users). */
  interviewers: { userId: string; name: string }[];
}

export interface EmployeeProfileT {
  id: string;
  userId: string;
  /** EM-B01 (S13) — the workspace series (EMP-0001…); null = pre-S13 row. */
  employeeNumber: string | null;
  /** S14 (EM-B04/LV-B13) — the leave-approver override; null = the
   * reporting manager decides. */
  leaveApproverId: string | null;
  name: string;
  email: string;
  role: string;
  managerName: string | null;
  jobTitle: string;
  /** QA-19: "" means "not classified yet" — rendered as "—" until HR sets it. */
  department: "ENGINEERING" | "DESIGN" | "MARKETING" | "MANAGEMENT" | "";
  // P34 (EM-03) — the grouping axes. Same QA-19 rule: "" = not classified
  // yet (rendered "—"); grade/branch are free-form strings, employmentType
  // is the controlled vocabulary keyed in lib/config (EMPLOYMENT_TYPE_LABELS).
  grade: string;
  employmentType: "FULL_TIME" | "PART_TIME" | "CONTRACT" | "INTERN" | "CONSULTANT" | "";
  branch: string;
  hireDate: string | null;
  /** P25 (PL-02) — the birthday engine's input; null = not on file. */
  birthDate: string | null;
  phone: string;
  location: string;
  emergencyContactName: string;
  emergencyContactPhone: string;
  skills: string;
  /** P37 (EM-18) — the structured map (rated rows; the free-text string
   * above stays the quick self-service summary). */
  skillMap: { skillKey: string; label: string; rating: number }[];
  notes: string;
  // F1.6 — employment lifecycle (written only by transitionEmployment for
  // the status itself; the three plain fields are HR-editable facts).
  /** "" = not tracked yet — rendered as "—" until HR classifies. */
  employmentStatus: EmploymentStatus;
  probationEndsAt: string | null;
  noticePeriodWeeks: number | null;
  lastWorkingDay: string | null;
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

export interface ProjectT {
  id: string;
  name: string;
  description: string;
  status: ProjectStatus;
  priority: Priority;
  dueDate: string | null;
  progress: number;
  color: AccentColor;
  /** Display copy of the owner's name — authority lives in ownerUserId. */
  ownerName: string;
  ownerUserId?: string | null;
  createdAt: string;
}

export interface TaskT {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: Priority;
  tag: TaskTag;
  dueDate: string | null;
  order: number;
  /** Required (estimated) time in minutes — 0 = no estimate. */
  estimateMinutes: number;
  /** Spent hours aggregated from TimeEntry rows linked to this task. */
  spentHours?: number;
  /** Number of bugs linked to this task (Task ↔ Bug traceability). */
  bugCount?: number;
  projectId: string | null;
  assigneeId: string | null;
  project?: ProjectT | null;
  assignee?: TeamMemberT | null;
  createdAt: string;
}

export interface TeamMemberT {
  id: string;
  name: string;
  role: string;
  department: Department;
  email: string;
  avatarColor: AccentColor;
  online: boolean;
  openTasks: number;
  completedTasks: number;
  workload: number;
  /** Stable link to the User account this member represents (if any). */
  userId?: string | null;
}

export interface CalendarEventT {
  id: string;
  title: string;
  description: string;
  date: string;
  time: string;
  durationMin: number;
  type: EventType;
  location: string;
}

export interface NotificationT {
  id: string;
  title: string;
  message: string;
  type: "INFO" | "SUCCESS" | "WARNING" | "TASK" | "MENTION";
  read: boolean;
  createdAt: string;
  /** null = workspace-wide broadcast; otherwise the notification is private
   *  to that user (drives the broadcast badge in the topbar). */
  recipientUserId: string | null;
}

export interface TimeEntryT {
  id: string;
  projectId: string | null;
  memberId: string | null;
  /** Task this time was spent on (null = project-level entry). */
  taskId: string | null;
  date: string;
  hours: number;
  description: string;
}

export interface ReminderT {
  id: string;
  title: string;
  dueDate: string;
  completed: boolean;
}

export interface MessageT {
  id: string;
  direction: "IN" | "OUT";
  threadId: string;
  memberId: string | null;
  /** Authenticated user id of the sender (empty for legacy/seed rows). */
  senderUserId?: string;
  /** Authenticated user id of the recipient (empty when unknown). */
  recipientUserId?: string;
  senderName: string;
  senderAvatarColor: string;
  senderRole: string;
  recipientName: string;
  subject: string;
  body: string;
  read: boolean;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// DashboardData — the payload returned by getDashboardData() and consumed by
// AppShell / every view.
// ---------------------------------------------------------------------------

export interface DashboardStats {
  total: number;
  ended: number;
  running: number;
  pending: number;
  paused: number;
  weeklyCompletion: number;
  projectEndedPct: number;
}

export interface DashboardScope {
  isMember: boolean;
  projectIds: string[] | null;
}

export interface DashboardData {
  projects: ProjectT[];
  tasks: TaskT[];
  members: TeamMemberT[];
  reminders: ReminderT[];
  notifications: NotificationT[];
  timeEntries: TimeEntryT[];
  events: CalendarEventT[];
  messages: MessageT[];
  stats: DashboardStats;
  scope?: DashboardScope;
  /** PR-61 — user ids in the signed-in MANAGER's reporting subtree
   *  (self + direct + transitive reports). Empty for every other role:
   *  only managers need hierarchy data client-side (task-delete button,
   *  scoped analytics). ADMIN decides with the blanket permission, MEMBER
   *  with assignee/owner checks that need no hierarchy. */
  managedUserIds?: string[];
  /** PR-64 — effective permissions (static floor ∪ DB ceiling) for the
   *  signed-in user's role. Seeds the client permission store so an
   *  admin's role-permission save reflects for logged-in users without a
   *  re-login; refreshed by the getMyPermissions poll thereafter. */
  effectivePermissions?: string[];
}

export const EMPTY_DASHBOARD_DATA: DashboardData = {
  projects: [], tasks: [], members: [], reminders: [],
  notifications: [], timeEntries: [], events: [], messages: [],
  stats: { total: 0, ended: 0, running: 0, pending: 0, paused: 0, weeklyCompletion: 0, projectEndedPct: 0 },
  scope: { isMember: false, projectIds: null },
  managedUserIds: [],
  effectivePermissions: [],
};

// ---------------------------------------------------------------------------
// Recruitment module types (docs/RECRUITMENT_MODULE_PLAN.md).
// ---------------------------------------------------------------------------

export interface HiringStageConfigT {
  id: string;
  key: string;
  label: string;
  stageType: string;
  ownerRole: string;
  description: string;
  sortOrder: number;
  isActive: boolean;
}

export interface CandidateStageT {
  id: string;
  stageKey: string;
  label: string;
  stageType: string;
  ownerUserId: string | null;
  ownerName: string | null;
  status: string;
  scheduledAt: string | null;
  remarks: string;
  rating: number | null;
  /** R2 scorecard (docs/RECRUITMENT_MODULE_PLAN.md §5). */
  strengths: string;
  concerns: string;
  recommendation: string | null;
  /** CalendarEvent id when the interview has been scheduled (R2). */
  eventId: string | null;
  sortOrder: number;
  startedAt: string | null;
  completedAt: string | null;
}

export interface CandidateT {
  id: string;
  fullName: string;
  email: string;
  phone: string;
  position: string;
  department: string;
  source: string;
  resumeUrl: string;
  notes: string;
  status: string;
  rejectReason: string;
  decidedAt: string | null;
  createdById: string;
  userId: string | null;
  joinedAt: string | null;
  createdAt: string;
  stages: CandidateStageT[];
}

/** R3 — one audited outgoing email (docs/RECRUITMENT_MODULE_PLAN.md §5).
 * status: QUEUED → SENT | SKIPPED | FAILED. */
export interface MailOutboxT {
  id: string;
  kind: string;
  candidateId: string | null;
  candidateName: string | null;
  toAddress: string;
  subject: string;
  body: string;
  status: string;
  sentBy: string | null;
  sentAt: string | null;
  providerMessageId: string;
  error: string;
  createdAt: string;
}

/** R4 — one configurable document type in the joining-formalities checklist. */
export interface DocumentTypeConfigT {
  id: string;
  key: string;
  label: string;
  description: string;
  isMandatory: boolean;
  /** P36 (EM-21) — CANDIDATE (joining formalities) | EMPLOYEE
   * (identification). */
  scope: "CANDIDATE" | "EMPLOYEE";
  sortOrder: number;
  isActive: boolean;
}

/** P37 (EM-19, PF-07) — one row of the SHARED skill master. */
export interface SkillT {
  id: string;
  key: string;
  label: string;
  description: string;
  isActive: boolean;
  sortOrder: number;
}

/** P37 (EM-18) — one RATED skill on an employee's map. */
export interface EmployeeSkillT {
  id: string;
  userId: string;
  userName: string;
  skillKey: string;
  label: string;
  rating: number;
  /** The derived proficiency label (Learning…Expert). */
  proficiency: string;
  notes: string;
  assessedBy: string | null;
  assessedAt: string | null;
}

/** P37 (EM-18) — an employee's map + the master it draws from. */
export interface SkillMapT {
  entries: EmployeeSkillT[];
  skills: SkillT[];
  summary: string;
  canManage: boolean;
}

/** P36 (EM-21) — one identification document being collected from one
 * employee; the CandidateDocument twin. */
export interface EmployeeDocumentT {
  id: string;
  userId: string;
  userName: string;
  docTypeKey: string;
  label: string;
  status: "REQUESTED" | "RECEIVED" | "VERIFIED" | "REJECTED";
  fileRef: string;
  remarks: string;
  requestedAt: string;
  receivedAt: string | null;
  verifiedBy: string | null;
  verifiedAt: string | null;
  isMandatory: boolean;
}

/** R4 — one document being collected from one candidate.
 * status: REQUESTED → RECEIVED → VERIFIED | REJECTED. */
export interface CandidateDocumentT {
  id: string;
  candidateId: string;
  docTypeKey: string;
  label: string;
  status: string;
  fileRef: string;
  remarks: string;
  requestedAt: string;
  receivedAt: string | null;
  verifiedBy: string | null;
  verifiedAt: string | null;
}

/** R4 — one background-verification record.
 * status: INITIATED → IN_REVIEW → CLEARED | FLAGGED. */
export interface BackgroundCheckT {
  id: string;
  candidateId: string;
  vendor: string;
  status: string;
  reportRef: string;
  notes: string;
  initiatedBy: string | null;
  initiatedAt: string;
  completedAt: string | null;
}

/** R5 — one salary line of an offer (lib/offer-math.ts). P23 — the mode
 * vocabulary widens: PERCENT_OF_GROSS (annual resolution in computeOffer)
 * and PERCENT_OF_NET (payroll-time only — offers refuse it; structures
 * carry it and the run's two-pass kernel resolves it). */
export type OfferComponentT = {
  key: string;
  label: string;
  kind: "EARNING" | "EMPLOYER_CONTRIBUTION" | "DEDUCTION" | "STATISTICAL";
  mode: "FIXED" | "PERCENT_OF_BASIC" | "PERCENT_OF_GROSS" | "PERCENT_OF_NET";
  amount: number;
  /** PR-B02 (S6) — payment-days exemption snapshot (sparse: only false is
   * meaningful; absent = true). */
  dependsOnPaymentDays?: boolean;
};

/** R5 — a per-role offer template (hiring:config). */
export interface OfferTemplateT {
  id: string;
  key: string;
  label: string;
  description: string;
  components: OfferComponentT[];
  benefits: string[];
  letterTemplate: string;
  isActive: boolean;
  sortOrder: number;
}

/** R5 — one offer for one candidate. status: DRAFT → APPROVED → SENT →
 * SIGNED | DECLINED | EXPIRED (F2.10: APPROVED is the manager four-eyes
 * step — approvedBy/At carry it; EXPIRED is the lapsed signing link).
 * R6 adds the e-sign fields: token (null while DRAFT), expiry, and the typed
 * signature capture (signedAt/signedName/signedIp). F2.10 adds startDate
 * (the negotiated join date — F-R11). */
export interface OfferRecordT {
  id: string;
  candidateId: string;
  candidateName: string;
  position: string;
  templateId: string | null;
  templateLabel: string;
  components: OfferComponentT[];
  benefits: string[];
  letterText: string;
  status: string;
  notes: string;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  token: string | null;
  tokenExpiresAt: string | null;
  signedAt: string | null;
  signedName: string;
  /** F2.10 — the manager who approved the draft (null until APPROVED). */
  approvedBy: string | null;
  approvedAt: string | null;
  /** F2.10 — the proposed join date ("YYYY-MM-DD", "" when unset). */
  startDate: string;
}

/** R7 — one monthly money line on a payslip (see lib/payroll-math.ts). */
export interface PayslipLineT {
  key: string;
  label: string;
  amount: number;
  /** PR-B03 (S8) — display-only line (sparse): never counted into totals. */
  statistical?: boolean;
}

/** R7 — an employee's standing salary structure (annual components; the
 * payslip generator divides by 12). */
export interface SalaryStructureT {
  id: string;
  userId: string;
  userName: string;
  jobTitle: string;
  department: string;
  /** Copied from the signed offer when created from one (display hint). */
  source: "OFFER" | "MANUAL";
  components: OfferComponentT[];
  notes: string;
  effectiveFrom: string;
  isActive: boolean;
  createdAt: string;
  /** P5 (PR-15/PR-B04, F3.2) — the flexible-benefit cap (annual; 0 = no
   * cap). Pre-P5 rows read as 0. */
  maxBenefits: number;
  /** P10 (PR-B05) — the cadence this structure pays on (PR-03's
   * payroll_frequency). Pre-P10 rows read as MONTHLY. */
  frequency: PayrollFrequencyT;
  /** P16 (PR-04) — optional component-keyed YTD opening rows (annual
   * amounts earned before this system; seeds the fiscal year containing
   * this structure's effectiveFrom in the read-time aggregates). null =
   * none (pre-P16 rows). */
  openingYtd: OpeningYtdRowT[] | null;
  /** P23 (PR-03) — the workspace default package flag: at most one
   * structure carries it; new structures prefill from its components.
   * Pre-P23 rows read false. */
  isDefault: boolean;
}

/** P16 (PR-04) — one opening row on a structure. gross/net openings derive
 * from the rows at aggregate time (Σ earnings − Σ deductions). */
export interface OpeningYtdRowT {
  key: string;
  label: string;
  side: "EARNING" | "DEDUCTION";
  amount: number;
}

/** F1.5 — one catalog row of the salary component vocabulary
 * (payroll:manage). `code` joins onto OfferComponentT.key; the structure
 * editor's picker prefills a line from a row. defaultAmount is a SUGGESTION
 * by mode (FIXED → annual amount; PERCENT_OF_* → percent of the named
 * basis — P23 widens the percent vocabulary) — structures snapshot their
 * own copies, so this never rewrites history. */
export interface SalaryComponentT {
  id: string;
  code: string;
  label: string;
  kind: "EARNING" | "EMPLOYER_CONTRIBUTION" | "DEDUCTION" | "STATISTICAL";
  mode: "FIXED" | "PERCENT_OF_BASIC" | "PERCENT_OF_GROSS" | "PERCENT_OF_NET";
  defaultAmount: number;
  /** PR-B02 (S6) — depends_on_payment_days: false = window-exempt flat
   * line (no S5 scaling, no LOP docking). Default true. */
  dependsOnPaymentDays: boolean;
  /** P16 (PR-11) — optional catalog validity window (null = unbounded).
   * The structure editor badges rows whose window doesn't cover the
   * structure's effectiveFrom; saveSalaryStructure refuses them. */
  effectiveFrom: string | null;
  effectiveTo: string | null;
  isActive: boolean;
  sortOrder: number;
  createdAt: string;
}

/** R7 — one monthly payroll period. status: OPEN (editable) → LOCKED (paid,
 * immutable). Totals are aggregated across the run's payslips. workingDays
 * (F1.1) is the holiday-aware LOP denominator denormalized at creation
 * (0 = pre-F1.1 run → readers fall back to the calendar month length). */
export interface PayrollRunT {
  id: string;
  period: string;
  /** P10 — the cadence key + the run's real window (ISO dates; null only
   * for rows that predate the P10 backfill, where the client falls back to
   * parsing `period`). */
  frequency: "MONTHLY" | "BIMONTHLY" | "WEEKLY" | "FORTNIGHTLY" | "DAILY" | "QUARTERLY" | "ANNUAL";
  startDate: string | null;
  endDate: string | null;
  status: "OPEN" | "LOCKED";
  lockedBy: string | null;
  lockedAt: string | null;
  payslipCount: number;
  totalGross: number;
  totalNet: number;
  workingDays: number;
  createdAt: string;
}

/** R7 — one employee's payslip in a run. Lines are monthly amounts;
 * ytdNet accumulates the same-year periods up to and including this one.
 * runWorkingDays (F1.1) mirrors the run's holiday-aware denominator so the
 * editor's live LOP preview matches the server's stored math.
 * lopSource (F1.4): AUTO = lopDays was derived at run creation from
 * attendance + unpaid leave; MANUAL = an HR override (audited). */
export interface PayslipT {
  id: string;
  runId: string;
  runPeriod: string;
  runStatus: "OPEN" | "LOCKED";
  runWorkingDays: number;
  userId: string;
  userName: string;
  jobTitle: string;
  slipNo: string;
  earnings: PayslipLineT[];
  deductions: PayslipLineT[];
  note: string;
  lopDays: number;
  lopSource: "AUTO" | "MANUAL";
  /** P15 (PR-06) — the creation-time charge breakdown (the Salary Slip
   * Leave child, Fernly-shaped). null = nothing was docked, the slip
   * predates P15, or a MANUAL LOP override replaced the derivation. */
  lopDetail: LopDetailT | null;
  /** F-R2 (S1) — optimistic-lock version; carried back as expectedVersion
   * when the modal saves, refused on mismatch. */
  version: number;
  /** PR-B06 (S5) — working days inside the employment window, snapshotted at
   * creation; earnings are scaled to it. null = pre-S5 full-period rows. */
  paidDays: number | null;
  gross: number;
  net: number;
  ytdNet: number;
  /** P11 (PR-B09) — read-time period aggregates: YTD gross alongside the
   * YTD net, month-to-date net (the calendar month of the run's window
   * end — meaningful when several slips land in one month, e.g. weekly
   * cadences), and per-component YTD rows for the modal's per-line
   * display. WITHHELD/RELEASED slips carry the last paid values. */
  ytdGross: number;
  mtdNet: number;
  componentYtd: ComponentYtdRowT[];
  /** P16 (PR-11) — the fiscal-year basis the aggregates were computed under
   * (1 = calendar year; the modal renders "YTD (FY 2026/27)" otherwise).
   * Optional: omitted by older callers / the live preview. */
  fiscalYearStartMonth?: number;
  /** P17 (PR-B25) — the employee's live leave balances at read time (the
   * benchmark's show_leave_balances_in_salary_slip): one row per type with
   * available days. Present only when the workspace toggle is on; never
   * snapshotted onto the slip. */
  leaveBalances?: { typeName: string; availableDays: number }[];
  /** P8 (PR-19/PR-B13) — "" normal | WITHHELD (net held, not disbursed;
   * excluded from YTD) | RELEASED (paid via a WITHHELD_RELEASE adjustment
   * in a later period). */
  withholdStatus: "" | "WITHHELD" | "RELEASED";
}

/** P15 (PR-06) — one leave row of the payslip's frozen LOP breakdown:
 * the working days the span covered inside the run's window (takenDays),
 * the days it docked (chargedDays = Σ (1 − fraction) × working fraction),
 * the type's salary fraction paid per day (1 = fully paid; 0 for unpaid
 * types), and the paid flag for display. */
export interface LopDetailLeaveRowT {
  leaveTypeId: string;
  code: string;
  name: string;
  takenDays: number;
  chargedDays: number;
  fraction: number;
  paid: boolean;
}

/** P15 (PR-06) — the per-slip LOP charge breakdown frozen at creation
 * (Payslip.lopDetail): which leave spans covered the window plus the
 * attendance-side docks. Every number is a working-day fraction. */
export interface LopDetailT {
  absentDays: number;
  halfDays: number;
  unmarkedDays: number;
  leave: LopDetailLeaveRowT[];
}

/** P11 (PR-B09) — one per-component YTD row (side + line key + running
 * year total). */
export interface ComponentYtdRowT {
  key: string;
  label: string;
  side: "EARNING" | "DEDUCTION";
  amount: number;
}

/** P1 (PR-12/PR-B10, F2.3) — one adapter row: a special payment (encashment,
 * arrears delta, LWP credit, retention bonus, benefit payout, withheld
 * release, manual incentive) waiting for the run covering its period to
 * resolve it into payslip lines. userName resolved per row for the list. */
export interface PayAdjustmentT {
  id: string;
  userId: string;
  userName: string;
  sourceType: string;
  sourceId: string;
  componentCode: string;
  label: string;
  side: "EARNING" | "DEDUCTION";
  recurrence: "ONE_SHOT" | "RECURRING" | "OVERWRITE";
  calcMode: "FIXED" | "PERCENT_OF_GROSS" | "PERCENT_OF_NET";
  percent: number | null;
  amount: number;
  period: string;
  endPeriod: string | null;
  lastConsumedPeriod: string;
  status: "PENDING" | "CONSUMED" | "SKIPPED";
  skipReason: string;
  note: string;
  consumedRunPeriod: string;
  createdAt: string;
}

/** P5 (PR-15–18, PR-B04, F3.2) — the Benefits panel's data: this year's
 * elections with live accrued balances (Σ ledger deltas) and the structure
 * cap per employee. */
export interface BenefitsOverviewT {
  year: number;
  rows: Array<{
    id: string;
    userId: string;
    userName: string;
    year: number;
    componentCode: string;
    label: string;
    annualAmount: number;
    status: "ACTIVE" | "CANCELLED";
    cap: number;
    balance: number;
    createdAt: string;
  }>;
}

/** P4 (PR-14/PR-B12, F3.1) — one paid slip's LWP-reversal facts for the
 * correction modal: what was docked (days + the stored LOP line's amount),
 * what was already reversed (Σ sourceDays of LWP_CREDIT rows), and the
 * per-day price the refund uses. */
export interface LwpCorrectionPreviewT {
  payslipId: string;
  userId: string;
  userName: string;
  slipNo: string;
  period: string;
  storedLopDays: number;
  storedLopAmount: number;
  alreadyReversedDays: number;
  reversibleDays: number;
  perDay: number;
}

/** P3 (PR-13/PR-B11, F3.1) — one LOCKED slip's arrears verdict from the
 * preview: what it paid, what it would pay under the current structure,
 * the positive delta owed (arrears), and whether an ARREARS row already
 * covers it (idempotency). */
export interface ArrearsPreviewT {
  payslipId: string;
  userId: string;
  userName: string;
  slipNo: string;
  period: string;
  storedNet: number;
  simulatedNet: number;
  delta: number;
  owed: boolean;
  reason: string;
  alreadyArranged: boolean;
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

/** R8 — recruitment funnel analytics (getHiringFunnel): pool totals, per-stage
 * load + velocity, and the offer funnel. hiring:view — not salary-sensitive. */
export interface HiringFunnelT {
  totals: { total: number; active: number; selected: number; hired: number; rejected: number; withdrawn: number };
  stages: Array<{ stageKey: string; label: string; inStage: number; passed: number; avgDays: number | null }>;
  /** F2.10 — expired counts lapsed/lapsing SENT links separately from
   * awaiting (F-R5: stale links never inflate the awaiting number). */
  offers: { total: number; awaiting: number; signed: number; declined: number; expired: number; acceptRate: number | null };
}

/** F2.10 — one row of the configurable onboarding template
 * (OnboardingTemplateTask; the F-R8 single source). */
export interface OnboardingTemplateTaskT {
  id: string;
  kind: string;
  title: string;
  dueOffsetDays: number;
  assignSelf: boolean;
  /** P35 (EM-B06) — the user XOR role assignee (exactly one non-null/
   * non-empty at most; both empty = the assignSelf discipline). */
  assigneeUserId: string | null;
  assigneeRole: string;
  /** P35 (EM-12) — required_for_employee_creation. */
  isRequired: boolean;
  isActive: boolean;
  sortOrder: number;
}

// ---------------------------------------------------------------------------
// P7 (PR-20/PR-21, F3.3) — the gratuity rule (config) and its slabs.
// ---------------------------------------------------------------------------

/** One years→fraction band of the gratuity rule. */
export interface GratuitySlabT {
  id: string;
  fromYears: number;
  toYears: number | null;
  fraction: number;
}

/** The workspace's gratuity rule (singleton row + slab rows). */
export interface GratuityRuleT {
  enabled: boolean;
  averagingMonths: number;
  slabs: GratuitySlabT[];
}

// ---------------------------------------------------------------------------
// P8 (PR-19/PR-B13, F3.3) — salary withholding (the lite state machine).
// ---------------------------------------------------------------------------

/** One hold window + its terminal release (listSalaryWithholdings rows). */
export interface SalaryWithholdingT {
  id: string;
  userId: string;
  userName: string;
  fromPeriod: string;
  untilPeriod: string | null;
  reason: string;
  status: "ACTIVE" | "RELEASED";
  /** Where the held net was/will be paid (RELEASED rows). */
  releasePeriod: string | null;
  releasedAt: string | null;
  /** Live hold balance: WITHHELD slips not yet released. */
  heldSlipCount: number;
  heldTotal: number;
}
