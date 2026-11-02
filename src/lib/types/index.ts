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
  department: "ENGINEERING" | "DESIGN" | "MARKETING" | "MANAGEMENT";
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
}

export const EMPTY_DASHBOARD_DATA: DashboardData = {
  projects: [], tasks: [], members: [], reminders: [],
  notifications: [], timeEntries: [], events: [], messages: [],
  stats: { total: 0, ended: 0, running: 0, pending: 0, paused: 0, weeklyCompletion: 0, projectEndedPct: 0 },
  scope: { isMember: false, projectIds: null },
};
