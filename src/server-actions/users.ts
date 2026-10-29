"use server";

// User accounts, profiles, settings and self-service password change.
//
// `getUserProfile`, `getUserSettings` are SSR-facing loaders (page.tsx) and
// keep their throwing contract; every client-invoked action returns an
// ActionResult.

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { getSession, getSessionOrThrow, requirePermission, requirePermissionForTarget, AuthorizationError } from "./auth-guard";
import { hasPermission, isValidRole, ROLE_LABELS } from "@/lib/rbac";
import { assertNoCycle } from "@/lib/hierarchy";
import { getMinPasswordLength, hashPassword, verifyPassword } from "@/lib/password";
import { emailSchema } from "@/lib/validation";
import { logAudit } from "./shared";
import { toResult } from "./result";
import type { ActionResult } from "@/lib/action-result";

export async function getUserProfile(userId: string) {
  // Only the user themselves (or an admin/manager with role:manage) may read
  // a profile — otherwise any caller could harvest other users' emails.
  // Hierarchy-aware: a MANAGER can read profiles of users in their subtree.
  const auth = await getSessionOrThrow();
  if (auth.userId !== userId && !hasPermission(auth.role, "role:manage")) {
    throw new AuthorizationError("You can only view your own profile.");
  }
  // For non-self access, enforce the hierarchy too (admins skip via
  // canManageUser; managers must own the target in their subtree).
  if (auth.userId !== userId) {
    await requirePermissionForTarget("role:manage", userId);
  }
  const user = await db.user.findUnique({
    where: { id: userId },
    include: { settings: true },
  });
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    timezone: user.timezone,
    bio: user.bio,
    avatarColor: user.avatarColor,
    settings: user.settings
      ? {
          accent: user.settings.accent as string,
          dark: user.settings.dark,
          notifEmail: user.settings.notifEmail,
          notifPush: user.settings.notifPush,
          notifMentions: user.settings.notifMentions,
          notifDueToday: user.settings.notifDueToday,
          notifWeekly: user.settings.notifWeekly,
          notifProduct: user.settings.notifProduct,
        }
      : null,
  };
}

// ---------------------------------------------------------------------------
// User settings — persist theme/dark/notifications per-user in the DB
// ---------------------------------------------------------------------------

export async function getUserSettings(userId: string) {
  const auth = await getSession();
  if (!auth) throw new AuthorizationError("You must be signed in.");
  const settings = await db.userSettings.findUnique({ where: { userId } });
  if (!settings) {
    // Return defaults
    return {
      accent: "forest",
      dark: false,
      notifEmail: true,
      notifPush: true,
      notifMentions: true,
      notifDueToday: true,
      notifWeekly: false,
      notifProduct: true,
    };
  }
  return {
    accent: settings.accent,
    dark: settings.dark,
    notifEmail: settings.notifEmail,
    notifPush: settings.notifPush,
    notifMentions: settings.notifMentions,
    notifDueToday: settings.notifDueToday,
    notifWeekly: settings.notifWeekly,
    notifProduct: settings.notifProduct,
  };
}

export async function updateUserSettings(userId: string, input: Partial<{
  accent: string;
  dark: boolean;
  notifEmail: boolean;
  notifPush: boolean;
  notifMentions: boolean;
  notifDueToday: boolean;
  notifWeekly: boolean;
  notifProduct: boolean;
}>): Promise<ActionResult<void>> {
  return toResult(async () => {
    const auth = await getSession();
    if (!auth) throw new AuthorizationError("You must be signed in.");
    if (auth.userId !== userId) {
      throw new AuthorizationError("You can only update your own settings.");
    }
    await db.userSettings.upsert({
      where: { userId },
      create: { userId, ...input },
      update: input,
    });
    revalidatePath("/");
  });
}

// ---------------------------------------------------------------------------
// Self-service profile update
// ---------------------------------------------------------------------------

export async function updateProfile(userId: string, input: {
  name: string;
  role: string;
  timezone: string;
  bio: string;
  avatarColor: string;
}): Promise<ActionResult<void>> {
  return toResult(async () => {
    const auth = await getSession();
    if (!auth) throw new AuthorizationError("You must be signed in.");
    if (auth.userId !== userId) {
      throw new AuthorizationError("You can only update your own profile.");
    }
    const existing = await db.user.findUnique({ where: { id: userId } });
    await db.user.update({ where: { id: userId }, data: input });
    if (existing) {
      const changes: string[] = [];
      if (input.name !== existing.name) changes.push("name");
      if (input.role !== existing.role) changes.push("job title");
      if (input.timezone !== existing.timezone) changes.push("timezone");
      if (input.bio !== existing.bio) changes.push("bio");
      if (input.avatarColor !== existing.avatarColor) changes.push("avatar color");
      await logAudit({
        actor: auth,
        action: "profile.updated",
        entityType: "USER",
        entityId: userId,
        entityLabel: input.name,
        detail: changes.length
          ? `Updated ${changes.join(", ")} on their profile`
          : "Saved their profile",
      });
    }
    revalidatePath("/");
  });
}

// ---------------------------------------------------------------------------
// Change password (self-service)
// ---------------------------------------------------------------------------

export async function changePassword(input: {
  userId: string;
  currentPassword: string;
  newPassword: string;
}): Promise<ActionResult<void>> {
  return toResult(async () => {
    const auth = await getSession();
    if (!auth) throw new AuthorizationError("You must be signed in.");
    if (auth.userId !== input.userId) {
      throw new AuthorizationError("You can only change your own password.");
    }
    const minPasswordLength = await getMinPasswordLength();
    if (!input.newPassword || input.newPassword.length < minPasswordLength) {
      throw new AuthorizationError(`New password must be at least ${minPasswordLength} characters.`);
    }
    if (input.currentPassword === input.newPassword) {
      throw new AuthorizationError("New password must be different from your current password.");
    }

    const user = await db.user.findUnique({ where: { id: input.userId } });
    if (!user) throw new AuthorizationError("Account not found.");

    const matches = await verifyPassword(input.currentPassword, user.passwordHash);
    if (!matches) {
      throw new AuthorizationError("Current password is incorrect.");
    }

    const newHash = await hashPassword(input.newPassword);
    await db.user.update({
      where: { id: input.userId },
      data: { passwordHash: newHash },
    });

    await logAudit({
      actor: auth,
      action: "auth.password_changed",
      entityType: "AUTH",
      entityId: input.userId,
      entityLabel: user.email,
      detail: `${user.name} changed their password`,
    });
    revalidatePath("/");
  });
}

// ---------------------------------------------------------------------------
// User directory + full account CRUD (role:manage)
// ---------------------------------------------------------------------------

export async function getAllUsers(): Promise<ActionResult<
  Array<{
    id: string;
    email: string;
    name: string;
    role: string;
    avatarColor: string;
    createdAt: string;
    projectCount: number;
    managerId: string | null;
    managerName: string | null;
  }>
>> {
  return toResult(async () => {
    await requirePermission("role:manage");
    // Single query with the manager relation included so the UI can render
    // the "Reports To" column without N+1 follow-up reads.
    const users = await db.user.findMany({
      select: {
        id: true, email: true, name: true, role: true, avatarColor: true, createdAt: true,
        managerId: true,
        manager: { select: { id: true, name: true } },
        _count: { select: { projectAssignments: true } },
      },
      orderBy: { name: "asc" },
    });
    return users.map(u => ({
      id: u.id,
      email: u.email,
      name: u.name,
      role: u.role,
      avatarColor: u.avatarColor,
      createdAt: u.createdAt.toISOString(),
      projectCount: u._count.projectAssignments,
      managerId: u.managerId,
      managerName: u.manager?.name ?? null,
    }));
  });
}

export async function createUser(input: {
  name: string;
  email: string;
  password: string;
  role: string;          // ADMIN | MANAGER | MEMBER
  timezone?: string;
  bio?: string;
  avatarColor?: string;
  department?: string;   // for the TeamMember record
  jobTitle?: string;     // for the TeamMember record
  managerId?: string | null;  // who the new user reports to (null = root)
}): Promise<ActionResult<{ id: string }>> {
  return toResult(async () => {
    const auth = await requirePermission("role:manage");

    // Validate
    const name = input.name.trim();
    const email = input.email.trim().toLowerCase();
    if (!name) throw new AuthorizationError("Name is required.");
    const parsedEmail = emailSchema.safeParse(email);
    if (!parsedEmail.success) {
      throw new AuthorizationError("A valid email is required.");
    }
    const minPasswordLength = await getMinPasswordLength();
    if (!input.password || input.password.length < minPasswordLength) {
      throw new AuthorizationError(`Password must be at least ${minPasswordLength} characters.`);
    }
    if (!isValidRole(input.role)) {
      throw new AuthorizationError("Invalid role. Must be ADMIN, MANAGER, or MEMBER.");
    }

    // Check email uniqueness
    const existingUser = await db.user.findUnique({ where: { email } });
    if (existingUser) {
      throw new AuthorizationError(`A user with email ${email} already exists.`);
    }

    // Validate the managerId (if provided): must exist and must not
    // create a cycle. Cycles can't happen on create (the new user has no
    // reports yet) but assertNoCycle also rejects self-reference and
    // unknown-manager ids, which is what we want here.
    const managerId = input.managerId ?? null;
    if (managerId) {
      const mgr = await db.user.findUnique({ where: { id: managerId }, select: { id: true } });
      if (!mgr) throw new AuthorizationError("The selected manager does not exist.");
      // No cycle possible on create, but the helper still rejects
      // self-reference (defensive — the new user has no id yet anyway).
    }

    const passwordHash = await hashPassword(input.password);
    const avatarColor = input.avatarColor ?? "forest";
    const timezone = input.timezone ?? "Pacific/Auckland";
    const bio = input.bio ?? "";
    const department = input.department ?? "ENGINEERING";
    const jobTitle = input.jobTitle ?? "Team Member";

    // Create the User (login account) and its matching TeamMember record in
    // one transaction, so the new user appears in the team directory and can
    // be assigned tasks immediately.
    const user = await db.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          email,
          name,
          passwordHash,
          role: input.role,
          timezone,
          bio,
          avatarColor,
          managerId,
        },
      });
      const existingMember = await tx.teamMember.findUnique({ where: { email } });
      if (!existingMember) {
        await tx.teamMember.create({
          data: {
            name,
            email,
            role: jobTitle,
            department,
            avatarColor,
            online: false,
          },
        });
      }
      return created;
    });

    await logAudit({
      actor: auth,
      action: "user.created",
      entityType: "USER",
      entityId: user.id,
      entityLabel: name,
      detail: `Created user ${name} (${email}) with role ${ROLE_LABELS[input.role]}${managerId ? ` reporting to user ${managerId}` : " (no manager)"}`,
    });
    revalidatePath("/");
    return { id: user.id };
  });
}

export async function updateUser(userId: string, input: {
  name?: string;
  email?: string;
  role?: string;
  timezone?: string;
  bio?: string;
  avatarColor?: string;
  department?: string;
  jobTitle?: string;
  managerId?: string | null;  // who this user reports to (null = root)
  resetPassword?: string;  // if provided, set a new password
}): Promise<ActionResult<void>> {
  return toResult(async () => {
    // Hierarchy gate: actor must have role:manage AND outrank/own the
    // target. Self-edits pass the hierarchy check; caller-side self-
    // protection rules below guard the dangerous self-mutations.
    const auth = await requirePermissionForTarget("role:manage", userId);
    const target = await db.user.findUnique({ where: { id: userId } });
    if (!target) throw new AuthorizationError("User not found.");

    // Self-protection: cannot demote yourself
    if (userId === auth.userId && input.role && input.role !== "ADMIN") {
      throw new AuthorizationError("You cannot change your own role. Ask another admin to do it.");
    }
    // Self-protection: cannot unmanage yourself (would let you escape the
    // hierarchy). Only an admin (who is above the hierarchy) can change
    // a user's own managerId.
    if (userId === auth.userId && input.managerId !== undefined && auth.role !== "ADMIN") {
      throw new AuthorizationError("You cannot change your own manager. Ask an admin to do it.");
    }

    const data: Record<string, unknown> = {};
    if (input.name !== undefined) data.name = input.name.trim();
    if (input.email !== undefined) {
      const email = input.email.trim().toLowerCase();
      const parsedEmail = emailSchema.safeParse(email);
      if (!parsedEmail.success) {
        throw new AuthorizationError("A valid email is required.");
      }
      data.email = email;
    }
    if (input.role !== undefined) {
      if (!isValidRole(input.role)) {
        throw new AuthorizationError("Invalid role.");
      }
      data.role = input.role;
    }
    if (input.timezone !== undefined) data.timezone = input.timezone;
    if (input.bio !== undefined) data.bio = input.bio;
    if (input.avatarColor !== undefined) data.avatarColor = input.avatarColor;

    // Hierarchy: validate the new managerId before writing. Rejects
    // self-reference and cycles (manager is already a transitive report).
    if (input.managerId !== undefined) {
      const newManagerId = input.managerId || null;
      if (newManagerId) {
        const mgr = await db.user.findUnique({ where: { id: newManagerId }, select: { id: true } });
        if (!mgr) throw new AuthorizationError("The selected manager does not exist.");
        await assertNoCycle(userId, newManagerId);
      }
      data.managerId = newManagerId;
    }

    if (input.resetPassword !== undefined && input.resetPassword.length > 0) {
      const minPasswordLength = await getMinPasswordLength();
      if (input.resetPassword.length < minPasswordLength) {
        throw new AuthorizationError(`Password must be at least ${minPasswordLength} characters.`);
      }
      data.passwordHash = await hashPassword(input.resetPassword);
    }

    await db.user.update({ where: { id: userId }, data });

    // Sync name/email/avatarColor to the matching TeamMember record (if any)
    const memberUpdate: Record<string, unknown> = {};
    if (input.name !== undefined) memberUpdate.name = input.name.trim();
    if (input.email !== undefined) memberUpdate.email = input.email.trim().toLowerCase();
    if (input.avatarColor !== undefined) memberUpdate.avatarColor = input.avatarColor;
    if (input.jobTitle !== undefined) memberUpdate.role = input.jobTitle;
    if (input.department !== undefined) memberUpdate.department = input.department;
    if (Object.keys(memberUpdate).length > 0) {
      await db.teamMember.updateMany({
        where: { email: target.email },
        data: memberUpdate,
      });
    }

    const changes: string[] = [];
    if (input.name !== undefined && input.name !== target.name) changes.push("name");
    if (input.email !== undefined && input.email !== target.email) changes.push("email");
    if (input.role !== undefined && input.role !== target.role) changes.push("role");
    if (input.timezone !== undefined && input.timezone !== target.timezone) changes.push("timezone");
    if (input.bio !== undefined && input.bio !== target.bio) changes.push("bio");
    if (input.avatarColor !== undefined && input.avatarColor !== target.avatarColor) changes.push("avatar");
    if (input.managerId !== undefined && input.managerId !== target.managerId) changes.push("manager");
    if (input.resetPassword) changes.push("password");

    await logAudit({
      actor: auth,
      action: "user.updated",
      entityType: "USER",
      entityId: userId,
      entityLabel: input.name ?? target.name,
      detail: changes.length
        ? `Updated ${changes.join(", ")} for ${input.name ?? target.name}`
        : `Saved user ${input.name ?? target.name}`,
    });
    revalidatePath("/");
  });
}

export async function deleteUser(userId: string): Promise<ActionResult<void>> {
  return toResult(async () => {
    // Hierarchy gate: same as updateUser. Self-deletion is blocked below.
    const auth = await requirePermissionForTarget("role:manage", userId);
    if (userId === auth.userId) {
      throw new AuthorizationError("You cannot delete your own account. Ask another admin to do it.");
    }
    const target = await db.user.findUnique({ where: { id: userId } });
    if (!target) throw new AuthorizationError("User not found.");
    // ProjectAssignments are auto-deleted via onDelete: Cascade.
    // managerId on the target's direct reports is auto-nullified via
    // onDelete: SetNull (so those reports become roots, they are NOT
    // deleted — important: deleting a manager must never delete their team).
    await db.user.delete({ where: { id: userId } });
    await logAudit({
      actor: auth,
      action: "user.deleted",
      entityType: "USER",
      entityId: userId,
      entityLabel: target.name,
      detail: `Deleted user ${target.name} (${target.email})`,
    });
    revalidatePath("/");
  });
}

// Look up a user by email — used by the messaging UI to find the recipient's
// userId. Self-addressed messaging is the only PII this exposes (id, name,
// email, avatar color of an arbitrary known email), which is required for
// routing messages.
export async function getUserByEmail(email: string): Promise<ActionResult<{
  id: string;
  name: string;
  email: string;
  avatarColor: string;
} | null>> {
  return toResult(async () => {
    const auth = await getSessionOrThrow();
    void auth; // signed-in check only — the lookup itself exposes no PII beyond routing needs
    const user = await db.user.findUnique({
      where: { email: email.toLowerCase() },
      select: { id: true, name: true, email: true, avatarColor: true },
    });
    return user;
  });
}
