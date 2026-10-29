"use server";

// Project assignments (role:manage) — which users are staffed on which
// projects. Includes the read helpers used by the assignment modal.

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requirePermission, getSession, AuthorizationError } from "./auth-guard";
import { logAudit } from "./shared";
import { toResult } from "./result";
import type { ActionResult } from "@/lib/action-result";

export async function assignUserToProject(
  userId: string,
  projectId: string,
  role: string = "MEMBER",
): Promise<ActionResult<void>> {
  return toResult(async () => {
    const auth = await requirePermission("role:manage");
    const user = await db.user.findUnique({ where: { id: userId } });
    if (!user) throw new AuthorizationError("User not found.");
    const project = await db.project.findUnique({ where: { id: projectId } });
    if (!project) throw new AuthorizationError("Project not found.");
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
    const user = await db.user.findUnique({ where: { id: userId } });
    const project = await db.project.findUnique({ where: { id: projectId } });
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
    const auth = await getSession();
    if (!auth) throw new AuthorizationError("You must be signed in.");
    const assignments = await db.projectAssignment.findMany({
      where: { projectId },
      include: { user: true },
      orderBy: { createdAt: "asc" },
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
