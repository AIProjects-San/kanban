import { db } from "@/lib/db";
import {
  TASK_STATUSES,
  PROJECT_STATUSES,
  EVENT_TYPES,
  DEPARTMENT_LABELS,
} from "@/lib/config";
import { PRIORITIES, TASK_TAGS } from "@/lib/constants";
import { ROLE_PERMISSIONS, ROLE_LABELS, ROLE_DESCRIPTIONS } from "@/lib/rbac";
import { DEFAULT_WORKSPACE_NAME } from "@/config/app";

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
}

export interface WorkspaceConfig {
  workspace: WorkspaceSettingsT;
  taskStatuses: TaskStatusConfigT[];
  projectStatuses: ProjectStatusConfigT[];
  eventTypes: EventTypeConfigT[];
  taskTags: TaskTagConfigT[];
  priorities: PriorityConfigT[];
  departments: DepartmentConfigT[];
  roles: RoleConfigT[];
  permissions: PermissionConfigT[];
}

// ---------------------------------------------------------------------------
// In-memory cache — the config rarely changes, so we cache it for 60s.
// Calling `bumpConfigCache()` (after a config mutation) invalidates it.
// ---------------------------------------------------------------------------

let cachedConfig: WorkspaceConfig | null = null;
let cacheTime = 0;
// P2 (production-readiness re-audit) — shortened from 60s to 10s. With 2
// replicas, an admin's permission revocation is visible on instance A
// immediately (via bumpConfigCache) but only on instance B after the TTL
// expires. 60s was too long for a security-relevant cache (the RBAC ceiling
// reads through this). 10s is a better tradeoff: still avoids hammering the
// DB on every request, but caps the staleness window at a tolerable level.
// For instant cross-instance invalidation, move bumpConfigCache to Redis
// pub/sub (future work).
const CACHE_TTL = 10_000; // 10 seconds

export function bumpConfigCache() {
  cachedConfig = null;
  cacheTime = 0;
}

// ---------------------------------------------------------------------------
// Loader — reads all config tables in parallel, falls back to code defaults
// if the DB is empty (e.g. before the seed runs).
// ---------------------------------------------------------------------------

export async function getWorkspaceConfig(): Promise<WorkspaceConfig> {
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
  ]);

  const config: WorkspaceConfig = {
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
  };

  cachedConfig = config;
  cacheTime = Date.now();
  return config;
}

// ---------------------------------------------------------------------------
// Permission check helper — uses the DB-driven role config (with fallback).
// This replaces the hardcoded `hasPermission` from lib/rbac.ts for
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
