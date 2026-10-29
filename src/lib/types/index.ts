// Shared Fernly types — mirror Prisma models but client-safe

export type ProjectStatus = "RUNNING" | "ENDED" | "PENDING" | "PAUSED";
export type Priority = "HIGH" | "MEDIUM" | "LOW";
export type TaskStatus = "TODO" | "IN_PROGRESS" | "IN_REVIEW" | "DONE";
export type TaskTag = "FRONTEND" | "BACKEND" | "DESIGN" | "QA" | "MARKETING";
export type Department = "ENGINEERING" | "DESIGN" | "MARKETING" | "MANAGEMENT";
export type EventType = "MEETING" | "DEADLINE" | "REVIEW" | "SOCIAL" | "FOCUS";
type AccentColor = "forest" | "ocean" | "plum" | "ember" | "slate";

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
}

export interface TimeEntryT {
  id: string;
  projectId: string | null;
  memberId: string | null;
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
