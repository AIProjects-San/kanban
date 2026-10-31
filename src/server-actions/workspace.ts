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

/**
 * Client-facing config loader. `getWorkspaceConfig` itself lives in
 * lib/config-loader (plain server code); this wrapper makes it callable
 * from client components as a server action, returning a result object.
 */
export async function loadWorkspaceConfig(): Promise<ActionResult<WorkspaceConfig>> {
  return toResult(() => getWorkspaceConfig());
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
}>): Promise<ActionResult<void>> {
  return toResult(async () => {
    const auth = await requirePermission("role:manage");
    // Deep-dive review F-09 — auditRetentionDays is the prune window (days);
    // clamp it so a typo can't set retention to 1 day (min 30). The other
    // numeric fields are display/UX limits with read-time guards.
    const data = { ...input };
    if (data.auditRetentionDays !== undefined) {
      if (!Number.isFinite(data.auditRetentionDays) || data.auditRetentionDays < 30 || data.auditRetentionDays > 3650) {
        throw new AuthorizationError("Audit retention must be between 30 and 3650 days.");
      }
      data.auditRetentionDays = Math.round(data.auditRetentionDays);
    }
    if (data.name !== undefined) data.name = String(data.name).slice(0, 120);
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
    // @ts-expect-error — dynamic table name
    await db[table].update({ where: { id }, data });
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
    // @ts-expect-error — dynamic table name
    await db[table].create({ data });
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
    // @ts-expect-error — dynamic table name
    await db[table].delete({ where: { id } });
    bumpConfigCache();
    await logAudit({
      actor: auth,
      action: "config.deleted",
      entityType: "CONFIG",
      entityLabel: table,
      detail: `Deleted ${table} config item`,
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

    await db.role.update({
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
      // Replace atomically — a failure mid-way can never leave the role with
      // zero or duplicated permissions.
      await db.$transaction(async (tx) => {
        await tx.rolePermission.deleteMany({ where: { roleId } });
        const perms = await tx.permission.findMany({
          where: { key: { in: data.permissions } },
        });
        await tx.rolePermission.createMany({
          data: perms.map((p) => ({ roleId, permissionId: p.id })),
        });
      });
    }

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

    const role = await db.role.create({
      data: {
        key: data.key,
        label: data.label,
        description: data.description ?? "",
        iconName: data.iconName ?? "Shield",
        badgeClass: data.badgeClass ?? "bg-muted text-muted-foreground",
        isSystem: false,
        sortOrder: await db.role.count(),
      },
    });

    if (data.permissions && data.permissions.length > 0) {
      const perms = await db.permission.findMany({
        where: { key: { in: data.permissions } },
      });
      for (const p of perms) {
        await db.rolePermission.create({
          data: { roleId: role.id, permissionId: p.id },
        });
      }
    }

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
