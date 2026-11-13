import { describe, it, expect, vi, beforeEach } from "vitest";

// PR-56 — remaining branch coverage across the smaller server-action
// modules: the not-found no-ops (F-15), change-detection audit arms, the
// leave-day time guard, the trash restore guards, mention opt-out, and the
// shared.ts visibility helpers' remaining arrows. Each test names the line
// range it pins in its comment.

const db = vi.hoisted(() => {
  const models = [
    "auditLog", "notification", "reminder", "message", "messageRead",
    "teamMember", "timeEntry", "task", "user", "project", "projectAssignment",
    "workspace",
  ];
  const methods = ["findUnique", "findFirst", "findMany", "create", "update", "updateMany", "delete", "deleteMany", "count", "createMany"];
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

// hr-shared is mocked only for findApprovedLeaveOn (the HR time guard the
// logTime tests drive); everything else in this file uses the REAL
// shared.ts (logAudit, getMyTeamMemberId, getVisibleMemberIds, …).
const findApprovedLeaveOnMock = vi.fn();
vi.mock("@/server-actions/hr-shared", () => ({
  findApprovedLeaveOn: (...a: unknown[]) => findApprovedLeaveOnMock(...a),
}));

vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { getAuditLogs, getAuditLogsForEntity } from "../audit";
import { markNotificationRead } from "../notifications";
import { toggleReminder } from "../reminders";
import { markThreadRead } from "../messages";
import { updateMember } from "../members";
import { logTime, getTaskTimeLog } from "../time-entries";
import { getTrash, restoreProject, restoreMessage } from "../trash";
import { notifyMentionedUsers } from "../mentions";
import { updateTask, moveTask, deleteTask } from "../tasks";
import { getProjectAssignments } from "../assignments";
import { getProjectsPage, getTimeEntriesPage } from "../pagination";
import {
  getVisibleMemberIds,
  getProjectAssociatedUserIds,
  assertUserAssociatedWithProject,
} from "../shared";

const ADMIN = { userId: "u-admin", role: "ADMIN" as const, name: "Admin", email: "a@x.co" };
const MEMBER = { userId: "u-mia", role: "MEMBER" as const, name: "Mia", email: "mia@x.co" };

beforeEach(() => {
  vi.clearAllMocks();
  getSessionMock.mockResolvedValue(MEMBER);
  getSessionOrThrowMock.mockResolvedValue(MEMBER);
  requirePermissionMock.mockResolvedValue(ADMIN);
  // Real shared.ts helpers: sensible empty-DB defaults, overridden per test.
  db.workspace.findFirst.mockResolvedValue(null);
  db.project.findMany.mockResolvedValue([]);
  db.task.findMany.mockResolvedValue([]);
  db.projectAssignment.findMany.mockResolvedValue([]);
  db.teamMember.findUnique.mockResolvedValue(null);
  db.teamMember.findMany.mockResolvedValue([]);
});

// ---------------------------------------------------------------------------
// audit.ts — L40-43 (getAuditLogs success mapping), L80 (restricted entity
// type), L90-93 (getAuditLogsForEntity success mapping).
// ---------------------------------------------------------------------------

describe("PR-56 audit.ts branch coverage", () => {
  it("getAuditLogs maps rows with ISO createdAt (L40-43)", async () => {
    db.auditLog.findMany.mockResolvedValue([
      { id: "al-1", actorName: "Ada", action: "task.updated", detail: "d", createdAt: new Date("2026-11-01T10:00:00Z") },
    ]);
    const res = await getAuditLogs();
    if (!res.ok) throw new Error("expected ok");
    expect(res.data).toHaveLength(1);
    expect(res.data[0].createdAt).toBe("2026-11-01T10:00:00.000Z");
  });

  it("getAuditLogsForEntity rejects a personal-data entity type for a MEMBER (L80)", async () => {
    // USER audit rows carry emails in their detail lines — F-03 gates them
    // behind audit:view (MANAGER+). A MEMBER must be rejected.
    const res = await getAuditLogsForEntity("USER", "u-1");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("AUTH");
    expect(res.error).toContain("tasks, projects and team entities");
    expect(db.auditLog.findMany).not.toHaveBeenCalled();
  });

  it("getAuditLogsForEntity maps rows for an open entity type (L90-93)", async () => {
    db.auditLog.findMany.mockResolvedValue([
      { id: "al-2", action: "task.updated", detail: "d", createdAt: new Date("2026-11-02T10:00:00Z") },
    ]);
    const res = await getAuditLogsForEntity("TASK", "t-1");
    if (!res.ok) throw new Error("expected ok");
    expect(res.data[0].createdAt).toBe("2026-11-02T10:00:00.000Z");
    expect(db.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { entityType: "TASK", entityId: "t-1" } }),
    );
  });
});

// ---------------------------------------------------------------------------
// notifications.ts L25 / reminders.ts L31 — not-found no-ops.
// ---------------------------------------------------------------------------

describe("PR-56 not-found no-ops (F-15)", () => {
  it("markNotificationRead on a missing id is a clean no-op (L25)", async () => {
    db.notification.findUnique.mockResolvedValue(null);
    const res = await markNotificationRead("n-missing", true);
    expect(res.ok).toBe(true);
    expect(db.notification.update).not.toHaveBeenCalled();
  });

  it("toggleReminder on a missing id is a clean no-op (L31)", async () => {
    db.reminder.findUnique.mockResolvedValue(null);
    const res = await toggleReminder("r-missing", true);
    expect(res.ok).toBe(true);
    expect(db.reminder.update).not.toHaveBeenCalled();
  });

  it("markThreadRead with zero unread messages writes nothing (messages.ts L145)", async () => {
    db.message.findMany.mockResolvedValue([]);
    const res = await markThreadRead("th-1");
    expect(res.ok).toBe(true);
    expect(db.messageRead.createMany).not.toHaveBeenCalled();
  });

  it("updateMember on a missing id is a clean no-op (members.ts L76)", async () => {
    db.teamMember.findUnique.mockResolvedValue(null);
    const res = await updateMember("tm-missing", { name: "X" });
    expect(res.ok).toBe(true);
    expect(db.teamMember.update).not.toHaveBeenCalled();
  });

  it("moveTask on a missing id is a clean no-op (tasks.ts L225)", async () => {
    db.task.findUnique.mockResolvedValue(null);
    const res = await moveTask("t-missing", "TODO", 0);
    expect(res.ok).toBe(true);
    expect(db.task.update).not.toHaveBeenCalled();
  });

  it("deleteTask on a missing id is a clean no-op (tasks.ts L253)", async () => {
    db.task.findUnique.mockResolvedValue(null);
    const res = await deleteTask("t-missing");
    expect(res.ok).toBe(true);
    expect(db.task.delete).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// members.ts L82 — the `online` (availability) change-detection arm.
// ---------------------------------------------------------------------------

describe("PR-56 updateMember change detection", () => {
  it("lists availability in the audit detail when `online` flips (L82)", async () => {
    db.teamMember.findUnique.mockResolvedValue({
      id: "tm-1", name: "Ada", role: "Dev", department: "Eng",
      email: "ada@x.co", online: false,
    });
    const res = await updateMember("tm-1", { online: true });
    expect(res.ok).toBe(true);
    expect(db.teamMember.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "tm-1" }, data: { online: true } }),
    );
    // The audit row names the availability change, not just "Saved profile"
    // (logAudit is the real shared.ts helper — assert at its db write).
    expect(db.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ detail: expect.stringContaining("availability") }) }),
    );
  });

  it("lists email in the audit detail when the roster email changes (L82 email arm)", async () => {
    db.teamMember.findUnique.mockResolvedValue({
      id: "tm-2", name: "Grace", role: "Dev", department: "Eng",
      email: "old@x.co", online: true,
    });
    const res = await updateMember("tm-2", { email: "new@x.co" });
    expect(res.ok).toBe(true);
    expect(db.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ detail: expect.stringContaining("email") }) }),
    );
  });
});

// ---------------------------------------------------------------------------
// time-entries.ts L43-45 (approved-leave rejection) + L162 (unknown task).
// ---------------------------------------------------------------------------

describe("PR-56 time-entries branch coverage", () => {
  it("logTime rejects hours on a day the user is on approved leave (L43-45)", async () => {
    db.teamMember.findUnique.mockResolvedValue({ id: "tm-1" }); // getMyTeamMemberId
    findApprovedLeaveOnMock.mockResolvedValue({ typeName: "Annual leave" });
    const res = await logTime({ projectId: "p-1", date: "2026-11-03", hours: 2 });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("AUTH");
    expect(res.error).toContain("Annual leave");
    expect(res.error).toContain("2026-11-03");
    expect(db.timeEntry.create).not.toHaveBeenCalled();
  });

  it("getTaskTimeLog rejects an unknown task id (L162)", async () => {
    db.task.findUnique.mockResolvedValue(null);
    const res = await getTaskTimeLog("t-missing");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("AUTH");
    expect(res.error).toContain("Task not found");
  });
});

// ---------------------------------------------------------------------------
// trash.ts — L77-83 (deleted messages in the trash listing), L101
// (restoreProject guards), L188-191 (restoreMessage guards).
// ---------------------------------------------------------------------------

describe("PR-56 trash branch coverage", () => {
  it("getTrash lists soft-deleted messages with sender sublabels (L77-83)", async () => {
    const when = new Date("2026-11-01T09:00:00Z");
    db.project.findMany.mockResolvedValue([]);
    db.user.findMany.mockResolvedValue([]);
    db.message.findMany.mockResolvedValue([
      { id: "m-1", subject: "Weekly sync", senderName: "Ada", deletedAt: when },
    ]);
    const res = await getTrash();
    if (!res.ok) throw new Error("expected ok");
    expect(res.data).toEqual([
      {
        id: "m-1",
        label: "Weekly sync",
        sublabel: "Message · from Ada",
        kind: "message",
        deletedAt: when.toISOString(),
      },
    ]);
  });

  it("restoreProject rejects an unknown project (L101)", async () => {
    db.project.findUnique.mockResolvedValue(null);
    const res = await restoreProject("p-missing");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("Project not found");
  });

  it("restoreProject rejects a project that is not in the trash", async () => {
    db.project.findUnique.mockResolvedValue({ id: "p-1", deletedAt: null });
    const res = await restoreProject("p-1");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("not in the trash");
  });

  it("restoreMessage rejects an unknown message (L190)", async () => {
    db.message.findUnique.mockResolvedValue(null);
    const res = await restoreMessage("m-missing");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("Message not found");
  });

  it("restoreMessage rejects a message that is not in the trash (L191)", async () => {
    db.message.findUnique.mockResolvedValue({
      id: "m-1", deletedAt: null, senderUserId: "u-mia", recipientUserId: "u-ada",
    });
    const res = await restoreMessage("m-1");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("not in the trash");
  });

  it("restoreMessage requires a signed-in session (L188)", async () => {
    getSessionMock.mockResolvedValue(null);
    const res = await restoreMessage("m-1");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("AUTH");
  });
});

// ---------------------------------------------------------------------------
// mentions.ts — L73 (notifMentions opt-out), L105 (self-mention skip),
// L106-107 (dedup + opt-out continues).
// ---------------------------------------------------------------------------

describe("PR-56 notifyMentionedUsers branch coverage", () => {
  const CTX = {
    text: "",
    actorUserId: "u-actor",
    actorName: "Actor",
    entityType: "TASK" as const,
    entityLabel: "T-1",
    detail: "changed the description",
  };

  it("skips a mentioned user who turned Mentions OFF (L73 + L107)", async () => {
    db.user.findMany.mockResolvedValue([
      { id: "u-ada", name: "Ada Lovelace", settings: { notifMentions: false } },
    ]);
    const notified = await notifyMentionedUsers({ ...CTX, text: "ping @Ada Lovelace" });
    expect(notified).toEqual([]);
    expect(db.notification.createMany).not.toHaveBeenCalled();
  });

  it("skips the actor mentioning themselves (L105)", async () => {
    db.user.findMany.mockResolvedValue([
      { id: "u-actor", name: "Ada Lovelace", settings: null },
    ]);
    const notified = await notifyMentionedUsers({ ...CTX, text: "note by @Ada Lovelace" });
    expect(notified).toEqual([]);
    expect(db.notification.createMany).not.toHaveBeenCalled();
  });

  it("notifies each distinct mentioned user exactly once (dedup, L106)", async () => {
    db.user.findMany.mockResolvedValue([
      { id: "u-ada", name: "Ada Lovelace", settings: { notifMentions: true } },
      { id: "u-grace", name: "Grace Hopper", settings: null },
    ]);
    const notified = await notifyMentionedUsers({
      ...CTX,
      text: "@Ada Lovelace and again @Ada Lovelace, plus @Grace Hopper",
    });
    expect(notified.sort()).toEqual(["u-ada", "u-grace"]);
    expect(db.notification.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({ recipientUserId: "u-ada", type: "MENTION" }),
        expect.objectContaining({ recipientUserId: "u-grace", type: "MENTION" }),
      ]),
    });
  });

  it("dedups two DIFFERENT mention strings that resolve to the same user (L105 notifiedSet)", async () => {
    // "@Ada Lovelace" (exact match) and a bare "@Ada" (unique first-word
    // match) both resolve to u-ada — the extraction-level dedup can't see
    // this (the strings differ), so the notifiedSet guard is the one that
    // must collapse them into a single notification.
    db.user.findMany.mockResolvedValue([
      { id: "u-ada", name: "Ada Lovelace", settings: { notifMentions: true } },
    ]);
    const notified = await notifyMentionedUsers({
      ...CTX,
      text: "ask @Ada Lovelace or just @Ada",
    });
    expect(notified).toEqual(["u-ada"]);
    expect(db.notification.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ recipientUserId: "u-ada" })],
    });
  });
});

// ---------------------------------------------------------------------------
// tasks.ts L203 — estimate change detection in the update audit row.
// ---------------------------------------------------------------------------

describe("PR-56 updateTask change detection", () => {
  it("lists estimate in the audit detail when estimateMinutes changes (L203)", async () => {
    db.task.findUnique.mockResolvedValue({
      id: "t-1", title: "Ship it", status: "TODO", priority: "HIGH", tag: "",
      dueDate: null, projectId: "p-1", assigneeId: null, estimateMinutes: 60,
      description: "",
    });
    const res = await updateTask("t-1", { estimateMinutes: 120 });
    expect(res.ok).toBe(true);
    // logAudit is the real shared.ts helper — assert at its db write.
    expect(db.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ detail: expect.stringContaining("estimate") }) }),
    );
  });
});

// ---------------------------------------------------------------------------
// assignments.ts L112 / pagination.ts L246 + L323 — the unauthenticated
// guards. These actions read the session FIRST and must reject with AUTH
// before touching any table.
// ---------------------------------------------------------------------------

describe("PR-56 unauthenticated guards", () => {
  beforeEach(() => {
    getSessionMock.mockResolvedValue(null);
    getSessionOrThrowMock.mockRejectedValue(Object.assign(new Error("You must be signed in."), { name: "AuthorizationError", digest: "AuthorizationError" }));
  });

  it("getProjectAssignments rejects an anonymous caller before any roster query (L112)", async () => {
    const res = await getProjectAssignments("p-1");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("AUTH");
    // The PII-bearing roster query never ran.
    expect(db.projectAssignment.findMany).not.toHaveBeenCalled();
  });

  it("getProjectsPage rejects an anonymous caller (L246)", async () => {
    const res = await getProjectsPage({});
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("AUTH");
    expect(db.project.findMany).not.toHaveBeenCalled();
  });

  it("getTimeEntriesPage rejects an anonymous caller (L323)", async () => {
    const res = await getTimeEntriesPage({});
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("AUTH");
    expect(db.timeEntry.findMany).not.toHaveBeenCalled();
  });
});

describe("PR-56 shared.ts helper branches", () => {
  it("getVisibleMemberIds resolves assignments then members through the three sources (L225)", async () => {
    // Scoped viewer with one project: assignment lookup returns a staffed
    // user id, then the member query returns the visible member rows.
    db.projectAssignment.findMany.mockResolvedValue([{ userId: "u-2" }]);
    db.teamMember.findMany.mockResolvedValue([{ id: "tm-1" }, { id: "tm-2" }]);
    const visible = await getVisibleMemberIds(
      { userId: "u-mia", role: "MEMBER" },
      new Set(["p-1"]),
    );
    expect(visible).toBeInstanceOf(Set);
    expect(Array.from(visible!).sort()).toEqual(["tm-1", "tm-2"]);
    // The assignment query was scoped to the viewer's projects.
    expect(db.projectAssignment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { projectId: { in: ["p-1"] } } }),
    );
    // And the member query consulted both sources + the viewer themself.
    const memberWhere = db.teamMember.findMany.mock.calls[0][0].where;
    expect(memberWhere.OR).toEqual([
      { tasks: { some: { projectId: { in: ["p-1"] } } } },
      { userId: { in: ["u-2"] } },
      { userId: "u-mia" },
    ]);
  });

  it("getProjectAssociatedUserIds unions assignments with the project owner (L277-278)", async () => {
    db.project.findUnique.mockResolvedValue({ ownerUserId: "u-own", deletedAt: null });
    db.projectAssignment.findMany.mockResolvedValue([{ userId: "u-a" }, { userId: "u-b" }]);
    const ids = await getProjectAssociatedUserIds("p-1");
    expect(Array.from(ids ?? []).sort()).toEqual(["u-a", "u-b", "u-own"]);
  });

  it("getProjectAssociatedUserIds with no owner returns assignments only", async () => {
    db.project.findUnique.mockResolvedValue({ ownerUserId: null, deletedAt: null });
    db.projectAssignment.findMany.mockResolvedValue([{ userId: "u-a" }]);
    const ids = await getProjectAssociatedUserIds("p-2");
    expect(Array.from(ids ?? [])).toEqual(["u-a"]);
  });

  it("assertUserAssociatedWithProject rejects an unknown project (L291)", async () => {
    db.project.findUnique.mockResolvedValue(null);
    await expect(
      assertUserAssociatedWithProject("u-1", "p-missing"),
    ).rejects.toThrow("Project not found");
  });
});
