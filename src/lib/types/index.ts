// Shared Fernly types — mirror Prisma models but client-safe

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
export type AttendanceSource = "MANUAL" | "IMPORT" | "DERIVED";

/** One attendance record, client-shaped ("yyyy-mm-dd" date, "HH:mm" times). */
export interface AttendanceT {
  id: string;
  userId: string;
  userName: string;
  date: string;
  status: AttendanceStatus;
  inTime: string | null;
  outTime: string | null;
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
}

export interface LeaveTypeT {
  id: string;
  name: string;
  code: string;
  requiresDoc: boolean;
  paid: boolean;
  color: string;
  active: boolean;
  policy: {
    annualDays: number;
    maxCarryOver: number;
    minNoticeDays: number;
    maxConsecutiveDays: number;
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

// HR module feature 2 — employee directory (docs/HR_MODULE_PLAN.md §5).
// HR module feature 3 — performance reviews (docs/HR_MODULE_PLAN.md §6).
export type ReviewStatus = "DRAFT" | "SUBMITTED" | "REVIEWED" | "ACKNOWLEDGED";

export interface PerformanceReviewT {
  id: string;
  userId: string;
  userName: string;
  title: string;
  periodStart: string;
  periodEnd: string;
  status: ReviewStatus;
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
  dueOffsetDays: number;
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
  completedAt: string | null;
  createdAt: string;
  tasks: OnboardingTaskT[];
}

export interface EmployeeProfileT {
  id: string;
  userId: string;
  name: string;
  email: string;
  role: string;
  managerName: string | null;
  jobTitle: string;
  /** QA-19: "" means "not classified yet" — rendered as "—" until HR sets it. */
  department: "ENGINEERING" | "DESIGN" | "MARKETING" | "MANAGEMENT" | "";
  hireDate: string | null;
  phone: string;
  location: string;
  emergencyContactName: string;
  emergencyContactPhone: string;
  skills: string;
  notes: string;
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
  sortOrder: number;
  isActive: boolean;
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

/** R5 — one salary line of an offer (lib/offer-math.ts). */
export type OfferComponentT = {
  key: string;
  label: string;
  kind: "EARNING" | "EMPLOYER_CONTRIBUTION" | "DEDUCTION";
  mode: "FIXED" | "PERCENT_OF_BASIC";
  amount: number;
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

/** R5 — one offer for one candidate. status: DRAFT → SENT → SIGNED | DECLINED.
 * R6 adds the e-sign fields: token (null while DRAFT), expiry, and the typed
 * signature capture (signedAt/signedName/signedIp). */
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
}

/** R7 — one monthly money line on a payslip (see lib/payroll-math.ts). */
export interface PayslipLineT {
  key: string;
  label: string;
  amount: number;
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
}

/** R7 — one monthly payroll period. status: OPEN (editable) → LOCKED (paid,
 * immutable). Totals are aggregated across the run's payslips. workingDays
 * (F1.1) is the holiday-aware LOP denominator denormalized at creation
 * (0 = pre-F1.1 run → readers fall back to the calendar month length). */
export interface PayrollRunT {
  id: string;
  period: string;
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
  gross: number;
  net: number;
  ytdNet: number;
}

/** R8 — recruitment funnel analytics (getHiringFunnel): pool totals, per-stage
 * load + velocity, and the offer funnel. hiring:view — not salary-sensitive. */
export interface HiringFunnelT {
  totals: { total: number; active: number; selected: number; hired: number; rejected: number; withdrawn: number };
  stages: Array<{ stageKey: string; label: string; inStage: number; passed: number; avgDays: number | null }>;
  offers: { total: number; awaiting: number; signed: number; declined: number; acceptRate: number | null };
}
