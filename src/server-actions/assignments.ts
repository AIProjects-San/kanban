"use server";

// Project assignments (role:manage) — which users are staffed on which
// projects. Includes the read helpers used by the assignment modal.

import { revalidatePath } from "next/cache";
import { db } from "@/lib/infra/db";
import { requirePermission, AuthorizationError, getSessionOrThrow } from "./auth-guard";
import { getScopedProjectIds, logAudit } from "./shared";
import { toResult } from "./result";
import type { ActionResult } from "@/lib/shared/action-result";

export async function assignUserToProject(
  userId: string,
  projectId: string,
  role: string = "MEMBER",
): Promise<ActionResult<void>> {
  return toResult(async () => {
    const auth = await requirePermission("role:manage");
    // PR-23 — exclude soft-deleted users: a trashed account must not be
    // (re-)staffed onto a project while it sits in the trash.
    const user = await db.user.findUnique({ where: { id: userId, deletedAt: null } });
    if (!user) throw new AuthorizationError("User not found.");
    const project = await db.project.findUnique({ where: { id: projectId }, select: { id: true, name: true, deletedAt: true } });
    if (!project || project.deletedAt) throw new AuthorizationError("Project not found.");
    // upsert so calling twice is idempotent
    await db.projectAssignment.upsert({
      where: { projectId_userId: { projectId, userId } },
      create: { projectId, userId, role },
      update: { role },
    });
    await logAudit({
      actor: auth,
      action: "project.assigned",
      entityType: "PROJECT",
      entityId: projectId,
      entityLabel: project.name,
      detail: `Assigned ${user.name} to project “${project.name}” as ${role.toLowerCase()}`,
    });
    revalidatePath("/");
  });
}

export async function unassignUserFromProject(userId: string, projectId: string): Promise<ActionResult<void>> {
  return toResult(async () => {
    const auth = await requirePermission("role:manage");
    // PR-23 — soft-deleted users can be unassigned (cleanup) but the audit
    // log still needs a name; the lookup itself is informational.
    const user = await db.user.findUnique({ where: { id: userId }, select: { id: true, name: true } });
    const project = await db.project.findUnique({ where: { id: projectId }, select: { id: true, name: true } });
    await db.projectAssignment.deleteMany({
      where: { projectId, userId },
    });
    if (user && project) {
      await logAudit({
        actor: auth,
        action: "project.unassigned",
        entityType: "PROJECT",
        entityId: projectId,
        entityLabel: project.name,
        detail: `Unassigned ${user.name} from project “${project.name}”`,
      });
    }
    revalidatePath("/");
  });
}

export async function getUserProjectAssignments(userId: string): Promise<ActionResult<
  Array<{
    id: string;
    projectId: string;
    userId: string;
    role: string;
    project: { id: string; name: string; color: string; status: string };
  }>
>> {
  return toResult(async () => {
    await requirePermission("role:manage");
    const assignments = await db.projectAssignment.findMany({
      where: { userId },
      include: { project: true },
      orderBy: { createdAt: "asc" },
      // PR-21 — hard cap.
      take: 500,
    });
    return assignments.map((a) => ({
      id: a.id,
      projectId: a.projectId,
      userId: a.userId,
      role: a.role,
      project: {
        id: a.project.id,
        name: a.project.name,
        color: a.project.color,
        status: a.project.status,
      },
    }));
  });
}

export async function getProjectAssignments(projectId: string): Promise<ActionResult<
  Array<{
    id: string;
    projectId: string;
    userId: string;
    role: string;
    user: { id: string; name: string; email: string; role: string; avatarColor: string };
  }>
>> {
  return toResult(async () => {
    const auth = await getSessionOrThrow();
    // PR-54 — scope gate (mirrors getProjectMembers in dashboard.ts).
    // Without this, any signed-in MEMBER could pass an arbitrary projectId
    // and receive that project's full staff roster (including emails +
    // roles) — data the dashboard's memberWhere rule deliberately hides.
    // ADMIN is unscoped (sees every project's staff, as on the dashboard).
    const scopedIds = await getScopedProjectIds(auth);
    if (scopedIds && !scopedIds.has(projectId)) return [];
    const assignments = await db.projectAssignment.findMany({
      where: { projectId },
      include: { user: true },
      orderBy: { createdAt: "asc" },
      // PR-21 — hard cap.
      take: 500,
    });
    return assignments.map((a) => ({
      id: a.id,
      projectId: a.projectId,
      userId: a.userId,
      role: a.role,
      user: {
        id: a.user.id,
        name: a.user.name,
        email: a.user.email,
        role: a.user.role,
        avatarColor: a.user.avatarColor,
      },
    }));
  });
}

// ---------------------------------------------------------------------------
// Project association rule — users assignable to work in a project.
//
// Returns the users the server will accept as ASSIGNEES for bugs in this
// project (assertUserAssociatedWithProject applies the same rule at write
// time): explicitly staffed users (ProjectAssignment) plus the project
// owner. Used by the bug detail drawer's assign panel so it can only offer
// people the server would accept. Soft-deleted users are excluded.
// ---------------------------------------------------------------------------

export async function getProjectAssignableUsers(projectId: string): Promise<ActionResult<
  Array<{
    id: string;
    name: string;
    email: string;
    role: string;
    avatarColor: string;
    isOwner: boolean;
  }>
>> {
  return toResult(async () => {
    const auth = await getSessionOrThrow();

    const project = await db.project.findUnique({
      where: { id: projectId },
      select: { ownerUserId: true, deletedAt: true },
    });
    if (!project || project.deletedAt) return [];
    // PR-54 — scope gate (same as getProjectAssignments above +
    // getProjectMembers in dashboard.ts). Without this, a MEMBER opening
    // the bug-detail assign panel on a bug whose project they can't see
    // would receive that project's full staff list with emails.
    const scopedIds = await getScopedProjectIds(auth);
    if (scopedIds && !scopedIds.has(projectId)) return [];

    const assignments = await db.projectAssignment.findMany({
      where: { projectId, user: { deletedAt: null } },
      include: { user: true },
      orderBy: { createdAt: "asc" },
      // PR-21 — hard cap.
      take: 500,
    });

    const merged = new Map<
      string,
      { id: string; name: string; email: string; role: string; avatarColor: string; isOwner: boolean }
    >();
    for (const a of assignments) {
      merged.set(a.user.id, {
        id: a.user.id,
        name: a.user.name,
        email: a.user.email,
        role: a.user.role,
        avatarColor: a.user.avatarColor,
        isOwner: a.user.id === project.ownerUserId,
      });
    }
    // The owner is associated even without an explicit assignment row.
    if (project.ownerUserId && !merged.has(project.ownerUserId)) {
      const owner = await db.user.findUnique({
        where: { id: project.ownerUserId, deletedAt: null },
      });
      if (owner) {
        merged.set(owner.id, {
          id: owner.id,
          name: owner.name,
          email: owner.email,
          role: owner.role,
          avatarColor: owner.avatarColor,
          isOwner: true,
        });
      }
    }
    return Array.from(merged.values());
  });
}
