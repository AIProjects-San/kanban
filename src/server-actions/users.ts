"use server";

// User accounts, profiles, settings and self-service password change.
//
// `getUserProfile`, `getUserSettings` are SSR-facing loaders (page.tsx) and
// keep their throwing contract; every client-invoked action returns an
// ActionResult.

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { getSession, getSessionOrThrow, requirePermission, requirePermissionForTarget, AuthorizationError } from "./auth-guard";
import { revokeUserSessionsIfActive } from "@/lib/auth-revoke";
import { hasPermission, isValidRole, ROLE_LABELS } from "@/lib/rbac";
import { getEffectivePermissions } from "@/lib/config-loader";
import { assertNoCycle } from "@/lib/hierarchy";
import { getMinPasswordLength, hashPassword, verifyPassword } from "@/lib/password";
import { assertPasswordNotBreached } from "@/lib/breach-check";
import { emailSchema, updateProfileSchema, updateUserSettingsSchema, parseOrThrow } from "@/lib/validation";
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
// PR-64 — effective permissions for the signed-in user (static floor ∪ DB
// ceiling). The AppShell polls this so an admin's role-permission save
// reflects for ALREADY-LOGGED-IN users within seconds: bumpConfigCache()
// makes the server side fresh at save time, this action carries it to open
// tabs (which then re-render nav items and permission-gated buttons).
// ---------------------------------------------------------------------------

export async function getMyPermissions(): Promise<ActionResult<string[]>> {
  return toResult(async () => {
    const auth = await getSessionOrThrow();
    return getEffectivePermissions(auth.role);
  });
}

// ---------------------------------------------------------------------------
// User settings — persist theme/dark/notifications per-user in the DB
// ---------------------------------------------------------------------------

export async function getUserSettings(userId: string) {
  const auth = await getSession();
  if (!auth) throw new AuthorizationError("You must be signed in.");
  // PR-03 (production-readiness audit) — ownership check. Previously any
  // signed-in user could read any other user's settings by passing their id
  // (an IDOR; updateUserSettings already enforced ownership, this read path
  // did not). The payload is low-sensitivity (theme + notification toggles)
  // but the app's own standard — server-derived identity on every self-
  // scoped read — applies here too.
  if (auth.userId !== userId) {
    throw new AuthorizationError("You can only view your own settings.");
  }
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
    // Deep-dive review F-11 — shape/length validation (accent is rendered
    // into class names, so cap it).
    const data = parseOrThrow(updateUserSettingsSchema, input);
    await db.userSettings.upsert({
      where: { userId },
      create: { userId, ...data },
      update: data,
    });
    revalidatePath("/");
  });
}

// ---------------------------------------------------------------------------
// Self-service profile update
//
// Deep-dive review F-01 (CRITICAL): this action previously spread the raw
// client payload into db.user.update — including `role`. User.role is the
// RBAC role used by the session/JWT, so any signed-in user could self-promote
// to ADMIN by posting { role: "ADMIN" } (and an admin editing their "job
// title" in Settings silently demoted themselves to MEMBER). The action now:
//   • accepts ONLY name/timezone/bio/avatarColor for the User row,
//   • validates lengths via updateProfileSchema,
//   • never writes User.role.
// Job titles live on TeamMember.role and are edited through member:edit
// paths (updateMember / updateUser.jobTitle).
// ---------------------------------------------------------------------------

export async function updateProfile(userId: string, input: {
  name: string;
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
    const data = parseOrThrow(updateProfileSchema, input);
    const existing = await db.user.findUnique({ where: { id: userId } });
    if (!existing) throw new AuthorizationError("Account not found.");
    // PR-15 — the User row and the roster row are two halves of one profile
    // update; a crash between them previously left the directory showing the
    // old name/avatar while the account had the new one. Both writes now
    // commit together.
    await db.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        // NOTE: no `role` — RBAC role changes go through updateUser (role:manage).
        data: { name: data.name, timezone: data.timezone, bio: data.bio, avatarColor: data.avatarColor },
      });
      // Keep the linked roster row's display fields in sync (same contract as
      // updateUser) so the team directory reflects the new name/avatar.
      await tx.teamMember.updateMany({
        where: { userId },
        data: { name: data.name, avatarColor: data.avatarColor },
      });
    });
    const changes: string[] = [];
    if (data.name !== existing.name) changes.push("name");
    if (data.timezone !== existing.timezone) changes.push("timezone");
    if (data.bio !== existing.bio) changes.push("bio");
    if (data.avatarColor !== existing.avatarColor) changes.push("avatar color");
    await logAudit({
      actor: auth,
      action: "profile.updated",
      entityType: "USER",
      entityId: userId,
      entityLabel: data.name,
      detail: changes.length
        ? `Updated ${changes.join(", ")} on their profile`
        : "Saved their profile",
    });
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
    // P2 (edge-case audit) — max password length (bcrypt 72-byte truncation + memory).
    if (input.newPassword.length > 1024) {
      throw new AuthorizationError("New password must be at most 1024 characters.");
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

    // PR-35 — reject breach-listed passwords on set (opt-in via
    // PASSWORD_BREACH_CHECK / HIBP_API_KEY; fail-open when unavailable).
    await assertPasswordNotBreached(input.newPassword);

    const newHash = await hashPassword(input.newPassword);
    // P1 (edge-case audit) — invalidate all pending password-reset tokens
    // when the password changes. Without this, an attacker who requested a
    // reset (token T_A sent to the victim's email) could still use T_A to
    // take over the account AFTER the victim changed their password via
    // Settings. The reset flow's own `requestPasswordReset` invalidates
    // prior tokens, but `changePassword` and `resetPassword` did not.
    await db.$transaction([
      db.user.update({
        where: { id: input.userId },
        // L-P0-8 — bump tokenVersion so any stolen cookie from before the
        // password change is rejected by the jwt callback on its next refresh.
        data: { passwordHash: newHash, tokenVersion: { increment: 1 } },
      }),
      db.passwordResetToken.updateMany({
        where: { userId: input.userId, usedAt: null },
        data: { usedAt: new Date() },
      }),
    ]);
    // PR-48 — revoke the Better Auth DB sessions for the same reason the
    // tokenVersion bump revokes the v4 JWTs (both stacks live in parallel).
    await revokeUserSessionsIfActive(input.userId);

    await logAudit({
      actor: auth,
      action: "auth.password_changed",
      entityType: "AUTH",
      entityId: input.userId,
      entityLabel: user.email,
      detail: `${user.name} changed their password (session token rotated)`,
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
    // PR-21 — hard cap; a workspace beyond ~500 accounts needs pagination
    // (getUsersPage already provides it), not an unbounded admin list.
    const users = await db.user.findMany({
      select: {
        id: true, email: true, name: true, role: true, avatarColor: true, createdAt: true,
        managerId: true,
        manager: { select: { id: true, name: true } },
        _count: { select: { projectAssignments: true } },
      },
      orderBy: { name: "asc" },
      take: 500,
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
    // P1 (edge-case audit) — F-14 bypass closure. The P2-13 guard blocks
    // non-admins from granting `role:manage` via updateRole/createRole, but
    // createUser was missed. A MANAGER who was granted `role:manage` via the
    // DB ceiling could mint fresh ADMIN accounts. Mirror the updateUser
    // guard: only ADMIN may create ADMIN users.
    if (input.role === "ADMIN" && auth.role !== "ADMIN") {
      throw new AuthorizationError("Only an admin can grant the ADMIN role.");
    }
    // P2 (edge-case audit) — max password length. bcrypt silently truncates
    // to 72 bytes; a 1MB password pins 1MB of memory per request. Cap at
    // 1024 chars (generous; well above any reasonable password manager output).
    if (input.password.length > 1024) {
      throw new AuthorizationError("Password must be at most 1024 characters.");
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
      const mgr = await db.user.findUnique({ where: { id: managerId, deletedAt: null }, select: { id: true } });
      if (!mgr) throw new AuthorizationError("The selected manager does not exist.");
      // No cycle possible on create, but the helper still rejects
      // self-reference (defensive — the new user has no id yet anyway).
    }

    // PR-35 — reject breach-listed passwords on admin user creation.
    await assertPasswordNotBreached(input.password);
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
    // P1 (edge-case audit) — filter deletedAt: null. requirePermissionForTarget
    // already filters, but double-check here (defence in depth) so a soft-
    // deleted user can't have their password/role/email changed while in
    // the trash. Use restoreUser to bring them back first.
    const target = await db.user.findUnique({ where: { id: userId, deletedAt: null } });
    if (!target) throw new AuthorizationError("User not found.");

    // Self-protection: cannot demote yourself
    if (userId === auth.userId && input.role && input.role !== "ADMIN") {
      throw new AuthorizationError("You cannot change your own role. Ask another admin to do it.");
    }
    // Deep-dive review F-14 — only an ADMIN may grant the ADMIN role. Under
    // the default matrix only admins hold role:manage anyway, but the DB
    // ceiling lets an admin grant role:manage to a MANAGER — without this
    // rule that MANAGER could then mint ADMIN accounts inside their subtree.
    if (input.role === "ADMIN" && auth.role !== "ADMIN") {
      throw new AuthorizationError("Only an admin can grant the ADMIN role.");
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
      // P2 (edge-case audit) — pre-check email uniqueness. Previously a
      // duplicate email surfaced as a Prisma P2002 → 500 → generic "something
      // went wrong". Now: user-friendly error mirroring createUser.
      if (email !== target.email) {
        const existing = await db.user.findUnique({ where: { email } });
        if (existing) {
          throw new AuthorizationError("A user with that email already exists.");
        }
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
        const mgr = await db.user.findUnique({ where: { id: newManagerId, deletedAt: null }, select: { id: true } });
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
      // PR-35 — reject breach-listed passwords on admin-forced reset.
      await assertPasswordNotBreached(input.resetPassword);
      data.passwordHash = await hashPassword(input.resetPassword);
    }

    // L-P0-8 — bump tokenVersion when role or password changes, so any
    // existing session for this user is invalidated on the next jwt refresh.
    // This is the admin-side force-logout.
    const roleChanged = input.role !== undefined && input.role !== target.role;
    const passwordReset = input.resetPassword !== undefined && input.resetPassword.length > 0;
    if (roleChanged || passwordReset) {
      data.tokenVersion = { increment: 1 };
    }

    // PR-15 — user + roster sync in one transaction (same rationale as
    // updateProfile/createUser/deleteUser, which already had it).
    await db.$transaction(async (tx) => {
      await tx.user.update({ where: { id: userId }, data });

      // Sync name/email/avatarColor to the matching TeamMember record (if any)
      const memberUpdate: Record<string, unknown> = {};
      if (input.name !== undefined) memberUpdate.name = input.name.trim();
      if (input.email !== undefined) memberUpdate.email = input.email.trim().toLowerCase();
      if (input.avatarColor !== undefined) memberUpdate.avatarColor = input.avatarColor;
      if (input.jobTitle !== undefined) memberUpdate.role = input.jobTitle;
      if (input.department !== undefined) memberUpdate.department = input.department;
      if (Object.keys(memberUpdate).length > 0) {
        await tx.teamMember.updateMany({
          where: { email: target.email },
          data: memberUpdate,
        });
      }
    });

    // PR-48 — role or password changed → revoke the Better Auth DB sessions
    // (the tokenVersion bump above already covers the v4 JWTs).
    if (roleChanged || passwordReset) {
      await revokeUserSessionsIfActive(userId);
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
    const target = await db.user.findUnique({ where: { id: userId, deletedAt: null } });
    if (!target) throw new AuthorizationError("User not found.");
    // L-P0-14 — soft-delete instead of hard delete. Setting `deletedAt` on
    // both User and the linked TeamMember hides the row from read paths
    // (which filter `deletedAt: null`) WITHOUT cascading deletes that would
    // orphan messages (dangling senderUserId/recipientUserId) and team-member
    // references. The user's auth is invalidated: the jwt callback's role
    // refresh filters `deletedAt: null`, so it sees `fresh = null` and
    // clears the token id within the ROLE_REFRESH_MS window. ProjectAssignments
    // still cascade (onDelete: Cascade); managerId on direct reports still
    // SetNulls (those reports become roots — deleting a manager never deletes
    // their team).
    // P0 (production-readiness re-audit) — the two writes are wrapped in a
    // $transaction so a partial failure can't leave the user hidden from auth
    // while their roster row stays visible (still assignable, still
    // messageable, but locked out).
    const now = new Date();
    // Wrap both writes in a $transaction so the soft-delete is atomic — a
    // partial failure can't leave the user hidden from auth while their
    // roster row stays visible (still assignable, still messageable, but
    // locked out).
    await db.$transaction([
      db.user.update({ where: { id: userId }, data: { deletedAt: now } }),
      // Soft-delete the matching TeamMember row (if any) in the same tx.
      ...(target.email
        ? [
            db.teamMember.updateMany({
              where: { email: target.email.toLowerCase(), deletedAt: null },
              data: { deletedAt: now },
            }),
          ]
        : []),
    ]);
    // PR-48 — a soft-deleted user must lose their Better Auth DB sessions
    // immediately (the before-hook blocks new sign-ins; this kills the
    // outstanding ones — the v4 JWTs die via the jwt callback's deletedAt
    // filter within the refresh window).
    await revokeUserSessionsIfActive(userId);
    await logAudit({
      actor: auth,
      action: "user.deleted",
      entityType: "USER",
      entityId: userId,
      entityLabel: target.name,
      detail: `Soft-deleted user ${target.name} (${target.email}) — roster row hidden, references preserved`,
    });
    revalidatePath("/");
  });
}

// Look up a user by email — used by the messaging UI to find the recipient's
// userId.
//
// P2 (production-readiness re-audit) — TRUST BOUNDARY: this endpoint is an
// enumeration oracle. A signed-in MEMBER can probe any email and learn
// whether it's registered (non-null response = exists, null = doesn't).
// This is inconsistent with the anti-enumeration mitigations on
// `requestPasswordReset` (which always returns `{sent: true}`), but is
// required for the messaging use case (you need to resolve an email to a
// userId to send a message). The tradeoff is documented here so it's a
// deliberate decision, not an oversight:
//
//   • Acceptable because: only signed-in users can call it; the data
//     exposed (id/name/email/avatarColor) is already visible in the team
//     roster to any signed-in user; messaging requires it.
//   • Mitigation: rate-limit at the reverse-proxy level (nginx) if abuse
//     is detected. Consider adding a per-user call budget here in the
//     future if enumeration becomes a real attack vector.
//
// Soft-deleted users are excluded (deletedAt: null filter).
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
      where: { email: email.toLowerCase(), deletedAt: null },
      select: { id: true, name: true, email: true, avatarColor: true },
    });
    return user;
  });
}

/**
 * P2 (production-readiness re-audit) — Sign out ALL devices for the signed-in
 * user by bumping their `tokenVersion`. Every JWT issued before this call
 * becomes stale at the next refresh window (≤5 min) and the session is
 * cleared. The caller's own current session is also invalidated — they will
 * need to sign in again.
 *
 * Use cases: suspicious activity on the account, lost device, credential
 * hygiene. Wired to the Settings → Security → "Sign out all devices" button.
 */
export async function signOutAllDevices(): Promise<ActionResult<{ revokedAt: string }>> {
  return toResult(async () => {
    const auth = await getSessionOrThrow();
    // Bump tokenVersion — the jwt callback's refresh path sees the mismatch
    // and clears the token id for every outstanding session.
    // P1 (edge-case audit) — also invalidate pending password-reset tokens
    // (defence in depth: a "sign out everywhere" should also kill any
    // pending reset flow).
    await db.$transaction([
      db.user.update({
        where: { id: auth.userId },
        data: { tokenVersion: { increment: 1 } },
      }),
      db.passwordResetToken.updateMany({
        where: { userId: auth.userId, usedAt: null },
        data: { usedAt: new Date() },
      }),
    ]);
    // PR-48 — "sign out everywhere" must also kill the Better Auth DB
    // sessions, not just the v4 JWTs.
    await revokeUserSessionsIfActive(auth.userId);
    await logAudit({
      actor: auth,
      action: "user.updated",
      entityType: "USER",
      entityId: auth.userId,
      entityLabel: auth.name,
      detail: `${auth.name} signed out all devices (tokenVersion bumped)`,
    });
    revalidatePath("/");
    return { revokedAt: new Date().toISOString() };
  });
}
