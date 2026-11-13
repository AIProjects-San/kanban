"use server";

// Workspace settings, config tables and role/permission management
// (all role:manage). Every mutation bumps the config cache so the next
// read sees the change.

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requirePermission, AuthorizationError } from "./auth-guard";
import { bumpConfigCache, getWorkspaceConfig, type WorkspaceConfig } from "@/lib/config-loader";
import { logAudit } from "./shared";
import { toResult } from "./result";
import type { ActionResult } from "@/lib/action-result";
import { workspaceSettingsSchema, configItemSchema, parseOrThrow } from "@/lib/validation";

/** Permissions only ADMIN may grant — a MANAGER granted role:manage by an
 *  admin could otherwise escalate themselves further. */
const PROTECTED_PERMS = ["role:manage"];

/**
 * Client-facing config loader. `getWorkspaceConfig` itself lives in
 * lib/config-loader (plain server code); this wrapper makes it callable
 * from client components as a server action, returning a result object.
 */
export async function loadWorkspaceConfig(): Promise<ActionResult<WorkspaceConfig>> {
  return toResult(async () => {
    // PR-04 (production-readiness audit) — session gate. This was the only
    // exported action with NO auth check: an anonymous caller could invoke it
    // and receive the workspace name, defaults and the full role/permission
    // matrix. None of it is secret to signed-in users, but the app's own
    // standard is deny-by-default — every other action requires at least a
    // session. The login screen renders without calling this action, so
    // gating it breaks nothing.
    const auth = await requirePermission("settings:edit");
    void auth;
    return getWorkspaceConfig();
  });
}

export async function updateWorkspaceSettings(input: Partial<{
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
  /** F2.10 — the joining-gate toggle (Settings → General). */
  joiningGateEnabled?: boolean;
  /** AT-B02/B03 (S2) — the reference day (HH:MM) behind the late/early
   * flags + working hours (Settings → General; lib/attendance-flags.ts). */
  attendanceDayStart?: string;
  attendanceDayEnd?: string;
  /** PR-B07 (S4) — consider_unmarked_attendance_as (Settings → General;
   * lib/lop-derivation.ts consumes it at run creation). */
  unmarkedAttendanceMode?: "IGNORED" | "ABSENT";
  /** PR-B23 (S7) — the payslip rounding policy (Settings → General;
   * lib/payroll-math.ts withRoundingLine consumes it). */
  payrollRoundingMode?: "ROUND_2DP" | "ROUND_NET_NEAREST";
  /** P9 (PR-B26) — pay attendance overtime into payroll (Settings →
   * General; lib/overtime-bridge.ts prices the slip line). */
  overtimePayEnabled?: boolean;
  /** P16 (PR-11) — the month the fiscal year starts (1–12; 1 = calendar
   * year; Settings → General; lib/payslip-aggregates.ts resets YTD at the
   * fiscal boundary). */
  fiscalYearStartMonth?: number;
  /** P17 (PR-B27) — who decides the daily LOP charge: HYBRID (default,
   * leave-wins) / LEAVE / ATTENDANCE (Settings → General;
   * lib/lop-derivation.ts consumes it at run/slip creation). */
  lopBasisMode?: "HYBRID" | "LEAVE" | "ATTENDANCE";
  /** P17 (PR-B25) — show live leave balances on the payslip surfaces
   * (read-time; default OFF). */
  showLeaveBalancesOnSlip?: boolean;
  /** P18 (PR-B16) — email each payslip when its run locks (default OFF =
   * the pre-P18 silence; Settings → General; lockPayrollRun queues the
   * PAYSLIP outbox rows). */
  emailPayslipsOnLock?: boolean;
  /** P21 (LV-T01/LV-T02) — leave email notifications (default OFF = the
   * F-R17 zero-mail posture; Settings → General; the leave chain queues
   * LEAVE_PENDING / LEAVE_DECIDED outbox rows when on). */
  emailLeaveNotifications?: boolean;
  /** P25 (PL-02/EM-23) — the engagement digest switches + the holiday
   * days-ahead knob (Settings → General; the daily cron route reads them). */
  remindBirthdays?: boolean;
  remindAnniversaries?: boolean;
  remindHolidays?: boolean;
  holidayReminderDaysAhead?: number;
  /** P25 — the opt-in email half of the engagement engine. */
  emailEngagementReminders?: boolean;
  /** P26 (PL-03/RJ-B18) — the interview nudge switch + its opt-in email
   * rail (Settings → General; the daily cron route's interview pass). */
  remindInterviews?: boolean;
  emailInterviewReminders?: boolean;
  /** P31 (LV-J02 / LV-09's remainder) — the encashment auto-draft switch
   * (Settings → General; the daily dispatcher's encashment pass drafts
   * one pending LeaveEncashment per encashable pair over the floor when
   * ON — default OFF, the pre-P31 silence). */
  autoLeaveEncashment?: boolean;
  /** P33 (EM-B02) — the retirement-age display knob (Settings → General;
   * the benchmark's HR Settings retirement_age). Null = not configured →
   * the directory's profile modal renders no projection. Display-only:
   * nothing gates on it. */
  retirementAge?: number | null;
}>): Promise<ActionResult<void>> {
  return toResult(async () => {
    const auth = await requirePermission("role:manage");
    // P1 (production-readiness re-audit) — validate the full input shape +
    // bounds before touching the DB. The prior implementation only validated
    // auditRetentionDays + name; the other 10 fields were written unvalidated.
    // A typo (e.g. minPasswordLength=1) was caught at read time but is now
    // caught at write time too. Strict mode rejects unknown keys.
    const data = parseOrThrow(workspaceSettingsSchema, input);
    await db.workspace.upsert({
      where: { id: "default" },
      create: { id: "default", ...data },
      update: data,
    });
    bumpConfigCache();
    await logAudit({
      actor: auth,
      action: "workspace.updated",
      entityType: "WORKSPACE",
      entityLabel: "Workspace Settings",
      detail: "Updated workspace settings",
    });
    revalidatePath("/");
  });
}

export async function updateConfigItem(
  table: "taskStatusConfig" | "projectStatusConfig" | "eventTypeConfig" | "taskTagConfig" | "priorityConfig" | "departmentConfig",
  id: string,
  data: Record<string, unknown>,
): Promise<ActionResult<void>> {
  return toResult(async () => {
    const auth = await requirePermission("role:manage");
    // P1 (production-readiness re-audit) — validate before the DB write so a
    // compromised admin session can't write arbitrary fields (CSS injection
    // via accentClass, sortOrder=NaN, etc.).
    const validated = parseOrThrow(configItemSchema, data);
    // @ts-expect-error — dynamic table name
    await db[table].update({ where: { id }, data: validated });
    bumpConfigCache();
    await logAudit({
      actor: auth,
      action: "config.updated",
      entityType: "CONFIG",
      entityLabel: table,
      detail: `Updated ${table} config item`,
    });
    revalidatePath("/");
  });
}

export async function createConfigItem(
  table: "taskStatusConfig" | "projectStatusConfig" | "eventTypeConfig" | "taskTagConfig" | "priorityConfig" | "departmentConfig",
  data: Record<string, unknown>,
): Promise<ActionResult<void>> {
  return toResult(async () => {
    const auth = await requirePermission("role:manage");
    // P1 re-audit — validate before the DB write.
    const validated = parseOrThrow(configItemSchema, data);
    // @ts-expect-error — dynamic table name
    await db[table].create({ data: validated });
    bumpConfigCache();
    await logAudit({
      actor: auth,
      action: "config.created",
      entityType: "CONFIG",
      entityLabel: table,
      detail: `Created ${table} config item`,
    });
    revalidatePath("/");
  });
}

export async function deleteConfigItem(
  table: "taskStatusConfig" | "projectStatusConfig" | "eventTypeConfig" | "taskTagConfig" | "priorityConfig" | "departmentConfig",
  id: string,
): Promise<ActionResult<void>> {
  return toResult(async () => {
    const auth = await requirePermission("role:manage");
    // P2 (edge-case audit) — guard against deleting in-use config keys.
    // Without this, deleting a TaskStatus that 50 tasks still reference
    // orphans those tasks (the board has no column for them). Mirror the
    // deleteRole check (L262-266): count references in the dependent table
    // and refuse if > 0.
    //
    // Map config table → (dependent table, column).
    const usageMap: Record<string, { model: keyof typeof db; column: string; label: string }> = {
      taskStatusConfig: { model: "task", column: "status", label: "tasks" },
      priorityConfig: { model: "task", column: "priority", label: "tasks" },
      taskTagConfig: { model: "task", column: "tag", label: "tasks" },
      projectStatusConfig: { model: "project", column: "status", label: "projects" },
      eventTypeConfig: { model: "calendarEvent", column: "type", label: "events" },
      departmentConfig: { model: "teamMember", column: "department", label: "members" },
    };
    // Fetch the config row's `key` so we can count references by key.
    // @ts-expect-error — dynamic table name
    const configRow = await db[table].findUnique({ where: { id }, select: { key: true } });
    if (!configRow) throw new AuthorizationError("Config item not found.");
    const usage = usageMap[table];
    if (usage) {
      const count = await (db[usage.model] as unknown as { count: (args: { where: Record<string, string> }) => Promise<number> }).count({
        where: { [usage.column]: configRow.key },
      });
      if (count > 0) {
        throw new AuthorizationError(
          `Cannot delete — ${count} ${usage.label} still use "${configRow.key}". Reassign them first.`,
        );
      }
    }
    // @ts-expect-error — dynamic table name
    await db[table].delete({ where: { id } });
    bumpConfigCache();
    await logAudit({
      actor: auth,
      action: "config.deleted",
      entityType: "CONFIG",
      entityLabel: table,
      detail: `Deleted ${table} config item (key: ${configRow.key})`,
    });
    revalidatePath("/");
  });
}

// --- Role + Permission management ---

export async function updateRole(roleId: string, data: {
  label?: string;
  description?: string;
  iconName?: string;
  badgeClass?: string;
  permissions?: string[]; // permission keys
}): Promise<ActionResult<void>> {
  return toResult(async () => {
    const auth = await requirePermission("role:manage");
    const role = await db.role.findUnique({ where: { id: roleId } });
    if (!role) throw new AuthorizationError("Role not found.");

    // PR-15 — role.update previously ran OUTSIDE the permission-replacement
    // transaction, so a crash between them could persist the label change
    // while rolling back the permissions (or vice versa). One transaction now
    // covers both.
    await db.$transaction(async (tx) => {
      await tx.role.update({
        where: { id: roleId },
        data: {
          ...(data.label !== undefined && { label: data.label }),
          ...(data.description !== undefined && { description: data.description }),
          ...(data.iconName !== undefined && { iconName: data.iconName }),
          ...(data.badgeClass !== undefined && { badgeClass: data.badgeClass }),
        },
      });

      // Update permissions if provided
      if (data.permissions !== undefined) {
        // P2 (production-readiness re-audit) — prevent privilege escalation:
        // `role:manage` is an ADMIN-only capability. A MANAGER with `role:manage`
        // (granted by an admin via the DB) could otherwise grant `role:manage`
        // to their own role, then grant `user:manage:any` to themselves, etc.
        // Only ADMIN may add `role:manage` to any role.
        if (auth.role !== "ADMIN") {
          const conflicting = data.permissions.filter((p) => PROTECTED_PERMS.includes(p));
          if (conflicting.length > 0) {
            throw new AuthorizationError(
              `Only ADMIN may grant: ${conflicting.join(", ")}.`,
            );
          }
        }
        // Replace atomically — a failure mid-way can never leave the role with
        // zero or duplicated permissions.
        await tx.rolePermission.deleteMany({ where: { roleId } });
        const perms = await tx.permission.findMany({
          where: { key: { in: data.permissions } },
        });
        await tx.rolePermission.createMany({
          data: perms.map((p) => ({ roleId, permissionId: p.id })),
        });
      }
    });

    bumpConfigCache();
    await logAudit({
      actor: auth,
      action: "role.changed",
      entityType: "ROLE",
      entityId: roleId,
      entityLabel: role.label,
      detail: `Updated role "${role.label}"${data.permissions !== undefined ? ` (${data.permissions.length} permissions)` : ""}`,
    });
    revalidatePath("/");
  });
}

export async function createRole(data: {
  key: string;
  label: string;
  description?: string;
  iconName?: string;
  badgeClass?: string;
  permissions?: string[];
}): Promise<ActionResult<void>> {
  return toResult(async () => {
    const auth = await requirePermission("role:manage");
    const existing = await db.role.findUnique({ where: { key: data.key } });
    if (existing) throw new AuthorizationError(`Role "${data.key}" already exists.`);

    // PR-15 (production-readiness audit) — the role row and its permission
    // grants are one logical write. Previously the role was created first and
    // permissions inserted one-by-one in a loop: a crash mid-loop left a
    // half-permissioned role, and the loop itself was an N+1 write. Both are
    // fixed — a single transaction with one createMany.
    const role = await db.$transaction(async (tx) => {
      const created = await tx.role.create({
        data: {
          key: data.key,
          label: data.label,
          description: data.description ?? "",
          iconName: data.iconName ?? "Shield",
          badgeClass: data.badgeClass ?? "bg-muted text-muted-foreground",
          isSystem: false,
          sortOrder: await tx.role.count(),
        },
      });
      if (data.permissions && data.permissions.length > 0) {
        // P2 re-audit — same protected-permission guard as updateRole.
        if (auth.role !== "ADMIN") {
          const conflicting = data.permissions.filter((p) => PROTECTED_PERMS.includes(p));
          if (conflicting.length > 0) {
            throw new AuthorizationError(
              `Only ADMIN may grant: ${conflicting.join(", ")}.`,
            );
          }
        }
        const perms = await tx.permission.findMany({
          where: { key: { in: data.permissions } },
        });
        await tx.rolePermission.createMany({
          data: perms.map((p) => ({ roleId: created.id, permissionId: p.id })),
        });
      }
      return created;
    });

    bumpConfigCache();
    await logAudit({
      actor: auth,
      action: "role.changed",
      entityType: "ROLE",
      entityId: role.id,
      entityLabel: role.label,
      detail: `Created role "${role.label}"`,
    });
    revalidatePath("/");
  });
}

export async function deleteRole(roleId: string): Promise<ActionResult<void>> {
  return toResult(async () => {
    const auth = await requirePermission("role:manage");
    const role = await db.role.findUnique({ where: { id: roleId } });
    if (!role) throw new AuthorizationError("Role not found.");
    if (role.isSystem) throw new AuthorizationError("System roles cannot be deleted.");
    // Check no users are using this role
    const usersWithRole = await db.user.count({ where: { role: role.key } });
    if (usersWithRole > 0) {
      throw new AuthorizationError(`Cannot delete role "${role.label}" — ${usersWithRole} user(s) still have it. Reassign them first.`);
    }
    await db.role.delete({ where: { id: roleId } });
    bumpConfigCache();
    await logAudit({
      actor: auth,
      action: "role.changed",
      entityType: "ROLE",
      entityId: roleId,
      entityLabel: role.label,
      detail: `Deleted role "${role.label}"`,
    });
    revalidatePath("/");
  });
}
