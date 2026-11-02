"use server";

// Team member CRUD (the roster — distinct from User accounts).

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requirePermission } from "./auth-guard";
import { createMemberSchema, updateMemberSchema, parseOrThrow } from "@/lib/validation";
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
    // P2 (edge-case audit) — filter deletedAt: null. A soft-deleted User
    // with the same email should not be auto-linked to a new TeamMember
    // (the link would point at a dead account; tasks assigned to this
    // member become invisible via the assignee.userId path).
    const linkedUser = await db.user.findUnique({
      where: { email: data.email.toLowerCase(), deletedAt: null },
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

export async function updateMember(id: string, raw: Partial<{
  name: string;
  role: string;
  department: string;
  email: string;
  avatarColor: string;
  online: boolean;
}>): Promise<ActionResult<void>> {
  return toResult(async () => {
    const auth = await requirePermission("member:edit");
    // Deep-dive review F-11 — the create path is schema-validated but the
    // update path previously wrote the raw payload (no email format check,
    // no case normalisation, no length caps). The email column is a linkage
    // key (roster ↔ account), so normalise exactly like createMember does.
    const input = parseOrThrow(updateMemberSchema, raw);
    const existing = await db.teamMember.findUnique({ where: { id } });
    // Deep-dive review F-15 — not-found is a clean no-op, not a P2025.
    if (!existing) return;
    await db.teamMember.update({ where: { id }, data: input });
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
    revalidatePath("/");
  });
}

export async function deleteMember(id: string): Promise<ActionResult<void>> {
  return toResult(async () => {
    const auth = await requirePermission("member:delete");
    const existing = await db.teamMember.findUnique({ where: { id } });
    // Deep-dive review F-15 — not-found is a clean no-op, not a P2025.
    if (!existing) return;
    await db.teamMember.delete({ where: { id } });
    await logAudit({
      actor: auth,
      action: "member.removed",
      entityType: "MEMBER",
      entityId: id,
      entityLabel: existing.name,
      detail: `Removed ${existing.name} (${existing.role}) from the team`,
    });
    revalidatePath("/");
  });
}
