"use server";

// Project CRUD.

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requirePermission } from "./auth-guard";
import { createProjectSchema, parseOrThrow, validationError } from "@/lib/validation";
import { logAudit } from "./shared";
import { toResult } from "./result";
import type { ActionResult } from "@/lib/action-result";

export async function createProject(input: {
  name: string;
  description?: string;
  status?: string;
  priority?: string;
  dueDate?: string | null;
  color?: string;
  /** TeamMember id of the owner — resolved to a stable user id server-side. */
  ownerMemberId?: string;
}): Promise<ActionResult<void>> {
  return toResult(async () => {
    const auth = await requirePermission("project:create");
    const data = parseOrThrow(createProjectSchema, input);
    // The owner is chosen from the team roster; the client sends the member's
    // id, and the server derives both the stable ownerUserId and the display
    // name. A client-supplied free-text name is never trusted here.
    let ownerUserId: string | null = null;
    let ownerName = "";
    if (data.ownerMemberId) {
      const owner = await db.teamMember.findUnique({
        where: { id: data.ownerMemberId },
        select: { name: true, userId: true },
      });
      if (!owner) throw validationError("Selected owner is not a team member.");
      ownerName = owner.name;
      ownerUserId = owner.userId;
    }
    const project = await db.project.create({
      data: {
        name: data.name,
        description: data.description ?? "",
        status: data.status ?? "RUNNING",
        priority: data.priority ?? "MEDIUM",
        dueDate: data.dueDate ? new Date(data.dueDate) : null,
        color: data.color ?? "forest",
        ownerName,
        ownerUserId,
      },
    });
    await logAudit({
      actor: auth,
      action: "project.created",
      entityType: "PROJECT",
      entityId: project.id,
      entityLabel: project.name,
      detail: `Created project “${project.name}”`,
    });
    revalidatePath("/");
  });
}

export async function updateProject(id: string, input: Partial<{
  name: string;
  description: string;
  status: string;
  priority: string;
  dueDate: string | null;
  color: string;
  /** TeamMember id of the new owner — resolved server-side. */
  ownerMemberId: string;
  progress: number;
}>): Promise<ActionResult<void>> {
  return toResult(async () => {
    const auth = await requirePermission("project:edit");
    const existing = await db.project.findUnique({ where: { id } });
    // Owner reassignment: client sends the owner's TeamMember id; the server
    // resolves the stable user id + display name.
    let ownerUserId: string | null | undefined;
    let ownerName: string | undefined;
    if (input.ownerMemberId !== undefined) {
      if (input.ownerMemberId === "") {
        ownerUserId = null;
        ownerName = "";
      } else {
        const owner = await db.teamMember.findUnique({
          where: { id: input.ownerMemberId },
          select: { name: true, userId: true },
        });
        if (!owner) throw validationError("Selected owner is not a team member.");
        ownerName = owner.name;
        ownerUserId = owner.userId;
      }
    }
    await db.project.update({
      where: { id },
      data: {
        name: input.name,
        description: input.description,
        status: input.status,
        priority: input.priority,
        dueDate: input.dueDate !== undefined ? (input.dueDate ? new Date(input.dueDate) : null) : undefined,
        color: input.color,
        ownerName,
        ownerUserId,
        progress: input.progress,
      },
    });
    if (existing) {
      const changes: string[] = [];
      if (input.name !== undefined && input.name !== existing.name) changes.push("name");
      if (input.description !== undefined && input.description !== existing.description) changes.push("description");
      if (input.status !== undefined && input.status !== existing.status) changes.push("status");
      if (input.priority !== undefined && input.priority !== existing.priority) changes.push("priority");
      if (input.color !== undefined && input.color !== existing.color) changes.push("color");
      if (ownerName !== undefined && ownerName !== existing.ownerName) changes.push("owner");
      if (input.progress !== undefined && input.progress !== existing.progress) changes.push("progress");
      if (input.dueDate !== undefined) {
        const nd = input.dueDate ? new Date(input.dueDate).toISOString() : null;
        const od = existing.dueDate ? existing.dueDate.toISOString() : null;
        if (nd !== od) changes.push("due date");
      }
      await logAudit({
        actor: auth,
        action: "project.updated",
        entityType: "PROJECT",
        entityId: id,
        entityLabel: input.name ?? existing.name,
        detail: changes.length
          ? `Updated ${changes.join(", ")} on project “${input.name ?? existing.name}”`
          : `Saved project “${input.name ?? existing.name}”`,
      });
    }
    revalidatePath("/");
  });
}

export async function deleteProject(id: string): Promise<ActionResult<void>> {
  return toResult(async () => {
    const auth = await requirePermission("project:delete");
    const existing = await db.project.findUnique({ where: { id } });
    // L-P0-14 — soft-delete instead of hard delete. Setting `deletedAt` hides
    // the project from read paths (which filter `deletedAt: null`) WITHOUT
    // nulling Task.projectId, so tasks keep their project reference and don't
    // become orphans on the board.
    await db.project.update({ where: { id }, data: { deletedAt: new Date() } });
    if (existing) {
      await logAudit({
        actor: auth,
        action: "project.deleted",
        entityType: "PROJECT",
        entityId: id,
        entityLabel: existing.name,
        detail: `Soft-deleted project “${existing.name}” (tasks preserved, hidden from board)`,
      });
    }
    revalidatePath("/");
  });
}
