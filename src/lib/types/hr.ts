// HR module types — attendance, the employee directory, performance reviews,
// the employment lifecycle + property history, onboarding (checklists + the
// configurable template), offboarding/exit interviews/full-and-final, the
// skill master + maps, and employee identification documents.
// (Split from the former lib/types/index.ts god-file.)


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
   * day (lib/hr/attendance-flags.ts). null = not computable. */
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
// math live in lib/hr/employment-change.ts; this is the shared wire type.
// ---------------------------------------------------------------------------

/** One structured property-history row (property / current / new). */
export interface EmploymentPropertyHistoryT {
  id: string;
  userId: string;
  /** jobTitle | department | manager | salary (registry in
   * lib/hr/employment-change.ts; grade joins at P34). */
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
   * Computed per read (lib/hr/onboarding-template's pure kernel) — never
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
// P38 — BONUS (pending PayAdjustment earnings) and PENDING_ENCASHMENT
// (APPROVED-unpaid encashment requests) join the line set.
export type FnFLineKind =
  | "SALARY"
  | "ENCASHMENT"
  | "ADVANCE_LEAVE"
  | "GRATUITY"
  | "BONUS"
  | "PENDING_ENCASHMENT"
  | "ADVANCE_RECEIVABLE";

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

/** The computed statement (pure output of lib/hr/full-and-final.ts). */
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
// P1 G6 — the Employee Transfer / Employee Promotion documents (the
// approval-gated, effective-dated employment-change writers). Client-safe
// mirrors of the Prisma rows: ISO strings, resolved display names, and the
// status as a plain string (the graph lives in lib/hr/employment-documents).
// ---------------------------------------------------------------------------

/** One transfer document row (serialized for the UI). */
export interface EmployeeTransferT {
  id: string;
  employeeId: string;
  fromDepartment: string | null;
  toDepartment: string | null;
  fromJobTitle: string | null;
  toJobTitle: string | null;
  fromManagerId: string | null;
  toManagerId: string | null;
  fromLocation: string | null;
  toLocation: string | null;
  /** "yyyy-mm-dd". */
  effectiveDate: string;
  reason: string | null;
  status: string;
  approvedById: string | null;
  approvedByName: string | null;
  approvedAt: string | null;
  cancelledById: string | null;
  cancelledAt: string | null;
  createdAt: string;
  createdById: string;
  createdByName: string;
  /** Resolved display names for the manager refs (null = no manager). */
  fromManagerName: string | null;
  toManagerName: string | null;
}

/** One promotion document row (serialized for the UI). */
export interface EmployeePromotionT {
  id: string;
  employeeId: string;
  fromJobTitle: string | null;
  toJobTitle: string;
  fromGrade: string | null;
  toGrade: string | null;
  /** "yyyy-mm-dd". */
  effectiveDate: string;
  reason: string | null;
  status: string;
  approvedById: string | null;
  approvedByName: string | null;
  approvedAt: string | null;
  cancelledById: string | null;
  cancelledAt: string | null;
  /** Optional pointer at the Phase 1B SalaryStructureAssignment this
   * promotion rides (the link is recorded, never acted on). */
  linkedSalaryAssignmentId: string | null;
  createdAt: string;
  createdById: string;
  createdByName: string;
}
