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
import type { OnboardingChecklistT } from "@/lib/types";
import {
  createChecklistSchema,
  addTaskSchema,
  taskDoneSchema,
  parseOrThrow,
} from "@/lib/validation";
import { logAudit } from "./shared";
import { toResult } from "./result";
import type { ActionResult } from "@/lib/action-result";

/** The default template instantiated per new hire. */
const DEFAULT_TEMPLATE: { title: string; dueOffsetDays: number; assignSelf: boolean }[] = [
  { title: "Sign the employment contract", dueOffsetDays: 1, assignSelf: false },
  { title: "Set up accounts and SSO access", dueOffsetDays: 2, assignSelf: false },
  { title: "Meet your manager for the 1:1 kick-off", dueOffsetDays: 3, assignSelf: false },
  { title: "Complete the workspace tour", dueOffsetDays: 5, assignSelf: true },
  { title: "First small task shipped with a mentor", dueOffsetDays: 14, assignSelf: true },
];

/** F2.1 — the default SEPARATION template (benchmark EM-14's symmetric
 * exit flow). Offsets count from the separation checklist's creation
 * (typically around the exit), not the last working day — the assignee
 * reads them as "within N days" guidance. */
const DEFAULT_SEPARATION_TEMPLATE: { title: string; dueOffsetDays: number; assignSelf: boolean }[] = [
  { title: "Hand over ongoing work and documents", dueOffsetDays: 3, assignSelf: true },
  { title: "Return laptop and access devices", dueOffsetDays: 5, assignSelf: true },
  { title: "Revoke accounts, SSO and tool access", dueOffsetDays: 5, assignSelf: false },
  { title: "Hold the exit interview", dueOffsetDays: 7, assignSelf: false },
  { title: "Settle the full-and-final statement", dueOffsetDays: 10, assignSelf: false },
];

function templateFor(kind: string) {
  return kind === "SEPARATION" ? DEFAULT_SEPARATION_TEMPLATE : DEFAULT_TEMPLATE;
}

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
    const template = templateFor(kind);

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
    // unassigned while the checklist exists.
    const checklist = await db.$transaction(async (tx) => {
      const created = await tx.onboardingChecklist.create({
        data: {
          newHireId: data.newHireId,
          title: data.title,
          kind,
          ...(data.useTemplate
            ? {
                tasks: {
                  create: template.map((t, i) => ({
                    title: t.title,
                    dueOffsetDays: t.dueOffsetDays,
                    // Self tasks go to the hire; manager tasks default to the
                    // hire's manager when one exists, else unassigned (HR picks up).
                    assigneeId: t.assignSelf ? data.newHireId : null,
                    order: i,
                  })),
                },
              }
            : {}),
        },
        include: { tasks: true },
      });

      // The manager tasks belong to the hire's manager — assign them now.
      // (Separation: the handover/revoke owners default to the manager the
      // same way — one code path, symmetric flow.)
      if (data.useTemplate) {
        const approvers = await tx.user.findUnique({
          where: { id: data.newHireId },
          select: { managerId: true },
        });
        const managerId = approvers?.managerId ?? null;
        if (managerId) {
          await tx.onboardingTask.updateMany({
            where: { checklistId: created.id, assigneeId: null },
            data: { assigneeId: managerId },
          });
        }
      }
      return created;
    });

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
