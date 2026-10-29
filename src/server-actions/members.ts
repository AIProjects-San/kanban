"use server";

// Team member CRUD (the roster — distinct from User accounts).

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requirePermission } from "./auth-guard";
import { createMemberSchema, parseOrThrow } from "@/lib/validation";
import { logAudit } from "./shared";
import { toResult } from "./result";
import type { ActionResult } from "@/lib/action-result";

export async function createMember(input: {
  name: string;
  role: string;
  department: string;
  email: string;
  avatarColor?: string;
  online?: boolean;
}): Promise<ActionResult<void>> {
  return toResult(async () => {
    const auth = await requirePermission("member:invite");
    const data = parseOrThrow(createMemberSchema, input);
    // Auto-link the roster entry to an existing user account with the same
    // email, so scoped queries work for invited teammates immediately. The
    // unique constraint makes this safe even under a race (worst case the
    // insert fails and is retried without the link).
    const linkedUser = await db.user.findUnique({
      where: { email: data.email.toLowerCase() },
      select: { id: true },
    });
    const member = await db.teamMember.create({
      data: {
        name: data.name,
        role: data.role,
        department: data.department,
        email: data.email,
        avatarColor: data.avatarColor ?? "forest",
        online: data.online ?? false,
        userId: linkedUser?.id ?? null,
      },
    });
    await logAudit({
      actor: auth,
      action: "member.invited",
      entityType: "MEMBER",
      entityId: member.id,
      entityLabel: member.name,
      detail: `Invited ${member.name} (${member.role}) to the team`,
    });
    revalidatePath("/");
  });
}

export async function updateMember(id: string, input: Partial<{
  name: string;
  role: string;
  department: string;
  email: string;
  avatarColor: string;
  online: boolean;
}>): Promise<ActionResult<void>> {
  return toResult(async () => {
    const auth = await requirePermission("member:edit");
    const existing = await db.teamMember.findUnique({ where: { id } });
    await db.teamMember.update({ where: { id }, data: input });
    if (existing) {
      const changes: string[] = [];
      if (input.name !== undefined && input.name !== existing.name) changes.push("name");
      if (input.role !== undefined && input.role !== existing.role) changes.push("job title");
      if (input.department !== undefined && input.department !== existing.department) changes.push("department");
      if (input.email !== undefined && input.email !== existing.email) changes.push("email");
      if (input.online !== undefined && input.online !== existing.online) changes.push("availability");
      await logAudit({
        actor: auth,
        action: "member.updated",
        entityType: "MEMBER",
        entityId: id,
        entityLabel: input.name ?? existing.name,
        detail: changes.length
          ? `Updated ${changes.join(", ")} for ${input.name ?? existing.name}`
          : `Saved profile of ${input.name ?? existing.name}`,
      });
    }
    revalidatePath("/");
  });
}

export async function deleteMember(id: string): Promise<ActionResult<void>> {
  return toResult(async () => {
    const auth = await requirePermission("member:delete");
    const existing = await db.teamMember.findUnique({ where: { id } });
    await db.teamMember.delete({ where: { id } });
    if (existing) {
      await logAudit({
        actor: auth,
        action: "member.removed",
        entityType: "MEMBER",
        entityId: id,
        entityLabel: existing.name,
        detail: `Removed ${existing.name} (${existing.role}) from the team`,
      });
    }
    revalidatePath("/");
  });
}
