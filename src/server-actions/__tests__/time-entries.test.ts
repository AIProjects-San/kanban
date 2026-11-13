import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Board enhancement — task-level time log server action tests.
//   logTaskTime     — log hours against a task (member derived from session)
//   getTaskTimeLog  — estimate + spent aggregate + entry list
//   deleteTimeEntry — own entries only, or task:edit:any
// ---------------------------------------------------------------------------

const db = vi.hoisted(() => {
  const models = ["task", "timeEntry", "teamMember", "project", "auditLog", "leaveRequest", "leaveType"];
  const methods = [
    "findMany", "findUnique", "findFirst", "create", "createMany", "update",
    "updateMany", "delete", "deleteMany", "upsert", "count", "aggregate",
  ];
  const obj: Record<string, Record<string, ReturnType<typeof vi.fn>>> = {};
  for (const m of models) {
    obj[m] = {};
    for (const meth of methods) obj[m][meth] = vi.fn();
  }
  return obj;
});

vi.mock("@/lib/infra/db", () => ({ db }));

const getSessionMock = vi.fn();
const getSessionOrThrowMock = vi.fn();
const requirePermissionMock = vi.fn();
vi.mock("@/server-actions/auth-guard", () => ({
  getSession: () => getSessionMock(),
  getSessionOrThrow: () => getSessionOrThrowMock(),
  requirePermission: (...a: unknown[]) => requirePermissionMock(...a),
  AuthorizationError: class AuthorizationError extends Error {
    readonly digest = "AuthorizationError";
    constructor(m: string) { super(m); this.name = "AuthorizationError"; }
  },
}));

const logAuditMock = vi.fn();
const getMyTeamMemberIdMock = vi.fn();
const getScopedProjectIdsMock = vi.fn();
const assertTaskEditPermissionMock = vi.fn();
vi.mock("@/server-actions/shared", () => ({
  logAudit: (...a: unknown[]) => logAuditMock(...a),
  getMyTeamMemberId: (...a: unknown[]) => getMyTeamMemberIdMock(...a),
  getScopedProjectIds: (...a: unknown[]) => getScopedProjectIdsMock(...a),
  assertTaskEditPermission: (...a: unknown[]) => assertTaskEditPermissionMock(...a),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { logTaskTime, getTaskTimeLog, deleteTimeEntry } from "../time-entries";

const ADMIN_AUTH = { userId: "u-admin", role: "ADMIN" as const, name: "Ada", email: "ada@x.co" };
const MEMBER_AUTH = { userId: "u-mia", role: "MEMBER" as const, name: "Mia", email: "mia@x.co" };

const TASK = {
  id: "t-1",
  title: "Implement board",
  projectId: "p-1",
  assigneeId: "m-mia",
  estimateMinutes: 240,
  status: "IN_PROGRESS",
  assignee: { userId: "u-mia" },
};

beforeEach(() => {
  vi.clearAllMocks();
  getSessionMock.mockResolvedValue(MEMBER_AUTH);
  getSessionOrThrowMock.mockResolvedValue(MEMBER_AUTH);
  requirePermissionMock.mockResolvedValue(MEMBER_AUTH);
  getMyTeamMemberIdMock.mockResolvedValue("m-mia");
  getScopedProjectIdsMock.mockResolvedValue(null); // unscoped by default
  assertTaskEditPermissionMock.mockResolvedValue(undefined); // allowed by default
  db.task.findUnique.mockResolvedValue(TASK);
  db.timeEntry.create.mockResolvedValue({ id: "te-1" });
  db.timeEntry.findMany.mockResolvedValue([]);
  db.timeEntry.findUnique.mockResolvedValue(null);
  db.timeEntry.delete.mockResolvedValue({});
  db.teamMember.findMany.mockResolvedValue([{ id: "m-mia", name: "Mia" }]);
  db.project.findUnique.mockResolvedValue({ name: "Apollo" });
  // HR module time guard — no approved leave by default.
  db.leaveRequest.findMany.mockResolvedValue([]);
  db.leaveType.findUnique.mockResolvedValue({ name: "Annual Leave" });
});

// ---------------------------------------------------------------------------
// logTaskTime
// ---------------------------------------------------------------------------

describe("logTaskTime", () => {
  it("creates an entry with taskId + inherited projectId + session-derived memberId", async () => {
    const res = await logTaskTime({ taskId: "t-1", date: "2026-11-02", hours: 3.5, description: "coding" });
    expect(res.ok).toBe(true);
    expect(db.timeEntry.create).toHaveBeenCalledWith({
      data: {
        taskId: "t-1",
        projectId: "p-1",
        memberId: "m-mia",
        date: expect.any(Date),
        hours: 3.5,
        description: "coding",
      },
    });
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "time.logged", entityLabel: "Implement board" }),
    );
  });

  // HR module time guard (docs/HR_MODULE_PLAN.md §4) — logging hours on an
  // approved-leave day is rejected at the write boundary.
  it("rejects logging hours on a day the user is on approved leave", async () => {
    db.leaveRequest.findMany.mockResolvedValue([{ id: "lr-1", leaveTypeId: "lt-annual" }]);
    const res = await logTaskTime({ taskId: "t-1", date: "2026-11-02", hours: 3.5 });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/approved Annual Leave/i);
    expect(db.timeEntry.create).not.toHaveBeenCalled();
  });

  it("allows logging hours on a normal working day", async () => {
    db.leaveRequest.findMany.mockResolvedValue([]);
    const res = await logTaskTime({ taskId: "t-1", date: "2026-11-02", hours: 3.5 });
    expect(res.ok).toBe(true);
    expect(db.timeEntry.create).toHaveBeenCalled();
  });

  it("rejects hours <= 0", async () => {
    const res = await logTaskTime({ taskId: "t-1", date: "2026-11-02", hours: 0 });
    expect(res.ok).toBe(false);
    expect(db.timeEntry.create).not.toHaveBeenCalled();
  });

  it("rejects hours > 24", async () => {
    const res = await logTaskTime({ taskId: "t-1", date: "2026-11-02", hours: 25 });
    expect(res.ok).toBe(false);
    expect(db.timeEntry.create).not.toHaveBeenCalled();
  });

  it("rejects a non-existent task", async () => {
    db.task.findUnique.mockResolvedValue(null);
    const res = await logTaskTime({ taskId: "t-missing", date: "2026-11-02", hours: 1 });
    expect(res.ok).toBe(false);
    expect(db.timeEntry.create).not.toHaveBeenCalled();
  });

  it("rejects users without a team member profile", async () => {
    getMyTeamMemberIdMock.mockResolvedValue(null);
    const res = await logTaskTime({ taskId: "t-1", date: "2026-11-02", hours: 1 });
    expect(res.ok).toBe(false);
    expect(db.timeEntry.create).not.toHaveBeenCalled();
  });

  it("rejects users who cannot edit the task", async () => {
    assertTaskEditPermissionMock.mockRejectedValue(new Error("You can only edit tasks that are assigned to you."));
    const res = await logTaskTime({ taskId: "t-1", date: "2026-11-02", hours: 1 });
    expect(res.ok).toBe(false);
    expect(db.timeEntry.create).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// getTaskTimeLog
// ---------------------------------------------------------------------------

describe("getTaskTimeLog", () => {
  it("returns estimate, spent aggregate, and entries with member names", async () => {
    db.timeEntry.findMany.mockResolvedValue([
      { id: "te-1", date: new Date("2026-11-01"), hours: 2, description: "a", memberId: "m-mia", createdAt: new Date() },
      { id: "te-2", date: new Date("2026-11-02"), hours: 1.5, description: "b", memberId: "m-mia", createdAt: new Date() },
    ]);
    const res = await getTaskTimeLog("t-1");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.estimateMinutes).toBe(240);
    expect(res.data.spentHours).toBe(3.5);
    expect(res.data.entries).toHaveLength(2);
    expect(res.data.entries[0].memberName).toBe("Mia");
  });

  it("denies scoped users tasks they cannot see", async () => {
    getScopedProjectIdsMock.mockResolvedValue(new Set(["p-other"]));
    // Assigned to someone else + project outside the scope set → denied.
    db.task.findUnique.mockResolvedValue({ ...TASK, assignee: { userId: "u-someone-else" } });
    const res = await getTaskTimeLog("t-1");
    expect(res.ok).toBe(false);
  });

  it("allows scoped users tasks assigned to them", async () => {
    getScopedProjectIdsMock.mockResolvedValue(new Set(["p-other"]));
    const res = await getTaskTimeLog("t-1");
    // assignee.userId === MEMBER_AUTH.userId, so access is granted despite
    // the project being outside the scope set.
    expect(res.ok).toBe(true);
  });

  it("requires a signed-in session", async () => {
    getSessionMock.mockResolvedValue(null);
    getSessionOrThrowMock.mockRejectedValue(Object.assign(new Error("You must be signed in."), { name: "AuthorizationError", digest: "AuthorizationError" }));
    const res = await getTaskTimeLog("t-1");
    expect(res.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// deleteTimeEntry
// ---------------------------------------------------------------------------

describe("deleteTimeEntry", () => {
  it("MEMBER deletes their own entry", async () => {
    db.timeEntry.findUnique.mockResolvedValue({
      id: "te-1", taskId: "t-1", memberId: "m-mia", hours: 2, date: new Date(),
    });
    const res = await deleteTimeEntry("te-1");
    expect(res.ok).toBe(true);
    expect(db.timeEntry.delete).toHaveBeenCalledWith({ where: { id: "te-1" } });
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "time.deleted" }),
    );
  });

  it("MEMBER cannot delete someone else's entry", async () => {
    db.timeEntry.findUnique.mockResolvedValue({
      id: "te-1", taskId: "t-1", memberId: "m-someone-else", hours: 2, date: new Date(),
    });
    const res = await deleteTimeEntry("te-1");
    expect(res.ok).toBe(false);
    expect(db.timeEntry.delete).not.toHaveBeenCalled();
  });

  it("ADMIN can delete anyone's entry", async () => {
    requirePermissionMock.mockResolvedValue(ADMIN_AUTH);
    db.timeEntry.findUnique.mockResolvedValue({
      id: "te-1", taskId: "t-1", memberId: "m-someone-else", hours: 2, date: new Date(),
    });
    const res = await deleteTimeEntry("te-1");
    expect(res.ok).toBe(true);
    expect(db.timeEntry.delete).toHaveBeenCalled();
  });

  it("missing entry is a clean no-op", async () => {
    db.timeEntry.findUnique.mockResolvedValue(null);
    const res = await deleteTimeEntry("te-missing");
    expect(res.ok).toBe(true);
    expect(db.timeEntry.delete).not.toHaveBeenCalled();
  });
});
