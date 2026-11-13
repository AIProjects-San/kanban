import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// PR-56-DW — coverage for the remaining uncovered branches in dashboard.ts
// and workspace.ts (87.7% / 87.6% statements before this suite).
//
// dashboard.ts targets:
//   • L241      — per-task bug-count aggregation loop body (bug-link rows)
//   • L264      — approved-leave visibility filter callback
//   • L272-291  — the approved-leave → virtual LEAVE calendar-event pipeline:
//                 leave-user/leave-type lookups, the "Member — Leave"
//                 fallbacks, and the 1-day / N-day description branches
//   • L327      — per-task spent-hours aggregate (timeEntries reduce callback)
//   • L464      — getProjectMembers' anonymous-session guard
//   • L476      — getProjectMembers' out-of-scope project guard
// workspace.ts targets:
//   • L146, L153-155 — deleteConfigItem's not-found + still-in-use guards
//   • L184, L210-215 — updateRole's not-found + protected-permission guards
//   • L276-281       — createRole's protected-permission guard
//   • L310           — deleteRole's not-found guard
//
// Mock conventions mirror the existing suites (bugs.test.ts / data.test.ts):
// a vi.hoisted db mock with per-model vi.fn()s, an auth-guard mock whose
// AuthorizationError carries the stable `digest` marker, a shared.ts mock,
// and a next/cache revalidatePath mock.
// ---------------------------------------------------------------------------

const db = vi.hoisted(() => {
  const models = [
    "auditLog", "project", "task", "teamMember", "reminder", "notification",
    "timeEntry", "calendarEvent", "message", "messageRead", "bug", "user", "userSettings",
    "projectAssignment", "workspace", "role", "permission", "rolePermission",
    "taskStatusConfig", "projectStatusConfig", "eventTypeConfig",
    "leaveRequest", "leaveType", "leavePolicy", "leaveBalance",
    "taskTagConfig", "priorityConfig", "departmentConfig",
  ];
  const methods = [
    "findMany", "findUnique", "findFirst", "create", "createMany", "update",
    "updateMany", "delete", "deleteMany", "upsert", "count", "aggregate",
  ];
  const obj: Record<string, Record<string, ReturnType<typeof vi.fn>>> = {};
  for (const m of models) {
    obj[m] = {};
    for (const meth of methods) obj[m][meth] = vi.fn();
  }
  // Interactive transactions: execute the callback against the same mock so
  // tx.<model>.<method>() is recorded on the shared spies (updateRole and
  // createRole run their writes inside db.$transaction).
  (obj as Record<string, unknown>).$transaction = vi.fn(
    async (fn: (tx: unknown) => Promise<unknown>) =>
      typeof fn === "function" ? fn(obj) : Promise.resolve(fn),
  );
  return obj;
});

vi.mock("@/lib/db", () => ({ db }));

const getSessionMock = vi.fn();
const requirePermissionMock = vi.fn();
vi.mock("@/server-actions/auth-guard", () => {
  class AuthorizationError extends Error {
    readonly digest = "AuthorizationError";
    constructor(m: string) { super(m); this.name = "AuthorizationError"; }
  }
  return {
    getSession: () => getSessionMock(),
    getSessionOrThrow: async () => {
      const a = await getSessionMock();
      if (!a) throw new AuthorizationError("You must be signed in.");
      return a;
    },
  
  requirePermission: (...a: unknown[]) => requirePermissionMock(...a),
  AuthorizationError,
  };
});

const logAuditMock = vi.fn();
const getScopedProjectIdsMock = vi.fn();
const getWorkspaceLimitMock = vi.fn();
vi.mock("@/server-actions/shared", () => ({
  logAudit: (...a: unknown[]) => logAuditMock(...a),
  getScopedProjectIds: (...a: unknown[]) => getScopedProjectIdsMock(...a),
  getWorkspaceLimit: (...a: unknown[]) => getWorkspaceLimitMock(...a),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { getDashboardData, getProjectMembers } from "@/server-actions/dashboard";
import {
  deleteConfigItem,
  updateRole,
  createRole,
  deleteRole,
} from "@/server-actions/workspace";
import type { ActionResult, ActionErrorCode } from "@/lib/action-result";

/** Assert an action failed, optionally matching the message regex or error code. */
function expectErr<T>(r: ActionResult<T>, matcher?: RegExp | ActionErrorCode): void {
  expect(r.ok).toBe(false);
  if (!r.ok && matcher) {
    if (matcher instanceof RegExp) expect(r.error).toMatch(matcher);
    else expect(r.code).toBe(matcher);
  }
}

/** Assert an action succeeded; returns the data payload. */
function expectOk<T>(r: ActionResult<T>): T {
  expect(r.ok).toBe(true);
  return r.ok ? r.data : (undefined as unknown as T);
}

const ADMIN_AUTH = { userId: "u-admin", role: "ADMIN" as const, name: "Ada Admin", email: "ada@x.co" };
const MANAGER_AUTH = { userId: "u-max", role: "MANAGER" as const, name: "Max Manager", email: "max@x.co" };
const MEMBER_AUTH = { userId: "u-mia", role: "MEMBER" as const, name: "Mia Member", email: "mia@x.co" };

beforeEach(() => {
  vi.clearAllMocks();
  getSessionMock.mockResolvedValue(ADMIN_AUTH);
  requirePermissionMock.mockResolvedValue(ADMIN_AUTH);
  // ADMIN → unscoped (mirrors the real getScopedProjectIds contract).
  getScopedProjectIdsMock.mockResolvedValue(null);
  getWorkspaceLimitMock.mockResolvedValue(20);
  // Default every findMany to an empty result — a bare vi.fn() resolves
  // undefined and the loader's .map()s would crash on it. Tests override
  // only the queries they exercise.
  for (const m of Object.keys(db)) db[m].findMany?.mockResolvedValue([]);
  // Transaction-side counters used by createRole / deleteConfigItem.
  db.role.count.mockResolvedValue(0);
  db.task.count.mockResolvedValue(0);
});

// ---------------------------------------------------------------------------
// dashboard.ts
// ---------------------------------------------------------------------------

describe("dashboard.ts — uncovered branch coverage (PR-56-DW)", () => {
  const T0 = new Date("2026-01-05T08:00:00Z");

  // Minimal valid rows for every model the admin dashboard loader queries.
  const projectRow = {
    id: "p-1", name: "Apollo", description: "Flagship", status: "RUNNING",
    priority: "HIGH", color: "forest", dueDate: null, ownerName: "Ada",
    ownerUserId: "u-1", progress: 40, createdAt: T0, updatedAt: T0,
  };
  const memberRow = {
    id: "m-1", userId: "u-1", name: "Ada Lovelace", email: "ada@x.co",
    role: "Developer", department: "ENGINEERING", avatarColor: "forest",
    online: true, openTasks: 2, completedTasks: 5, workload: 33,
    createdAt: T0, updatedAt: T0,
  };
  const taskRow = (over: Record<string, unknown> = {}) => ({
    id: "t-1", title: "Ship the board", description: "", status: "TODO",
    priority: "HIGH", tag: "QA", dueDate: null, projectId: "p-1",
    assigneeId: "m-1", order: 0, createdAt: T0, updatedAt: T0,
    project: null, assignee: null,
    ...over,
  });
  const leaveRow = (over: Record<string, unknown> = {}) => ({
    id: "lr-1", userId: "u-1", leaveTypeId: "lt-1", days: 1,
    status: "APPROVED", startDate: T0, endDate: T0, createdAt: T0,
    ...over,
  });

  /** Wire every dashboard query with a safe one-row (or empty) result. */
  function wireAdminDashboard() {
    db.project.findMany.mockResolvedValue([projectRow]);
    db.task.findMany.mockResolvedValue([]);
    db.teamMember.findMany.mockResolvedValue([memberRow]);
    db.reminder.findMany.mockResolvedValue([
      { id: "r-1", title: "Book retro", done: false, ownerId: "u-admin", dueDate: T0, createdAt: T0 },
    ]);
    db.notification.findMany.mockResolvedValue([
      { id: "n-1", title: "Welcome", message: "hi", type: "INFO", read: false, recipientUserId: "u-admin", createdAt: T0 },
    ]);
    db.timeEntry.findMany.mockResolvedValue([]);
    db.calendarEvent.findMany.mockResolvedValue([
      { id: "ev-1", title: "Sprint review", description: "", date: T0, time: "14:00", durationMin: 60, type: "MEETING", location: "Zoom", createdAt: T0 },
    ]);
    db.leaveRequest.findMany.mockResolvedValue([]);
    db.message.findMany.mockResolvedValue([
      {
        id: "msg-1", direction: "OUT", threadId: "th-1", memberId: null,
        senderUserId: "u-oli", recipientUserId: "u-admin", senderName: "Oli",
        senderAvatarColor: "plum", senderRole: "", recipientName: "Ada",
        subject: "hi", body: "yo", read: false, createdAt: T0, readBy: [],
      },
    ]);
    db.bug.findMany.mockResolvedValue([]);
    db.user.findMany.mockResolvedValue([]);
    db.leaveType.findMany.mockResolvedValue([]);
  }

  describe("getDashboardData — leave events, bug counts, spent hours", () => {
    it("merges approved leave into the event feed as virtual LEAVE events, with fallbacks for unknown users/types (L264, L272-291)", async () => {
      // Uncovered branches pinned here:
      //   • L264  — the approvedLeave filter callback never ran (no leave rows
      //             were ever returned by existing suites).
      //   • L272-281 — the leaveUsers/leaveTypes lookups + name/type maps.
      //   • L283-291 — leave-event construction, including the
      //     `nameById.get(...) ?? "Member"` / `typeById.get(...)?.name ?? "Leave"`
      //     fallbacks and both sides of the `days === 1` description ternary.
      wireAdminDashboard();
      // Two approved leave rows that survive the visibility filter
      // (u-1 is on the member list, u-admin is always visible to themself):
      //   lr-1 → user + type both resolvable (happy path)
      //   lr-2 → user row missing from the lookup + unknown leaveTypeId
      //          (pins the defensive "Member — Leave" fallbacks)
      db.leaveRequest.findMany.mockResolvedValue([
        leaveRow(),
        leaveRow({ id: "lr-2", userId: "u-admin", leaveTypeId: "lt-x", days: 2.5 }),
      ]);
      // The leave-user lookup returns ONLY u-1 — u-admin is absent, so lr-2
      // must fall back to the generic "Member" label.
      db.user.findMany.mockResolvedValue([{ id: "u-1", name: "Ada Lovelace" }]);
      db.leaveType.findMany.mockResolvedValue([{ id: "lt-1", name: "Vacation", color: "forest" }]);

      const data = await getDashboardData();

      const leaveEvents = data.events.filter((e) => e.id.startsWith("leave-"));
      expect(leaveEvents).toHaveLength(2);

      const ev1 = leaveEvents.find((e) => e.id === "leave-lr-1")!;
      expect(ev1.title).toBe("Ada Lovelace — Vacation");
      expect(ev1.description).toBe("1 working day"); // days === 1 branch
      expect(ev1.time).toBe("09:00");
      expect(ev1.durationMin).toBe(480);
      expect(ev1.type).toBe("LEAVE");
      expect(ev1.location).toBe("");

      const ev2 = leaveEvents.find((e) => e.id === "leave-lr-2")!;
      expect(ev2.title).toBe("Member — Leave"); // both fallbacks fire
      expect(ev2.description).toBe("2.5 working days"); // days !== 1 branch
      expect(ev2.durationMin).toBe(1200); // Math.round(2.5 * 480)

      // The regular calendar event is still in the feed alongside the two
      // virtual leave events.
      expect(data.events).toHaveLength(3);
      expect(data.events.some((e) => e.id === "ev-1")).toBe(true);

      // The leave-user lookup is keyed on the deduplicated leave user ids.
      expect(db.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: { in: ["u-1", "u-admin"] } },
          select: { id: true, name: true },
        }),
      );
      expect(db.leaveType.findMany).toHaveBeenCalledWith(
        { select: { id: true, name: true, color: true } },
      );
    });

    it("counts linked bugs per task and skips links with a null taskId (L241)", async () => {
      // Uncovered branch pinned here: the bugCountByTask loop body — existing
      // suites never returned bug-link rows, so the aggregation never ran.
      wireAdminDashboard();
      db.task.findMany.mockResolvedValue([taskRow(), taskRow({ id: "t-2", title: "Second task" })]);
      // t-1 is linked twice (exercises the (count ?? 0) + 1 accumulation),
      // t-2 once, and one row has a null taskId (the `if (link.taskId)`
      // false branch — the link is skipped, not counted).
      db.bug.findMany.mockResolvedValue([
        { taskId: "t-1" },
        { taskId: "t-1" },
        { taskId: "t-2" },
        { taskId: null },
      ]);

      const data = await getDashboardData();

      expect(data.tasks[0].bugCount).toBe(2);
      expect(data.tasks[1].bugCount).toBe(1);
    });

    it("aggregates per-task spent hours from the timeEntries relation (L327)", async () => {
      // Uncovered branch pinned here: the spentHours reduce callback — the
      // include only ever produced empty/absent timeEntries before, so the
      // summation arrow never executed.
      wireAdminDashboard();
      db.task.findMany.mockResolvedValue([
        taskRow({ timeEntries: [{ hours: 1.5 }, { hours: 2 }] }),
        taskRow({ id: "t-2", title: "No logged time" }), // no relation → ?? [] fallback
      ]);

      const data = await getDashboardData();

      // Math.round((1.5 + 2) * 10) / 10 === 3.5
      expect(data.tasks[0].spentHours).toBe(3.5);
      expect(data.tasks[1].spentHours).toBe(0);
      // The raw timeEntries relation is stripped from the client payload.
      expect(data.tasks[0]).not.toHaveProperty("timeEntries");
    });
  });

  describe("getProjectMembers — session and scope guards", () => {
    it("rejects anonymous callers before touching the DB (L464)", async () => {
      // Uncovered branch pinned here: the `if (!auth) throw` guard — every
      // existing suite called getProjectMembers signed in.
      getSessionMock.mockResolvedValue(null);

      const res = await getProjectMembers("p-1");

      expectErr(res, "AUTH");
      expectErr(res, /must be signed in/i);
      expect(db.project.findUnique).not.toHaveBeenCalled();
    });

    it("returns [] for a project outside the caller's scope (L476)", async () => {
      // Uncovered branch pinned here: the F-03 scope guard — a MEMBER asking
      // for the roster of a project they cannot see gets an empty list and
      // the roster queries never fire.
      getSessionMock.mockResolvedValue(MEMBER_AUTH);
      db.project.findUnique.mockResolvedValue({
        id: "p-1", name: "Apollo", ownerUserId: "u-ada", deletedAt: null,
      });
      getScopedProjectIdsMock.mockResolvedValue(new Set(["p-other"]));

      const res = await getProjectMembers("p-1");

      expect(expectOk(res)).toEqual([]);
      expect(db.projectAssignment.findMany).not.toHaveBeenCalled();
      expect(db.teamMember.findMany).not.toHaveBeenCalled();
    });

    it("returns the roster for a project inside the caller's scope (companion to L476)", async () => {
      // Companion branch: the same guard with a NON-empty scope that DOES
      // contain the project — the read proceeds to the roster queries. Pins
      // that scoped roles can enumerate exactly the rosters they can see.
      getSessionMock.mockResolvedValue(MEMBER_AUTH);
      db.project.findUnique.mockResolvedValue({
        id: "p-1", name: "Apollo", ownerUserId: "u-ada", deletedAt: null,
      });
      getScopedProjectIdsMock.mockResolvedValue(new Set(["p-1"]));
      db.projectAssignment.findMany.mockResolvedValue([{ userId: "u-mia" }]);
      const rosterMember = (id: string, name: string, userId: string) => ({
        id, name, userId, email: `${name.toLowerCase()}@x.co`, role: "Developer",
        department: "ENGINEERING", avatarColor: "plum", online: false,
        openTasks: 1, completedTasks: 0, workload: 17, createdAt: T0, updatedAt: T0,
      });
      db.teamMember.findMany.mockResolvedValue([
        rosterMember("m-mia", "Mia", "u-mia"),
        rosterMember("m-ada", "Ada", "u-ada"),
      ]);

      const roster = expectOk(await getProjectMembers("p-1"));

      // Explicitly staffed (u-mia) + the owner (u-ada).
      expect(db.teamMember.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: { in: ["u-mia", "u-ada"] }, deletedAt: null },
        }),
      );
      expect(roster).toHaveLength(2);
      expect(roster.find((m) => m.name === "Ada")!.isOwner).toBe(true);
      expect(roster.find((m) => m.name === "Mia")!.isOwner).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// workspace.ts
// ---------------------------------------------------------------------------

describe("workspace.ts — uncovered branch coverage (PR-56-DW)", () => {
  describe("deleteConfigItem — usage guard", () => {
    it("rejects deleting a config item that no longer exists (L146)", async () => {
      // Uncovered branch pinned here: `if (!configRow) throw` — existing
      // suites only exercised the permission-rejected and happy paths.
      db.taskStatusConfig.findUnique.mockResolvedValue(null);

      const res = await deleteConfigItem("taskStatusConfig", "cfg-ghost");

      expectErr(res, /config item not found/i);
      // The usage count never runs and nothing is deleted or audited.
      expect(db.task.count).not.toHaveBeenCalled();
      expect(db.taskStatusConfig.delete).not.toHaveBeenCalled();
      expect(logAuditMock).not.toHaveBeenCalled();
    });

    it("refuses to delete a config key that tasks still reference (L153-155)", async () => {
      // Uncovered branch pinned here: the in-use refusal — deleting a
      // TaskStatus that dependent rows still reference would orphan them.
      db.taskStatusConfig.findUnique.mockResolvedValue({ key: "DONE" });
      db.task.count.mockResolvedValue(4);

      const res = await deleteConfigItem("taskStatusConfig", "cfg-1");

      expectErr(res, /4 tasks still use "DONE"/i);
      // The usage count is keyed on the config row's key → dependent column.
      expect(db.task.count).toHaveBeenCalledWith({ where: { status: "DONE" } });
      expect(db.taskStatusConfig.delete).not.toHaveBeenCalled();
      expect(logAuditMock).not.toHaveBeenCalled();
    });
  });

  describe("updateRole — guards", () => {
    it("rejects updating a role that does not exist (L184)", async () => {
      // Uncovered branch pinned here: `if (!role) throw` — every existing
      // updateRole test supplied a role row.
      db.role.findUnique.mockResolvedValue(null);

      const res = await updateRole("r-ghost", { label: "Ghost" });

      expectErr(res, /role not found/i);
      expect(db.role.update).not.toHaveBeenCalled();
    });

    it("blocks a non-ADMIN role:manage holder from granting role:manage (L210-215)", async () => {
      // Uncovered branch pinned here: the privilege-escalation guard inside
      // the permission-replacement transaction. A MANAGER who was granted
      // role:manage out-of-band (via the DB RBAC editor) must not be able to
      // hand that permission to another role.
      requirePermissionMock.mockResolvedValue(MANAGER_AUTH);
      db.role.findUnique.mockResolvedValue({ id: "r-1", key: "CONTRACTOR", label: "Contractor" });
      db.role.update.mockResolvedValue({});

      const res = await updateRole("r-1", { permissions: ["role:manage", "task:create"] });

      expectErr(res, /only admin may grant: role:manage/i);
      // The atomic permission replacement never starts, nothing is audited.
      expect(db.rolePermission.deleteMany).not.toHaveBeenCalled();
      expect(db.rolePermission.createMany).not.toHaveBeenCalled();
      expect(logAuditMock).not.toHaveBeenCalled();
    });
  });

  describe("createRole — protected-permission guard", () => {
    it("blocks a non-ADMIN role:manage holder from minting a role that grants role:manage (L276-281)", async () => {
      // Uncovered branch pinned here: the same protected-permission guard as
      // updateRole, but on the create path — the guard fires inside the
      // creation transaction, after the role row create, before the grants.
      requirePermissionMock.mockResolvedValue(MANAGER_AUTH);
      db.role.findUnique.mockResolvedValue(null); // key not taken
      db.role.create.mockResolvedValue({ id: "r-new", key: "INTERN", label: "Intern" });
      db.role.count.mockResolvedValue(3);

      const res = await createRole({ key: "INTERN", label: "Intern", permissions: ["role:manage"] });

      expectErr(res, /only admin may grant: role:manage/i);
      // No permission grants were written and nothing was audited.
      expect(db.rolePermission.createMany).not.toHaveBeenCalled();
      expect(logAuditMock).not.toHaveBeenCalled();
    });
  });

  describe("deleteRole — not-found guard", () => {
    it("rejects deleting a role that does not exist (L310)", async () => {
      // Uncovered branch pinned here: `if (!role) throw` — existing suites
      // covered the system-role and in-use refusals but never a missing row.
      db.role.findUnique.mockResolvedValue(null);

      const res = await deleteRole("r-ghost");

      expectErr(res, /role not found/i);
      expect(db.user.count).not.toHaveBeenCalled();
      expect(db.role.delete).not.toHaveBeenCalled();
    });
  });
});
