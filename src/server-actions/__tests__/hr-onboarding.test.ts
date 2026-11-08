import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// HR module feature 4 — onboarding action tests (docs/HR_MODULE_PLAN.md §7):
// template instantiation + manager auto-assignment, tick permissions,
// auto-complete / reopen transitions, completed-checklist guards.
// ---------------------------------------------------------------------------

const db = vi.hoisted(() => {
  const models = ["onboardingChecklist", "onboardingTask", "onboardingTemplateTask", "user", "auditLog", "notification"];
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
vi.mock("@/server-actions/shared", async () => {
  // F2.10 — readOnboardingTemplate + instantiateChecklist run for real over
  // the mocked db (createChecklist's own logic moved into them); only
  // logAudit is a spy.
  const actual = await vi.importActual<typeof import("@/server-actions/shared")>("@/server-actions/shared");
  return {
    logAudit: (...a: unknown[]) => logAuditMock(...a),
    readOnboardingTemplate: actual.readOnboardingTemplate,
    instantiateChecklist: actual.instantiateChecklist,
    sendOutboxMail: actual.sendOutboxMail,
  };
});

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import {
  createChecklist,
  addTask,
  setTaskDone,
  getOnboarding,
  getMyOnboardingTasks,
  getOnboardingTemplates,
  saveOnboardingTemplateTask,
  deleteOnboardingTemplateTask,
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
  // F2.10 — empty template table: instantiation falls back to the canonical
  // constants (the 5-task default the previous code copied inline).
  db.onboardingTemplateTask.findMany.mockResolvedValue([]);
  db.onboardingTemplateTask.findFirst.mockResolvedValue(null);
  db.onboardingTemplateTask.findUnique.mockResolvedValue(null);
  db.onboardingTemplateTask.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "tt-new", ...data }));
  db.onboardingTemplateTask.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "tt-1", ...data }));
  db.onboardingTemplateTask.delete.mockResolvedValue({ id: "tt-1", kind: "ONBOARDING", title: "Old task" });
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

// ---------------------------------------------------------------------------
// PR-56 — remaining branch coverage: the task sort/map arrows (which only
// execute with 2+ tasks), the namesFor empty-ids short-circuit, the
// not-found guards, and the former-user fallback.
// ---------------------------------------------------------------------------

describe("PR-56 — remaining branch coverage", () => {
  // hr-onboarding.ts:63-64 — the sort comparator and map arrows never run
  // for 0- or 1-task checklists (Array#sort skips the comparator). Feed a
  // checklist with two tasks stored OUT of order and assert the serialized
  // order; also pins the null-assignee (line 69) and doneBy-name (line 73)
  // arms of the serializer.
  it("pins hr-onboarding.ts:63-64 — tasks serialize sorted by order, with assignee/doneBy names", async () => {
    requirePermissionMock.mockResolvedValue(HR_AUTH);
    const taskRow = (over: Record<string, unknown>) => ({
      ...TASK, done: false, dueOffsetDays: 2, doneAt: null, doneById: null,
      notes: "", createdAt: new Date(), updatedAt: new Date(), ...over,
    });
    db.onboardingChecklist.findMany.mockResolvedValue([
      {
        ...CHECKLIST, completedAt: null, createdAt: new Date(), updatedAt: new Date(),
        tasks: [
          taskRow({ id: "t-second", order: 1, assigneeId: null }), // null assignee → assigneeName null
          taskRow({ id: "t-first", order: 0, assigneeId: "u-mgr", done: true, doneAt: new Date(), doneById: "u-diego" }),
        ],
      },
    ]);
    db.user.findMany.mockResolvedValue([
      { id: "u-diego", name: "Diego Morales" },
      { id: "u-mgr", name: "Ingrid Solberg" },
    ]);
    const res = await getOnboarding();
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data[0].tasks.map((t) => t.id)).toEqual(["t-first", "t-second"]); // sort actually ran
      expect(res.data[0].tasks[0]).toMatchObject({
        assigneeName: "Ingrid Solberg",
        doneBy: "Diego Morales",
      });
      expect(res.data[0].tasks[1].assigneeName).toBeNull();
    }
  });

  // hr-onboarding.ts:82 — namesFor short-circuits when the id set is empty
  // (zero checklists → no hire, assignee or doneBy ids at all): no user
  // query is issued and the read resolves to an empty list.
  it("pins hr-onboarding.ts:82 — namesFor skips the user query entirely for an empty id set", async () => {
    requirePermissionMock.mockResolvedValue(HR_AUTH);
    db.onboardingChecklist.findMany.mockResolvedValue([]);
    const res = await getOnboarding();
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data).toEqual([]);
    expect(db.user.findMany).not.toHaveBeenCalled();
  });

  // hr-onboarding.ts:104 — a checklist whose hire's user row no longer
  // resolves renders the "(former user)" fallback instead of a blank name.
  it("pins hr-onboarding.ts:104 — an unresolvable hire renders '(former user)'", async () => {
    requirePermissionMock.mockResolvedValue(HR_AUTH);
    db.onboardingChecklist.findMany.mockResolvedValue([
      { ...CHECKLIST, newHireId: "u-gone", completedAt: null, createdAt: new Date(), updatedAt: new Date(), tasks: [] },
    ]);
    db.user.findMany.mockResolvedValue([]); // nobody resolves
    const res = await getOnboarding();
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data[0].hireName).toBe("(former user)");
  });

  // hr-onboarding.ts:223 — addTask against a checklist id that matches
  // nothing fails with a clear not-found error before any task write.
  it("pins hr-onboarding.ts:223 — addTask on an unknown checklist fails with not-found", async () => {
    requirePermissionMock.mockResolvedValue(HR_AUTH);
    db.onboardingChecklist.findUnique.mockResolvedValue(null);
    const res = await addTask({ checklistId: "c-ghost", title: "Ghost task" });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/checklist not found/i);
    expect(db.onboardingTask.create).not.toHaveBeenCalled();
  });

  // hr-onboarding.ts:282 — assertCanTick (via setTaskDone) rejects an
  // unknown task id before any permission logic or write happens.
  it("pins hr-onboarding.ts:282 — setTaskDone on an unknown task fails with not-found", async () => {
    requirePermissionMock.mockResolvedValue(MEMBER_AUTH);
    db.onboardingTask.findUnique.mockResolvedValue(null);
    const res = await setTaskDone({ taskId: "t-ghost", done: true });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/task not found/i);
    expect(db.onboardingTask.update).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// F2.10 (F-R8) — the ONE template source: table-driven instantiation + the
// onboarding:manage CRUD for the default rows.
// ---------------------------------------------------------------------------

describe("F2.10 — table-driven template instantiation", () => {
  it("createChecklist instantiates the TEMPLATE TABLE rows (empty table → the canonical constant fallback)", async () => {
    requirePermissionMock.mockResolvedValue(HR_AUTH);
    db.user.findUnique.mockResolvedValue({ id: "u-diego", name: "Diego Morales", deletedAt: null });
    const res = await createChecklist({ newHireId: "u-diego", title: "Nov onboarding", useTemplate: true });
    expect(res.ok).toBe(true);
    expect(db.onboardingTemplateTask.findMany).toHaveBeenCalledWith({ where: { kind: "ONBOARDING" }, orderBy: { sortOrder: "asc" } });
    // Empty table → the 5 canonical tasks (the fallback constants).
    const createCall = db.onboardingChecklist.create.mock.calls[0][0];
    expect(createCall.data.tasks.create).toHaveLength(5);
  });

  it("the SEPARATION kind reads the separation rows — same one code path", async () => {
    requirePermissionMock.mockResolvedValue(HR_AUTH);
    db.user.findUnique.mockResolvedValue({ id: "u-leaver", name: "Soren Lindqvist", deletedAt: null });
    db.onboardingTemplateTask.findMany.mockResolvedValue([
      { id: "tt-1", kind: "SEPARATION", title: "Hand over ongoing work and documents", dueOffsetDays: 3, assignSelf: true, isActive: true, sortOrder: 10 },
    ]);
    const res = await createChecklist({ newHireId: "u-leaver", title: "Soren exit", useTemplate: true, kind: "SEPARATION" });
    expect(res.ok).toBe(true);
    expect(db.onboardingTemplateTask.findMany).toHaveBeenCalledWith({ where: { kind: "SEPARATION" }, orderBy: { sortOrder: "asc" } });
    const createCall = db.onboardingChecklist.create.mock.calls[0][0];
    expect(createCall.data.tasks.create).toEqual([
      expect.objectContaining({ title: "Hand over ongoing work and documents", dueOffsetDays: 3, assigneeId: "u-leaver" }),
    ]);
  });

  it("inactive rows are skipped; self rows go to the hire, the rest to the manager", async () => {
    requirePermissionMock.mockResolvedValue(HR_AUTH);
    db.user.findUnique
      .mockResolvedValueOnce({ id: "u-diego", name: "Diego Morales", deletedAt: null })
      .mockResolvedValueOnce({ managerId: "u-mgr" });
    db.onboardingTemplateTask.findMany.mockResolvedValue([
      { id: "tt-1", kind: "ONBOARDING", title: "Manager task", dueOffsetDays: 1, assignSelf: false, isActive: true, sortOrder: 10 },
      { id: "tt-2", kind: "ONBOARDING", title: "Self task", dueOffsetDays: 2, assignSelf: true, isActive: true, sortOrder: 20 },
      { id: "tt-3", kind: "ONBOARDING", title: "Off task", dueOffsetDays: 3, assignSelf: true, isActive: false, sortOrder: 30 },
    ]);
    const res = await createChecklist({ newHireId: "u-diego", title: "Nov onboarding", useTemplate: true });
    expect(res.ok).toBe(true);
    const createCall = db.onboardingChecklist.create.mock.calls[0][0];
    expect(createCall.data.tasks.create).toEqual([
      expect.objectContaining({ title: "Manager task", assigneeId: null }),
      expect.objectContaining({ title: "Self task", assigneeId: "u-diego" }),
    ]);
    expect(db.onboardingTask.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ checklistId: "c-new", assigneeId: null }),
        data: { assigneeId: "u-mgr" },
      }),
    );
  });
});

describe("F2.10 — template CRUD (onboarding:manage)", () => {
  it("getOnboardingTemplates serializes both kinds", async () => {
    requirePermissionMock.mockResolvedValue(HR_AUTH);
    db.onboardingTemplateTask.findMany.mockResolvedValue([
      { id: "tt-1", kind: "ONBOARDING", title: "Sign the employment contract", dueOffsetDays: 1, assignSelf: false, isActive: true, sortOrder: 10 },
      { id: "tt-2", kind: "WEIRD", title: "Unknown kind normalizes", dueOffsetDays: 2, assignSelf: true, isActive: true, sortOrder: 20 },
    ]);
    const res = await getOnboardingTemplates();
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data[0]).toMatchObject({ id: "tt-1", kind: "ONBOARDING", dueOffsetDays: 1 });
      expect(res.data[1].kind).toBe("ONBOARDING");
    }
  });

  it("saveOnboardingTemplateTask creates with sortOrder defaulting to the kind's max + 1", async () => {
    requirePermissionMock.mockResolvedValue(HR_AUTH);
    db.onboardingTemplateTask.findFirst.mockResolvedValue({ sortOrder: 50 });
    const res = await saveOnboardingTemplateTask({ kind: "ONBOARDING", title: "New task", dueOffsetDays: 3, assignSelf: true });
    expect(res.ok).toBe(true);
    expect(db.onboardingTemplateTask.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ title: "New task", sortOrder: 51 }) }),
    );
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "onboarding.template_task_saved" }));
  });

  it("saveOnboardingTemplateTask edits by id (title/due/assignee/active)", async () => {
    requirePermissionMock.mockResolvedValue(HR_AUTH);
    db.onboardingTemplateTask.findUnique.mockResolvedValue({ id: "tt-1", kind: "ONBOARDING", title: "Old" });
    const res = await saveOnboardingTemplateTask({ id: "tt-1", kind: "ONBOARDING", title: "Renamed", dueOffsetDays: 5, assignSelf: false, isActive: false });
    expect(res.ok).toBe(true);
    expect(db.onboardingTemplateTask.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "tt-1" }, data: expect.objectContaining({ title: "Renamed", isActive: false }) }),
    );
  });

  it("validation bounds: empty title / due day 0 / bad kind are refused", async () => {
    requirePermissionMock.mockResolvedValue(HR_AUTH);
    const badTitle = await saveOnboardingTemplateTask({ kind: "ONBOARDING", title: "  ", dueOffsetDays: 3 });
    expect(badTitle.ok).toBe(false);
    const badDay = await saveOnboardingTemplateTask({ kind: "ONBOARDING", title: "X", dueOffsetDays: 0 });
    expect(badDay.ok).toBe(false);
    const badKind = await saveOnboardingTemplateTask({ kind: "MIDWAY", title: "X", dueOffsetDays: 3 });
    expect(badKind.ok).toBe(false);
  });

  it("deleteOnboardingTemplateTask removes the row and audits", async () => {
    requirePermissionMock.mockResolvedValue(HR_AUTH);
    db.onboardingTemplateTask.findUnique.mockResolvedValue({ id: "tt-1", kind: "ONBOARDING", title: "Old task" });
    const res = await deleteOnboardingTemplateTask({ id: "tt-1" });
    expect(res.ok).toBe(true);
    expect(db.onboardingTemplateTask.delete).toHaveBeenCalledWith({ where: { id: "tt-1" } });
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "onboarding.template_task_deleted" }));
  });

  it("the CRUD is onboarding:manage-gated (MEMBER refused)", async () => {
    requirePermissionMock.mockImplementation(async (perm: string) => {
      if (perm === "onboarding:manage") {
        throw new (class extends Error { digest = "AuthorizationError"; })("denied");
      }
      return MEMBER_AUTH;
    });
    const read = await getOnboardingTemplates();
    const save = await saveOnboardingTemplateTask({ kind: "ONBOARDING", title: "X", dueOffsetDays: 3 });
    const del = await deleteOnboardingTemplateTask({ id: "tt-1" });
    expect(read.ok || save.ok || del.ok).toBe(false);
  });
});
