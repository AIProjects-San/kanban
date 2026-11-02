import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// HR module feature 4 — onboarding action tests (docs/HR_MODULE_PLAN.md §7):
// template instantiation + manager auto-assignment, tick permissions,
// auto-complete / reopen transitions, completed-checklist guards.
// ---------------------------------------------------------------------------

const db = vi.hoisted(() => {
  const models = ["onboardingChecklist", "onboardingTask", "user", "auditLog", "notification"];
  const methods = [
    "findMany", "findUnique", "findFirst", "create", "createMany", "update",
    "updateMany", "delete", "deleteMany", "upsert", "count", "aggregate",
  ];
  const obj: Record<string, Record<string, ReturnType<typeof vi.fn>>> = {};
  for (const m of models) {
    obj[m] = {};
    for (const meth of methods) obj[m][meth] = vi.fn();
  }
  // PR-15 — interactive transactions: execute the callback against the same
  // mock (array form still resolves via Promise.all).
  (obj as Record<string, unknown>).$transaction = vi.fn(
    async (fn: unknown) =>
      typeof fn === "function" ? fn(obj) : Promise.all(fn as unknown[]),
  );
  return obj;
});

vi.mock("@/lib/db", () => ({ db }));

const requirePermissionMock = vi.fn();
vi.mock("@/server-actions/auth-guard", () => ({
  requirePermission: (...a: unknown[]) => requirePermissionMock(...a),
  AuthorizationError: class AuthorizationError extends Error {
    readonly digest = "AuthorizationError";
    constructor(m: string) { super(m); this.name = "AuthorizationError"; }
  },
}));

const logAuditMock = vi.fn();
vi.mock("@/server-actions/shared", () => ({
  logAudit: (...a: unknown[]) => logAuditMock(...a),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import {
  createChecklist,
  addTask,
  setTaskDone,
  getOnboarding,
  getMyOnboardingTasks,
} from "../hr-onboarding";

const ADMIN_AUTH = { userId: "u-admin", role: "ADMIN" as const, name: "Ada", email: "ada@x.co" };
const HR_AUTH = { userId: "u-hr", role: "HR" as const, name: "Remy", email: "remy@x.co" };
const MANAGER_AUTH = { userId: "u-mgr", role: "MANAGER" as const, name: "Ingrid", email: "ingrid@x.co" };
const MEMBER_AUTH = { userId: "u-diego", role: "MEMBER" as const, name: "Diego", email: "diego@x.co" };

const TASK = { id: "t-1", title: "Set up accounts and SSO access", checklistId: "c-1", assigneeId: "u-diego" };
const CHECKLIST = { id: "c-1", newHireId: "u-diego", title: "Nov onboarding" };

beforeEach(() => {
  vi.clearAllMocks();
  requirePermissionMock.mockResolvedValue(MEMBER_AUTH);
  db.onboardingChecklist.findMany.mockResolvedValue([]);
  db.onboardingChecklist.findUnique.mockResolvedValue(null);
  db.onboardingChecklist.create.mockResolvedValue({ id: "c-new", tasks: [] });
  db.onboardingChecklist.update.mockResolvedValue({});
  db.onboardingChecklist.updateMany.mockResolvedValue({ count: 0 });
  db.onboardingTask.findUnique.mockResolvedValue(null);
  db.onboardingTask.findFirst.mockResolvedValue(null);
  db.onboardingTask.create.mockResolvedValue({ id: "t-new" });
  db.onboardingTask.update.mockResolvedValue({});
  db.onboardingTask.updateMany.mockResolvedValue({ count: 0 });
  db.onboardingTask.count.mockResolvedValue(0);
  db.user.findUnique.mockResolvedValue(null);
  db.user.findMany.mockResolvedValue([]);
});

describe("createChecklist", () => {
  it("requires onboarding:manage (a MEMBER is rejected)", async () => {
    requirePermissionMock.mockImplementation(async (perm: string) => {
      if (perm === "onboarding:manage") {
        throw new (class extends Error { digest = "AuthorizationError"; })("denied");
      }
      return MEMBER_AUTH;
    });
    const res = await createChecklist({ newHireId: "u-diego", title: "X", useTemplate: true });
    expect(res.ok).toBe(false);
    expect(db.onboardingChecklist.create).not.toHaveBeenCalled();
  });

  it("instantiates the 5-task template and assigns manager tasks to the hire's manager", async () => {
    requirePermissionMock.mockResolvedValue(HR_AUTH);
    // First findUnique = the hire lookup; second = the managerId lookup.
    db.user.findUnique
      .mockResolvedValueOnce({ id: "u-diego", name: "Diego Morales", deletedAt: null })
      .mockResolvedValueOnce({ managerId: "u-mgr" });
    const res = await createChecklist({ newHireId: "u-diego", title: "Nov onboarding", useTemplate: true });
    expect(res.ok).toBe(true);
    const createCall = db.onboardingChecklist.create.mock.calls[0][0];
    expect(createCall.data.tasks.create).toHaveLength(5);
    expect(db.onboardingTask.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ checklistId: "c-new", assigneeId: null }),
        data: { assigneeId: "u-mgr" },
      }),
    );
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "onboarding.created" }),
    );
  });

  it("rejects an unknown or soft-deleted hire", async () => {
    requirePermissionMock.mockResolvedValue(ADMIN_AUTH);
    db.user.findUnique.mockResolvedValue(null);
    const res = await createChecklist({ newHireId: "u-ghost", title: "X", useTemplate: false });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/not found/i);
  });
});

describe("addTask", () => {
  it("HR appends a task after the last one", async () => {
    requirePermissionMock.mockResolvedValue(HR_AUTH);
    db.onboardingChecklist.findUnique.mockResolvedValue({ ...CHECKLIST, completedAt: null });
    db.onboardingTask.findFirst.mockResolvedValue({ order: 4 });
    const res = await addTask({ checklistId: "c-1", title: "Order the laptop", dueOffsetDays: 2 });
    expect(res.ok).toBe(true);
    expect(db.onboardingTask.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ title: "Order the laptop", order: 5, dueOffsetDays: 2 }) }),
    );
  });

  it("rejects adding to a completed checklist", async () => {
    requirePermissionMock.mockResolvedValue(ADMIN_AUTH);
    db.onboardingChecklist.findUnique.mockResolvedValue({ ...CHECKLIST, completedAt: new Date() });
    const res = await addTask({ checklistId: "c-1", title: "Late task" });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/complete/i);
  });

  // QA-12 — the assignee id was never validated, so a task could be
  // assigned to a nonexistent (or soft-deleted) user: nobody could ever
  // tick it and the UI rendered a blank assignee.
  it("QA-12: rejects an assignee that does not exist", async () => {
    requirePermissionMock.mockResolvedValue(HR_AUTH);
    db.onboardingChecklist.findUnique.mockResolvedValue({ ...CHECKLIST, completedAt: null });
    db.user.findUnique.mockResolvedValue(null);
    const res = await addTask({ checklistId: "c-1", title: "Ghost task", assigneeId: "u-ghost" });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/assignee not found/i);
    expect(db.onboardingTask.create).not.toHaveBeenCalled();
  });

  it("QA-12: rejects a soft-deleted assignee", async () => {
    requirePermissionMock.mockResolvedValue(HR_AUTH);
    db.onboardingChecklist.findUnique.mockResolvedValue({ ...CHECKLIST, completedAt: null });
    db.user.findUnique.mockResolvedValue({ id: "u-ex", deletedAt: new Date() });
    const res = await addTask({ checklistId: "c-1", title: "Ex-employee task", assigneeId: "u-ex" });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/assignee not found/i);
    expect(db.onboardingTask.create).not.toHaveBeenCalled();
  });

  it("QA-12: accepts a real assignee", async () => {
    requirePermissionMock.mockResolvedValue(HR_AUTH);
    db.onboardingChecklist.findUnique.mockResolvedValue({ ...CHECKLIST, completedAt: null });
    db.user.findUnique.mockResolvedValue({ id: "u-theo", deletedAt: null });
    db.onboardingTask.findFirst.mockResolvedValue({ order: 4 });
    const res = await addTask({ checklistId: "c-1", title: "Pair with Theo", assigneeId: "u-theo" });
    expect(res.ok).toBe(true);
    expect(db.onboardingTask.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ assigneeId: "u-theo" }) }),
    );
  });
});

describe("setTaskDone", () => {
  function setupTask(task: object, checklist: object) {
    db.onboardingTask.findUnique.mockResolvedValue(task);
    db.onboardingChecklist.findUnique.mockResolvedValue(checklist);
  }

  it("the assignee ticks their task; the checklist auto-completes when none remain", async () => {
    requirePermissionMock.mockResolvedValue(MEMBER_AUTH);
    setupTask(TASK, CHECKLIST);
    db.onboardingTask.count.mockResolvedValue(0); // this was the last one
    const res = await setTaskDone({ taskId: "t-1", done: true });
    expect(res.ok).toBe(true);
    expect(db.onboardingTask.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ done: true, doneById: "u-diego" }) }),
    );
    expect(db.onboardingChecklist.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ completedAt: expect.any(Date) }) }),
    );
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "onboarding.task_done" }),
    );
  });

  it("unticking reopens a completed checklist", async () => {
    requirePermissionMock.mockResolvedValue(ADMIN_AUTH);
    setupTask({ ...TASK, done: true }, { ...CHECKLIST, completedAt: new Date() });
    const res = await setTaskDone({ taskId: "t-1", done: false });
    expect(res.ok).toBe(true);
    expect(db.onboardingChecklist.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { completedAt: null } }),
    );
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "onboarding.task_undone" }),
    );
  });

  it("the new hire can tick an unassigned task on their own checklist", async () => {
    requirePermissionMock.mockResolvedValue(MEMBER_AUTH);
    setupTask({ ...TASK, assigneeId: null }, CHECKLIST); // Diego is the hire
    const res = await setTaskDone({ taskId: "t-1", done: true });
    expect(res.ok).toBe(true);
  });

  it("a member outside the checklist cannot tick", async () => {
    requirePermissionMock.mockResolvedValue({ ...MEMBER_AUTH, userId: "u-stranger" });
    setupTask({ ...TASK, assigneeId: "u-someone" }, { ...CHECKLIST, newHireId: "u-hana" });
    const res = await setTaskDone({ taskId: "t-1", done: true });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/assignee/i);
  });

  it("a MANAGER without onboarding:manage cannot tick others' tasks", async () => {
    requirePermissionMock.mockResolvedValue(MANAGER_AUTH);
    setupTask({ ...TASK, assigneeId: "u-someone" }, { ...CHECKLIST, newHireId: "u-hana" });
    const res = await setTaskDone({ taskId: "t-1", done: true });
    expect(res.ok).toBe(false);
  });
});

describe("reads", () => {
  it("getOnboarding lists checklists with progress data", async () => {
    requirePermissionMock.mockResolvedValue(HR_AUTH);
    db.onboardingChecklist.findMany.mockResolvedValue([
      { ...CHECKLIST, completedAt: null, createdAt: new Date(), updatedAt: new Date(), tasks: [{ ...TASK, done: false, dueOffsetDays: 2, doneAt: null, doneById: null, notes: "", order: 0, createdAt: new Date(), updatedAt: new Date() }] },
    ]);
    db.user.findMany.mockResolvedValue([{ id: "u-diego", name: "Diego Morales" }]);
    const res = await getOnboarding();
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data[0].hireName).toBe("Diego Morales");
      expect(res.data[0].tasks[0].title).toBe("Set up accounts and SSO access");
    }
  });

  it("getMyOnboardingTasks returns the caller's checklists (hire or assignee)", async () => {
    db.onboardingChecklist.findMany.mockResolvedValue([
      { ...CHECKLIST, completedAt: null, createdAt: new Date(), updatedAt: new Date(), tasks: [{ ...TASK, assigneeId: "u-diego", done: false, dueOffsetDays: 2, doneAt: null, doneById: null, notes: "", order: 0, createdAt: new Date(), updatedAt: new Date() }] },
    ]);
    db.user.findMany.mockResolvedValue([{ id: "u-diego", name: "Diego Morales" }]);
    const res = await getMyOnboardingTasks();
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.checklists).toHaveLength(1);
      expect(res.data.canManage).toBe(false);
    }
  });
});
