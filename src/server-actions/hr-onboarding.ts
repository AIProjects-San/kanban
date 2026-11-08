"use server";

// ---------------------------------------------------------------------------
// HR Module feature 4 — onboarding server actions
// (docs/HR_MODULE_PLAN.md §7).
//
// F2.1 — the same machinery carries SEPARATION checklists (benchmark
// EM-14): createChecklist takes a kind, ONBOARDING keeps the new-hire
// template, SEPARATION instantiates the exit template; tasks, tick
// permissions, auto-completion and manager auto-assignment are ONE code
// path. The Offboarding tab owns SEPARATION rows (getOnboarding returns
// both kinds serialized; the tabs filter client-side).
//
// RBAC:
//   onboarding:manage — create checklists, add tasks, see all of them
//                     (Admin, HR)
//   (task ticking)   — the task's ASSIGNEE, the new hire themself, or an
//                     ADMIN/HR user: the people actually doing the work.
//
// The checklist auto-completes when its last task is ticked, and reopens
// if a task is unticked (completedAt cleared).
// ---------------------------------------------------------------------------

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requirePermission, AuthorizationError } from "./auth-guard";
import { hasPermission } from "@/lib/rbac";
import type { OnboardingChecklistT, OnboardingTemplateTaskT } from "@/lib/types";
import {
  createChecklistSchema,
  addTaskSchema,
  taskDoneSchema,
  saveOnboardingTemplateTaskSchema,
  deleteOnboardingTemplateTaskSchema,
  parseOrThrow,
} from "@/lib/validation";
import { logAudit, readOnboardingTemplate, instantiateChecklist } from "./shared";
import { toResult } from "./result";
import type { ActionResult } from "@/lib/action-result";

// F2.10 (F-R8) — the template source is now the OnboardingTemplateTask table
// (with the canonical constants in lib/onboarding-template.ts as the
// empty-table fallback). The DEFAULT_TEMPLATE / DEFAULT_SEPARATION_TEMPLATE /
// templateFor constants that used to live here are GONE — this file, the
// inline copy inside markJoined, and the client copy in joiner-handout.tsx
// all read the one source through readOnboardingTemplate.

function serialize(
  c: {
    id: string; newHireId: string; title: string; kind: string;
    completedAt: Date | null; createdAt: Date; updatedAt: Date;
    tasks: {
      id: string; checklistId: string; title: string; assigneeId: string | null;
      dueOffsetDays: number; done: boolean; doneAt: Date | null; doneById: string | null;
      notes: string; order: number; createdAt: Date; updatedAt: Date;
    }[];
  },
  hireName: string,
  names: Map<string, string>,
): OnboardingChecklistT {
  return {
    id: c.id,
    newHireId: c.newHireId,
    hireName,
    title: c.title,
    kind: c.kind === "SEPARATION" ? "SEPARATION" : "ONBOARDING",
    completedAt: c.completedAt ? c.completedAt.toISOString() : null,
    createdAt: c.createdAt.toISOString(),
    tasks: c.tasks
      .slice()
      .sort((a, b) => a.order - b.order)
      .map((t) => ({
        id: t.id,
        checklistId: t.checklistId,
        title: t.title,
        assigneeId: t.assigneeId,
        assigneeName: t.assigneeId ? names.get(t.assigneeId) ?? null : null,
        dueOffsetDays: t.dueOffsetDays,
        done: t.done,
        doneAt: t.doneAt ? t.doneAt.toISOString() : null,
        doneBy: t.doneById ? names.get(t.doneById) ?? null : null,
        notes: t.notes,
        order: t.order,
      })),
  };
}

async function namesFor(userIds: string[]): Promise<Map<string, string>> {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (ids.length === 0) return new Map();
  const users = await db.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
  return new Map(users.map((u) => [u.id, u.name]));
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getOnboarding(): Promise<ActionResult<OnboardingChecklistT[]>> {
  return toResult(async () => {
    await requirePermission("onboarding:manage");
    const rows = await db.onboardingChecklist.findMany({
      orderBy: { createdAt: "desc" },
      include: { tasks: true },
      // PR-21 — hard cap; onboarding is a transient program, not an archive.
      take: 200,
    });
    const names = await namesFor([
      ...rows.map((r) => r.newHireId),
      ...rows.flatMap((r) => r.tasks.flatMap((t) => [t.assigneeId ?? "", t.doneById ?? ""])),
    ]);
    return rows.map((r) => serialize(r, names.get(r.newHireId) ?? "(former user)", names));
  });
}

/** The signed-in user's own actionable onboarding tasks (self-service). */
export async function getMyOnboardingTasks(): Promise<ActionResult<{
  checklists: OnboardingChecklistT[];
  canManage: boolean;
}>> {
  return toResult(async () => {
    const auth = await requirePermission("settings:edit");
    const rows = await db.onboardingChecklist.findMany({
      where: {
        OR: [{ newHireId: auth.userId }, { tasks: { some: { assigneeId: auth.userId } } }],
      },
      orderBy: { createdAt: "desc" },
      include: { tasks: true },
      // PR-21 — hard cap (a hire's own checklists are single digits).
      take: 100,
    });
    const names = await namesFor([
      ...rows.map((r) => r.newHireId),
      ...rows.flatMap((r) => r.tasks.flatMap((t) => [t.assigneeId ?? "", t.doneById ?? ""])),
    ]);
    return {
      checklists: rows.map((r) => serialize(r, names.get(r.newHireId) ?? "(former user)", names)),
      canManage: hasPermission(auth.role as never, "onboarding:manage"),
    };
  });
}

// ---------------------------------------------------------------------------
// Checklist management (onboarding:manage)
// ---------------------------------------------------------------------------

export async function createChecklist(input: {
  newHireId: string;
  title: string;
  useTemplate: boolean;
  kind?: "ONBOARDING" | "SEPARATION";
}): Promise<ActionResult<{ id: string }>> {
  return toResult(async () => {
    const auth = await requirePermission("onboarding:manage");
    const data = parseOrThrow(createChecklistSchema, input);
    const kind = data.kind;
    // F2.10 (F-R8) — the ONE template source (table rows, constants as the
    // empty-table fallback).
    const template = await readOnboardingTemplate(kind);

    const hire = await db.user.findUnique({
      where: { id: data.newHireId },
      select: { id: true, name: true, deletedAt: true },
    });
    if (!hire || hire.deletedAt) throw new AuthorizationError("New hire not found.");

    // F2.1 — a separation checklist targets an EXITING employee; the
    // exiting person themself still ticks the handover tasks (assignSelf),
    // so the deleted-user refusal is the only extra guard needed here.

    // PR-15 (production-readiness audit) — the checklist row, its template
    // tasks and the manager auto-assignment are one logical creation. The
    // nested create was already atomic; the manager updateMany now joins it
    // in the same transaction so a crash can't leave manager tasks stranded
    // unassigned while the checklist exists. F2.10 (F-R8): the whole body is
    // the SHARED instantiateChecklist — markJoined instantiates through the
    // exact same code path (no more drifted copy).
    const checklist = await db.$transaction(async (tx) =>
      instantiateChecklist(tx, {
        newHireId: data.newHireId,
        title: data.title,
        kind,
        template: data.useTemplate ? template : [],
      }),
    );

    await logAudit({
      actor: auth,
      action: kind === "SEPARATION" ? "hr.separation_checklist_created" : "onboarding.created",
      entityType: "ONBOARDING_CHECKLIST",
      entityId: checklist.id,
      entityLabel: data.title,
      detail: `${auth.name} ${kind === "SEPARATION" ? "started the separation checklist" : "started onboarding"} "${data.title}" for ${hire.name}${data.useTemplate ? ` (${template.length} template tasks)` : ""}.`,
    });
    revalidatePath("/");
    return { id: checklist.id };
  });
}

export async function addTask(input: {
  checklistId: string;
  title: string;
  assigneeId?: string | null;
  dueOffsetDays?: number;
}): Promise<ActionResult<void>> {
  return toResult(async () => {
    const auth = await requirePermission("onboarding:manage");
    const data = parseOrThrow(addTaskSchema, input);

    const checklist = await db.onboardingChecklist.findUnique({ where: { id: data.checklistId } });
    if (!checklist) throw new AuthorizationError("Checklist not found.");
    if (checklist.completedAt) {
      throw new AuthorizationError("This checklist is already complete — create a follow-up checklist instead.");
    }

    // QA-12: an assignee, when given, must be a real active user — the old
    // code accepted any cuid-shaped id, so a task could be assigned to a
    // nonexistent (or soft-deleted) user: nobody could ever tick it and the
    // UI rendered a blank assignee.
    if (data.assigneeId) {
      const assignee = await db.user.findUnique({
        where: { id: data.assigneeId },
        select: { id: true, deletedAt: true },
      });
      if (!assignee || assignee.deletedAt) {
        throw new AuthorizationError("Assignee not found.");
      }
    }

    const last = await db.onboardingTask.findFirst({
      where: { checklistId: checklist.id },
      orderBy: { order: "desc" },
      select: { order: true },
    });

    await db.onboardingTask.create({
      data: {
        checklistId: checklist.id,
        title: data.title,
        assigneeId: data.assigneeId ?? null,
        dueOffsetDays: data.dueOffsetDays ?? 7,
        order: (last?.order ?? 0) + 1,
      },
    });

    await logAudit({
      actor: auth,
      action: "onboarding.task_added",
      entityType: "ONBOARDING_CHECKLIST",
      entityId: checklist.id,
      entityLabel: checklist.title,
      detail: `${auth.name} added the task "${data.title}" to "${checklist.title}".`,
    });
    revalidatePath("/");
  });
}

// ---------------------------------------------------------------------------
// Task ticking — assignee, the hire, or onboarding:manage holders
// ---------------------------------------------------------------------------

async function assertCanTick(
  auth: { userId: string; role: string },
  taskId: string,
): Promise<{ id: string; title: string; checklistId: string; assigneeId: string | null }> {
  const task = await db.onboardingTask.findUnique({
    where: { id: taskId },
    select: { id: true, title: true, checklistId: true, assigneeId: true },
  });
  if (!task) throw new AuthorizationError("Task not found.");
  const checklist = await db.onboardingChecklist.findUnique({
    where: { id: task.checklistId },
    select: { newHireId: true },
  });
  const isAssignee = task.assigneeId === auth.userId;
  const isHire = checklist?.newHireId === auth.userId;
  const canManage = hasPermission(auth.role as never, "onboarding:manage");
  if (!isAssignee && !isHire && !canManage) {
    throw new AuthorizationError("Only the task's assignee, the new hire, or HR can tick this task.");
  }
  return task;
}

export async function setTaskDone(input: {
  taskId: string;
  done: boolean;
}): Promise<ActionResult<void>> {
  return toResult(async () => {
    const auth = await requirePermission("settings:edit");
    const taskId = parseOrThrow(taskDoneSchema, input).taskId;
    const task = await assertCanTick(auth, taskId);

    // PR-15 — the task tick and the derived checklist completion state are
    // one logical write. Previously a crash between them could auto-complete
    // a checklist whose last task never persisted as done (or leave a fully-
    // ticked checklist showing "in progress"). The count read stays outside
    // the transaction (it only informs the second write; the guarded
    // updateMany below is idempotent either way).
    const remaining = await db.onboardingTask.count({
      where: { checklistId: task.checklistId, done: false },
    });
    await db.$transaction(async (tx) => {
      await tx.onboardingTask.update({
        where: { id: task.id },
        data: {
          done: input.done,
          doneAt: input.done ? new Date() : null,
          doneById: input.done ? auth.userId : null,
        },
      });

      // Auto-complete / reopen the checklist based on the remaining tasks.
      if (input.done && remaining === 0) {
        await tx.onboardingChecklist.update({
          where: { id: task.checklistId },
          data: { completedAt: new Date() },
        });
      } else if (!input.done) {
        await tx.onboardingChecklist.updateMany({
          where: { id: task.checklistId, completedAt: { not: null } },
          data: { completedAt: null },
        });
      }
    });

    await logAudit({
      actor: auth,
      action: input.done ? "onboarding.task_done" : "onboarding.task_undone",
      entityType: "ONBOARDING_CHECKLIST",
      entityId: task.checklistId,
      entityLabel: task.title,
      detail: `${auth.name} marked "${task.title}" as ${input.done ? "done" : "not done"}.`,
    });
    revalidatePath("/");
  });
}

// ---------------------------------------------------------------------------
// F2.10 (F-R8) — the onboarding TEMPLATE source (OnboardingTemplateTask CRUD,
// onboarding:manage). Every instantiated checklist reads these rows (with the
// canonical constants as the empty-table fallback); the HR console's
// Onboarding tab edits them here.
// ---------------------------------------------------------------------------

/** All template rows, both kinds, sortOrder-first (onboarding:manage). */
export async function getOnboardingTemplates(): Promise<ActionResult<OnboardingTemplateTaskT[]>> {
  return toResult(async () => {
    await requirePermission("onboarding:manage");
    const rows = await db.onboardingTemplateTask.findMany({
      orderBy: [{ kind: "asc" }, { sortOrder: "asc" }, { createdAt: "asc" }],
    });
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind === "SEPARATION" ? "SEPARATION" : "ONBOARDING",
      title: r.title,
      dueOffsetDays: r.dueOffsetDays,
      assignSelf: r.assignSelf,
      isActive: r.isActive,
      sortOrder: r.sortOrder,
    }));
  });
}

/** Create or edit one template task row. sortOrder defaults to the kind's
 * current max + 1 so new tasks land at the end of their list. */
export async function saveOnboardingTemplateTask(input: unknown): Promise<ActionResult<{ id: string }>> {
  return toResult(async () => {
    const auth = await requirePermission("onboarding:manage");
    const data = parseOrThrow(saveOnboardingTemplateTaskSchema, input);

    if (data.id) {
      const existing = await db.onboardingTemplateTask.findUnique({ where: { id: data.id } });
      if (!existing) throw new AuthorizationError("Template task not found.");
      const row = await db.onboardingTemplateTask.update({
        where: { id: data.id },
        data: {
          kind: data.kind,
          title: data.title,
          dueOffsetDays: data.dueOffsetDays,
          assignSelf: data.assignSelf,
          isActive: data.isActive,
          ...(data.sortOrder !== undefined ? { sortOrder: data.sortOrder } : {}),
        },
      });
      await logAudit({
        actor: auth,
        action: "onboarding.template_task_saved",
        entityType: "ONBOARDING_TEMPLATE",
        entityId: row.id,
        entityLabel: row.title,
        detail: `${auth.name} edited the ${row.kind.toLowerCase()} template task "${row.title}" (due day ${row.dueOffsetDays}, ${row.assignSelf ? "self" : "manager"}, ${row.isActive ? "active" : "inactive"}).`,
      });
      revalidatePath("/");
      return { id: row.id };
    }

    const last = await db.onboardingTemplateTask.findFirst({
      where: { kind: data.kind },
      orderBy: { sortOrder: "desc" },
      select: { sortOrder: true },
    });
    const row = await db.onboardingTemplateTask.create({
      data: {
        kind: data.kind,
        title: data.title,
        dueOffsetDays: data.dueOffsetDays,
        assignSelf: data.assignSelf,
        isActive: data.isActive,
        sortOrder: data.sortOrder ?? (last?.sortOrder ?? 0) + 1,
      },
    });
    await logAudit({
      actor: auth,
      action: "onboarding.template_task_saved",
      entityType: "ONBOARDING_TEMPLATE",
      entityId: row.id,
      entityLabel: row.title,
      detail: `${auth.name} added the ${row.kind.toLowerCase()} template task "${row.title}" (due day ${row.dueOffsetDays}, ${row.assignSelf ? "self" : "manager"}).`,
    });
    revalidatePath("/");
    return { id: row.id };
  });
}

/** Remove one template task row. Instantiated checklists keep their tasks
 * (they are plain OnboardingTask rows) — only future instantiations change. */
export async function deleteOnboardingTemplateTask(input: unknown): Promise<ActionResult<{ ok: true }>> {
  return toResult(async () => {
    const auth = await requirePermission("onboarding:manage");
    const data = parseOrThrow(deleteOnboardingTemplateTaskSchema, input);
    const row = await db.onboardingTemplateTask.findUnique({ where: { id: data.id } });
    if (!row) throw new AuthorizationError("Template task not found.");
    await db.onboardingTemplateTask.delete({ where: { id: row.id } });
    await logAudit({
      actor: auth,
      action: "onboarding.template_task_deleted",
      entityType: "ONBOARDING_TEMPLATE",
      entityId: row.id,
      entityLabel: row.title,
      detail: `${auth.name} removed the ${row.kind.toLowerCase()} template task "${row.title}".`,
    });
    revalidatePath("/");
    return { ok: true };
  });
}
