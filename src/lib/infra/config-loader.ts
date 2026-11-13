import { db } from "@/lib/infra/db";
import {
  TASK_STATUSES,
  PROJECT_STATUSES,
  EVENT_TYPES,
  DEPARTMENT_LABELS,
} from "@/lib/shared/config";
import { PRIORITIES, TASK_TAGS } from "@/lib/shared/constants";
import { ROLE_PERMISSIONS, ROLE_LABELS, ROLE_DESCRIPTIONS } from "@/lib/auth/rbac";
import { DEFAULT_WORKSPACE_NAME } from "@/config/app";
import {
  getSharedRedisPublisher,
  subscribeToConfigInvalidation,
  configInvalidationChannel,
} from "@/lib/infra/redis-client";
import { logWarn, logInfo } from "@/lib/infra/observability";

// ---------------------------------------------------------------------------
// Types — the shape of the config object passed to the client.
// All fields are `string` (not literal unions) so DB-driven rows can extend
// the defaults additively without breaking TypeScript.
// ---------------------------------------------------------------------------

export interface TaskStatusConfigT {
  key: string;
  label: string;
  accentClass: string;
  sortOrder: number;
  isTerminal: boolean;
}

export interface ProjectStatusConfigT {
  key: string;
  label: string;
  badgeClass: string;
  dotClass: string;
  sortOrder: number;
}

export interface EventTypeConfigT {
  key: string;
  label: string;
  dotClass: string;
  bgClass: string;
  sortOrder: number;
}

export interface TaskTagConfigT {
  key: string;
  label: string;
  color: string; // oklch string
  sortOrder: number;
}

export interface PriorityConfigT {
  key: string;
  label: string;
  color: string;
  sortOrder: number;
}

export interface DepartmentConfigT {
  key: string;
  label: string;
  sortOrder: number;
}

export interface RoleConfigT {
  id: string;
  key: string;
  label: string;
  description: string;
  iconName: string;
  badgeClass: string;
  isSystem: boolean;
  sortOrder: number;
  permissions: string[]; // permission keys
}

export interface PermissionConfigT {
  key: string;
  label: string;
  description: string;
  group: string;
}

/** P24 (PL-01) — one customized notification event, verbatim from the
 * NotificationTemplate row. Rows exist only for CUSTOMIZED events; the
 * built-in defaults live in lib/email/notification-template.ts's registry and
 * resolveNotificationTemplate falls back to them when no row matches. */
export interface NotificationTemplateConfigT {
  eventKey: string;
  subjectTemplate: string;
  bodyTemplate: string;
  titleTemplate: string;
  messageTemplate: string;
}

export interface WorkspaceSettingsT {
  name: string;
  defaultTimezone: string;
  defaultUserRole: string;
  defaultDepartment: string;
  defaultAvatarColor: string;
  defaultJobTitle: string;
  minPasswordLength: number;
  workloadFullCapacity: number;
  auditLogLimit: number;
  auditRetentionDays: number;
  entityHistoryLimit: number;
  dashboardNotifLimit: number;
  /** R6 — the deterministic hire-email domain. Typed here since F2.10:
   * markJoined previously read it through a cast because the type omitted
   * it (the field itself is as old as the hiring module). */
  hiringEmailDomain: string;
  /** F2.10 (F-R9/E5) — the joining gate on markJoined. Default true. */
  joiningGateEnabled: boolean;
  /** AT-B02/B03 (S2) — the reference day for late/early flags + working
   * hours ("HH:MM"). The knob behind Settings → General; the rule is the
   * pure lib/hr/attendance-flags.ts kernel. Defaults 09:00 / 17:30. */
  attendanceDayStart: string;
  attendanceDayEnd: string;
  /** PR-B07 (S4) — consider_unmarked_attendance_as: IGNORED (default,
   * pre-S4 semantics) or ABSENT (unmarked working days charge LOP).
   * Consumed by the pure lib/payroll/lop-derivation.ts kernel at run creation. */
  unmarkedAttendanceMode: "IGNORED" | "ABSENT";
  /** PR-B23 (S7) — the payslip rounding policy: ROUND_2DP (default, no
   * rounding line) or ROUND_NET_NEAREST (auto "Rounding" line to a whole
   * dollar). Consumed by lib/payroll/payroll-math.ts withRoundingLine. */
  payrollRoundingMode: "ROUND_2DP" | "ROUND_NET_NEAREST";
  /** P9 (PR-B26) — pay attendance overtime into payroll. Default OFF; when
   * on, run creation emits an "Overtime" earning line per employee from the
   * derived overtimeMinutes (lib/payroll/overtime-bridge.ts prices it). */
  overtimePayEnabled: boolean;
  /** P16 (PR-11) — the month the fiscal year starts (1–12). 1 = calendar
   * year (the default, pre-P16 semantics); e.g. 4 = April–March. The
   * payslip-aggregates kernel resets YTD at the fiscal boundary. */
  fiscalYearStartMonth: number;
  /** P17 (PR-B27) — who decides the daily LOP charge (the benchmark's
   * payroll_based_on): HYBRID (default — leave-wins), LEAVE (spans only),
   * or ATTENDANCE (marks only). Consumed by lib/payroll/lop-derivation.ts at
   * run/slip creation. */
  lopBasisMode: "HYBRID" | "LEAVE" | "ATTENDANCE";
  /** P17 (PR-B25) — show live leave balances on the payslip surfaces
   * (read-time; default OFF). */
  showLeaveBalancesOnSlip: boolean;
  /** P18 (PR-B16) — email each payslip when its run locks (one PAYSLIP
   * outbox row per slip, HTML summary — the PDF stays the download-only
   * decision §9.2). Default OFF = the pre-P18 silence. */
  emailPayslipsOnLock: boolean;
  /** P21 (LV-T01/LV-T02) — opt-in leave email notifications: LEAVE_PENDING
   * to the resolved approvers on request creation and LEAVE_DECIDED to the
   * requester on decision, beside the unconditional in-app rows. Default
   * OFF = the F-R17 zero-mail posture. */
  emailLeaveNotifications: boolean;
  /** P25 (PL-02/EM-23) — the three engagement digest switches (birthday,
   * work anniversary, advance-holiday in-app broadcasts). Default ON (the
   * benchmark's own default); they only fire via the daily cron route. */
  remindBirthdays: boolean;
  remindAnniversaries: boolean;
  remindHolidays: boolean;
  /** P25 (EM-J03) — days ahead of each holiday the reminder fires
   * (exact-day match, clamped 1–30). Default 7. */
  holidayReminderDaysAhead: number;
  /** P25 — the EMAIL half of the engagement engine (one digest outbox row
   * per live member per due event, via the P24 template registry).
   * Default OFF = the F-R17 zero-mail posture. */
  emailEngagementReminders: boolean;
  /** P26 (PL-03/RJ-B18) — the in-app interview nudge switch: one personal
   * notification per interviewer per same-day scheduled interview, from
   * the daily cron route. Default ON (the benchmark ships interview
   * reminders on); no scheduler, no rows. */
  remindInterviews: boolean;
  /** P26 — the EMAIL half of the interview pass (one outbox row per newly
   * nudged interview, via the P24 template registry). Default OFF = the
   * F-R17 zero-mail posture. */
  emailInterviewReminders: boolean;
  /** P31 (LV-J02 / LV-09's remainder) — the encashment auto-draft switch:
   * when ON, the daily dispatcher's encashment pass drafts ONE pending
   * LeaveEncashment per (member × encashable type × year) whose ledger
   * balance exceeds the type's floor (one live draft per pair; a
   * rejection stands for the year). Default OFF — drafting on members'
   * behalf is a workspace policy choice. */
  autoLeaveEncashment: boolean;
  /** P33 (EM-B02) — the retirement-age display knob (the benchmark's HR
   * Settings retirement_age). Null = not configured → the directory
   * profile modal renders no projection (the pre-P33 silence); when set
   * (40–80) each member's retirement projects from birthDate + this age.
   * Display-only: nothing gates on it. */
  retirementAge: number | null;
}

/** P0-6 (D-05/D-18, persona-audit) — mail-provider truth for the client:
 * computed from the environment (the mailer factory's source of truth), NOT
 * a DB setting. Drives the first-run guidance banners until RESEND_API_KEY
 * is set. Env is fixed per process, so the 10 s cache can never serve a
 * stale provider state. */
export interface MailConfigT {
  /** True when a transactional provider is wired (RESEND_API_KEY set). */
  configured: boolean;
  /** Provider label — "resend" when configured, "none" otherwise. */
  provider: "resend" | "none";
}

export interface WorkspaceConfig {
  workspace: WorkspaceSettingsT;
  mail: MailConfigT;
  taskStatuses: TaskStatusConfigT[];
  projectStatuses: ProjectStatusConfigT[];
  eventTypes: EventTypeConfigT[];
  taskTags: TaskTagConfigT[];
  priorities: PriorityConfigT[];
  departments: DepartmentConfigT[];
  roles: RoleConfigT[];
  permissions: PermissionConfigT[];
  /** P24 (PL-01) — customized notification events (override rows only). */
  notificationTemplates: NotificationTemplateConfigT[];
}

// ---------------------------------------------------------------------------
// In-memory cache — the config rarely changes, so we cache it for 10s.
// Calling `bumpConfigCache()` (after a config mutation) invalidates it.
//
// PR-31 (production-readiness round 2, roadmap §6.10) — instant
// cross-instance invalidation. The 10 s TTL was the only way instance B
// learned about instance A's config mutation (an admin's permission
// revocation, a renamed status, …). bumpConfigCache() now ALSO publishes on
// a Redis pub/sub channel; every instance's subscriber clears its local
// cache on the message, shrinking the staleness window from ≤10 s to the
// pub/sub round-trip. The TTL stays as a backstop (a lost message, a dead
// subscriber, a Redis outage) — pub/sub is delivery-not-guaranteed, the
// TTL is.
// ---------------------------------------------------------------------------

let cachedConfig: WorkspaceConfig | null = null;
let cacheTime = 0;
const CACHE_TTL = 10_000; // 10 seconds (pub/sub backstop — see above)

function clearLocalCache(): void {
  cachedConfig = null;
  cacheTime = 0;
}

/** Fire-and-forget: tell every instance (including future ones) to drop the cache. */
async function publishConfigInvalidation(): Promise<void> {
  try {
    const publisher = getSharedRedisPublisher();
    if (!publisher) return; // no Redis → single-instance, local clear suffices
    await publisher.publish(
      configInvalidationChannel(),
      `bump:${process.pid}:${Date.now()}`,
    );
  } catch (err) {
    // Delivery is best-effort; the TTL backstop covers a lost message.
    logWarn("[config] cross-instance invalidation publish failed (TTL backstop applies)", {
      metric: "config_invalidation_publish_failed",
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

let invalidationSubscriberStarted = false;

/** Lazily start the pub/sub listener — once per process, when Redis is configured. */
function ensureInvalidationSubscriber(): void {
  if (invalidationSubscriberStarted) return;
  invalidationSubscriberStarted = true;
  try {
    const handle = subscribeToConfigInvalidation(() => {
      // Another instance mutated config — drop our copy immediately.
      clearLocalCache();
    });
    if (handle) {
      logInfo("[config] cross-instance cache invalidation active (Redis pub/sub)");
    }
  } catch (err) {
    logWarn("[config] failed to start the invalidation subscriber (TTL backstop applies)", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Invalidate the in-process config cache and notify every other instance. */
export function bumpConfigCache() {
  clearLocalCache();
  // Void-intentional: bumpConfigCache stays synchronous for its server-action
  // callers; the publish rides along asynchronously and never blocks them.
  void publishConfigInvalidation();
}

/** Test-only: reset subscriber bookkeeping + the cache between cases. */
export function _resetConfigCacheForTests(): void {
  clearLocalCache();
  invalidationSubscriberStarted = false;
}

// ---------------------------------------------------------------------------
// Loader — reads all config tables in parallel, falls back to code defaults
// if the DB is empty (e.g. before the seed runs).
// ---------------------------------------------------------------------------

export async function getWorkspaceConfig(): Promise<WorkspaceConfig> {
  // PR-31 — start the cross-instance invalidation listener on first use.
  // No-op without REDIS_URL; a once-per-process guard makes this cheap.
  ensureInvalidationSubscriber();

  if (cachedConfig && Date.now() - cacheTime < CACHE_TTL) {
    return cachedConfig;
  }

  const [
    workspace,
    taskStatuses,
    projectStatuses,
    eventTypes,
    taskTags,
    priorities,
    departments,
    roles,
    permissions,
    notificationTemplates,
  ] = await Promise.all([
    db.workspace.findFirst({ where: { id: "default" } }),
    db.taskStatusConfig.findMany({ orderBy: { sortOrder: "asc" } }),
    db.projectStatusConfig.findMany({ orderBy: { sortOrder: "asc" } }),
    db.eventTypeConfig.findMany({ orderBy: { sortOrder: "asc" } }),
    db.taskTagConfig.findMany({ orderBy: { sortOrder: "asc" } }),
    db.priorityConfig.findMany({ orderBy: { sortOrder: "asc" } }),
    db.departmentConfig.findMany({ orderBy: { sortOrder: "asc" } }),
    db.role.findMany({
      orderBy: { sortOrder: "asc" },
      include: { permissions: { include: { permission: true } } },
    }),
    db.permission.findMany({ orderBy: { sortOrder: "asc" } }),
    db.notificationTemplate.findMany(),
  ]);

  const config: WorkspaceConfig = {
    // P0-6 — computed, non-DB section (see MailConfigT above).
    mail: {
      configured: Boolean(process.env.RESEND_API_KEY),
      provider: process.env.RESEND_API_KEY ? "resend" : "none",
    },

    workspace: workspace
      ? {
          name: workspace.name,
          defaultTimezone: workspace.defaultTimezone,
          defaultUserRole: workspace.defaultUserRole,
          defaultDepartment: workspace.defaultDepartment,
          defaultAvatarColor: workspace.defaultAvatarColor,
          defaultJobTitle: workspace.defaultJobTitle,
          minPasswordLength: workspace.minPasswordLength,
          workloadFullCapacity: workspace.workloadFullCapacity,
          auditLogLimit: workspace.auditLogLimit,
          auditRetentionDays: workspace.auditRetentionDays,
          entityHistoryLimit: workspace.entityHistoryLimit,
          dashboardNotifLimit: workspace.dashboardNotifLimit,
          hiringEmailDomain: workspace.hiringEmailDomain,
          joiningGateEnabled: workspace.joiningGateEnabled,
          attendanceDayStart: workspace.attendanceDayStart,
          attendanceDayEnd: workspace.attendanceDayEnd,
          unmarkedAttendanceMode: (workspace.unmarkedAttendanceMode === "ABSENT" ? "ABSENT" : "IGNORED"),
          payrollRoundingMode: (workspace.payrollRoundingMode === "ROUND_NET_NEAREST" ? "ROUND_NET_NEAREST" : "ROUND_2DP"),
          overtimePayEnabled: workspace.overtimePayEnabled === true,
          fiscalYearStartMonth: Math.min(Math.max(Math.round(workspace.fiscalYearStartMonth) || 1, 1), 12),
          lopBasisMode: (workspace.lopBasisMode === "LEAVE" || workspace.lopBasisMode === "ATTENDANCE" ? workspace.lopBasisMode : "HYBRID"),
          showLeaveBalancesOnSlip: workspace.showLeaveBalancesOnSlip === true,
          emailPayslipsOnLock: workspace.emailPayslipsOnLock === true,
          emailLeaveNotifications: workspace.emailLeaveNotifications === true,
          remindBirthdays: workspace.remindBirthdays !== false,
          remindAnniversaries: workspace.remindAnniversaries !== false,
          remindHolidays: workspace.remindHolidays !== false,
          holidayReminderDaysAhead: Math.min(Math.max(Math.round(workspace.holidayReminderDaysAhead) || 7, 1), 30),
          emailEngagementReminders: workspace.emailEngagementReminders === true,
          remindInterviews: workspace.remindInterviews !== false,
          emailInterviewReminders: workspace.emailInterviewReminders === true,
          autoLeaveEncashment: workspace.autoLeaveEncashment === true,
          // P33 — nullable knob: null = not configured (the pre-P33 silence).
          retirementAge:
            workspace.retirementAge == null
              ? null
              : Math.min(Math.max(Math.round(workspace.retirementAge) || 0, 40), 80),
        }
      : // Fallback defaults if the Workspace row doesn't exist yet
        {
          name: DEFAULT_WORKSPACE_NAME,
          defaultTimezone: "Pacific/Auckland",
          defaultUserRole: "MEMBER",
          defaultDepartment: "ENGINEERING",
          defaultAvatarColor: "forest",
          defaultJobTitle: "Team Member",
          minPasswordLength: 8,
          workloadFullCapacity: 6,
          auditLogLimit: 300,
          auditRetentionDays: 180,
          entityHistoryLimit: 50,
          dashboardNotifLimit: 20,
          hiringEmailDomain: "fernly.app",
          joiningGateEnabled: true,
          attendanceDayStart: "09:00",
          attendanceDayEnd: "17:30",
          unmarkedAttendanceMode: "IGNORED",
          payrollRoundingMode: "ROUND_2DP",
          overtimePayEnabled: false,
          fiscalYearStartMonth: 1,
          lopBasisMode: "HYBRID",
          showLeaveBalancesOnSlip: false,
          emailPayslipsOnLock: false,
          emailLeaveNotifications: false,
          remindBirthdays: true,
          remindAnniversaries: true,
          remindHolidays: true,
          holidayReminderDaysAhead: 7,
          emailEngagementReminders: false,
          remindInterviews: true,
          emailInterviewReminders: false,
          autoLeaveEncashment: false,
          retirementAge: null,
        },

    taskStatuses: taskStatuses.length
      ? taskStatuses.map((s) => ({
          key: s.key,
          label: s.label,
          accentClass: s.accentClass,
          sortOrder: s.sortOrder,
          isTerminal: s.isTerminal,
        }))
      : TASK_STATUSES.map((s, i) => ({
          key: s.key,
          label: s.label,
          accentClass: s.accent,
          sortOrder: i,
          isTerminal: s.key === "DONE",
        })),

    projectStatuses: projectStatuses.length
      ? projectStatuses.map((s) => ({
          key: s.key,
          label: s.label,
          badgeClass: s.badgeClass,
          dotClass: s.dotClass,
          sortOrder: s.sortOrder,
        }))
      : PROJECT_STATUSES.map((s, i) => ({
          key: s.key,
          label: s.label,
          badgeClass: s.badge,
          dotClass: s.dot,
          sortOrder: i,
        })),

    eventTypes: eventTypes.length
      ? eventTypes.map((e) => ({
          key: e.key,
          label: e.label,
          dotClass: e.dotClass,
          bgClass: e.bgClass,
          sortOrder: e.sortOrder,
        }))
      : EVENT_TYPES.map((e, i) => ({
          key: e.key,
          label: e.label,
          dotClass: e.dot,
          bgClass: e.bg,
          sortOrder: i,
        })),

    taskTags: taskTags.length
      ? taskTags.map((t) => ({
          key: t.key,
          label: t.label,
          color: t.color,
          sortOrder: t.sortOrder,
        }))
      : TASK_TAGS.map((key, i) => ({
          key,
          label: key.charAt(0) + key.slice(1).toLowerCase(),
          color: "oklch(0.6 0.08 250)",
          sortOrder: i,
        })),

    priorities: priorities.length
      ? priorities.map((p) => ({
          key: p.key,
          label: p.label,
          color: p.color,
          sortOrder: p.sortOrder,
        }))
      : PRIORITIES.map((key, i) => ({
          key,
          label: key.charAt(0) + key.slice(1).toLowerCase(),
          color:
            key === "HIGH"
              ? "oklch(0.58 0.18 25)"
              : key === "MEDIUM"
                ? "oklch(0.6 0.1 80)"
                : "oklch(0.6 0.05 250)",
          sortOrder: i,
        })),

    departments: departments.length
      ? departments.map((d) => ({
          key: d.key,
          label: d.label,
          sortOrder: d.sortOrder,
        }))
      : DEPARTMENT_LABELS.map((d, i) => ({
          key: d.key,
          label: d.label,
          sortOrder: i,
        })),

    roles: roles.length
      ? roles.map((r) => ({
          id: r.id,
          key: r.key,
          label: r.label,
          description: r.description,
          iconName: r.iconName,
          badgeClass: r.badgeClass,
          isSystem: r.isSystem,
          sortOrder: r.sortOrder,
          permissions: r.permissions.map((rp) => rp.permission.key),
        }))
      : // Fallback: derive from the hardcoded rbac.ts
        (Object.keys(ROLE_PERMISSIONS) as Array<keyof typeof ROLE_PERMISSIONS>).map(
          (key, i) => ({
            id: `fallback-${key}`,
            key,
            label: ROLE_LABELS[key],
            description: ROLE_DESCRIPTIONS[key],
            iconName: key === "ADMIN" ? "ShieldAlert" : key === "MANAGER" ? "ShieldCheck" : "Shield",
            badgeClass:
              key === "ADMIN"
                ? "bg-destructive/10 text-destructive"
                : key === "MANAGER"
                  ? "bg-primary/10 text-primary"
                  : "bg-muted text-muted-foreground",
            isSystem: true,
            sortOrder: i,
            permissions: ROLE_PERMISSIONS[key],
          }),
        ),

    permissions: permissions.length
      ? permissions.map((p) => ({
          key: p.key,
          label: p.label,
          description: p.description,
          group: p.group,
        }))
      : // Fallback: derive from rbac.ts ALL_PERMISSIONS (not available here,
        // so we derive from ROLE_PERMISSIONS values)
        Array.from(new Set(Object.values(ROLE_PERMISSIONS).flat())).map((key) => ({
          key,
          label: key,
          description: "",
          group: "General",
        })),

    // P24 — override rows only; the registry defaults live in code and
    // resolveNotificationTemplate applies them per event (empty table =
    // every event renders the pre-P24 constants, byte-identical).
    notificationTemplates: notificationTemplates.map((t) => ({
      eventKey: t.eventKey,
      subjectTemplate: t.subjectTemplate,
      bodyTemplate: t.bodyTemplate,
      titleTemplate: t.titleTemplate,
      messageTemplate: t.messageTemplate,
    })),
  };

  cachedConfig = config;
  cacheTime = Date.now();
  return config;
}

// ---------------------------------------------------------------------------
// Permission check helper — uses the DB-driven role config (with fallback).
// This replaces the hardcoded `hasPermission` from lib/auth/rbac.ts for
// server-side checks that need the latest DB-driven permissions.
// ---------------------------------------------------------------------------

export async function hasPermissionDb(
  userRole: string,
  permission: string,
): Promise<boolean> {
  const config = await getWorkspaceConfig();
  const role = config.roles.find((r) => r.key === userRole);
  if (!role) return false;
  return role.permissions.includes(permission);
}

// PR-64 — the effective permission list for a role: static floor ∪ DB
// ceiling. This is the exact union the server enforces per request
// (auth-guard's hasPermissionEnforced); shipping it to the client (SSR
// payload + getMyPermissions poll) is what makes an admin's role-permission
// save reflect for ALREADY-LOGGED-IN users without a re-login — the client
// used to consult only the static matrix, so DB-granted capabilities never
// appeared (nav items, buttons) until the next deploy.
//
// Deny-safe: if the config tables are unreadable, fall back to the static
// floor (same contract as hasPermissionEnforced) — a Role-table outage must
// not take the dashboard SSR down with it.
export async function getEffectivePermissions(role: string): Promise<string[]> {
  const floor = ROLE_PERMISSIONS[role as keyof typeof ROLE_PERMISSIONS] ?? [];
  try {
    const config = await getWorkspaceConfig();
    const dbRole = config.roles.find((r) => r.key === role);
    if (!dbRole) return [...floor];
    return [...new Set([...floor, ...dbRole.permissions])];
  } catch (err) {
    logWarn("[config] effective-permission lookup failed; static floor only", {
      metric: "effective_permissions_fallback",
      error: err instanceof Error ? err.message : String(err),
    });
    return [...floor];
  }
}
