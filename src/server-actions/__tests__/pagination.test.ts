import { describe, it, expect, vi, beforeEach } from "vitest";

// L-P0-9 — paginated list actions.

const db = vi.hoisted(() => {
  const models = ["user", "task", "project", "timeEntry", "projectAssignment", "teamMember"];
  const methods = ["findMany", "findUnique", "findFirst", "create", "update", "updateMany", "delete", "deleteMany", "count", "aggregate"];
  const obj: Record<string, Record<string, ReturnType<typeof vi.fn>>> = {};
  for (const m of models) {
    obj[m] = {};
    for (const meth of methods) obj[m][meth] = vi.fn();
  }
  return obj;
});

vi.mock("@/lib/db", () => ({ db }));

const requirePermissionMock = vi.fn();
const getSessionMock = vi.fn();
vi.mock("@/server-actions/auth-guard", () => ({
  requirePermission: (...a: unknown[]) => requirePermissionMock(...a),
  getSession: () => getSessionMock(),
  AuthorizationError: class AuthorizationError extends Error {
    readonly digest = "AuthorizationError";
    constructor(m: string) { super(m); this.name = "AuthorizationError"; }
  },
}));

import {
  getUsersPage,
  getTasksPage,
  getProjectsPage,
  getTimeEntriesPage,
} from "../pagination";

const ADMIN_AUTH = { userId: "u-admin", role: "ADMIN" as const, name: "Admin", email: "a@x" };
const MEMBER_AUTH = { userId: "u-mem", role: "MEMBER" as const, name: "Mem", email: "m@x" };

beforeEach(() => {
  vi.clearAllMocks();
  requirePermissionMock.mockResolvedValue(ADMIN_AUTH);
  getSessionMock.mockResolvedValue(ADMIN_AUTH);
  for (const m of Object.values(db)) {
    for (const fn of Object.values(m)) fn.mockResolvedValue([]);
  }
});

function mockRows(count: number, extra: Record<string, unknown> = {}) {
  const rows = [];
  for (let i = 0; i < count; i++) {
    rows.push({ id: `id-${i}`, createdAt: new Date("2026-01-01"), ...extra });
  }
  return rows;
}

describe("L-P0-9 getUsersPage (cursor pagination + search)", () => {
  it("returns the first page with nextCursor when there are more rows", async () => {
    db.user.findMany.mockResolvedValue(mockRows(11, {
      email: "a@b.co", name: "A", role: "MEMBER", avatarColor: "forest",
      managerId: null, manager: null,
    }));
    const res = await getUsersPage({ limit: 10 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.items.length).toBe(10);
    expect(res.data.hasMore).toBe(true);
    expect(res.data.nextCursor).toBe("id-9");
  });

  it("returns the last page with nextCursor=null when there are no more rows", async () => {
    db.user.findMany.mockResolvedValue(mockRows(5, {
      email: "a@b.co", name: "A", role: "MEMBER", avatarColor: "forest",
      managerId: null, manager: null,
    }));
    const res = await getUsersPage({ limit: 10 });
    if (!res.ok) throw new Error("expected ok");
    expect(res.data.items.length).toBe(5);
    expect(res.data.hasMore).toBe(false);
    expect(res.data.nextCursor).toBeNull();
  });

  it("passes the cursor through to Prisma's cursor+skip idiom", async () => {
    db.user.findMany.mockResolvedValue([]);
    // P2 (edge-case audit) — safeCursor requires 20-32 char alphanumeric.
    const validCursor = "c".repeat(24); // 24-char cuid-like string
    await getUsersPage({ cursor: validCursor, limit: 10 });
    const call = db.user.findMany.mock.calls[0][0];
    expect(call.cursor).toEqual({ id: validCursor });
    expect(call.skip).toBe(1);
    expect(call.take).toBe(11);
  });

  it("P2 edge-case: rejects a malformed cursor (too short) and returns the first page", async () => {
    db.user.findMany.mockResolvedValue([]);
    await getUsersPage({ cursor: "id-99", limit: 10 }); // too short → safeCursor returns null
    const call = db.user.findMany.mock.calls[0][0];
    expect(call.cursor).toBeUndefined(); // no cursor → first page
    expect(call.skip).toBeUndefined();
  });

  it("P2 edge-case: rejects a non-alphanumeric cursor", async () => {
    db.user.findMany.mockResolvedValue([]);
    await getUsersPage({ cursor: "c".repeat(20) + "!@#", limit: 10 });
    const call = db.user.findMany.mock.calls[0][0];
    expect(call.cursor).toBeUndefined();
  });

  it("applies the soft-delete filter (deletedAt: null) — L-P0-14", async () => {
    db.user.findMany.mockResolvedValue([]);
    await getUsersPage();
    expect(db.user.findMany.mock.calls[0][0].where.deletedAt).toBeNull();
  });

  it("applies the search filter as case-insensitive ILIKE on name + email", async () => {
    db.user.findMany.mockResolvedValue([]);
    await getUsersPage({ search: "Ada" });
    const call = db.user.findMany.mock.calls[0][0];
    expect(call.where.OR).toEqual([
      { name: { contains: "ada", mode: "insensitive" } },
      { email: { contains: "ada", mode: "insensitive" } },
    ]);
  });

  it("clamps limit to the 200 max", async () => {
    db.user.findMany.mockResolvedValue([]);
    await getUsersPage({ limit: 9999 });
    expect(db.user.findMany.mock.calls[0][0].take).toBe(201);
  });

  it("defaults to 50 when no limit is provided", async () => {
    db.user.findMany.mockResolvedValue([]);
    await getUsersPage();
    expect(db.user.findMany.mock.calls[0][0].take).toBe(51);
  });

  it("requires role:manage permission (admin-only, like getAllUsers)", async () => {
    requirePermissionMock.mockRejectedValue(new Error("no perm"));
    const res = await getUsersPage();
    expect(res.ok).toBe(false);
  });
});

describe("L-P0-9 getTasksPage (cursor pagination + search + filters)", () => {
  beforeEach(() => {
    getSessionMock.mockResolvedValue(MEMBER_AUTH);
  });

  it("returns a paginated page with nextCursor", async () => {
    db.task.findMany.mockResolvedValue(mockRows(11, {
      title: "T", status: "TODO", priority: "MEDIUM", tag: "FRONTEND",
      dueDate: null, projectId: "p-1", assigneeId: null,
      project: { name: "P1" }, assignee: null,
    }));
    const res = await getTasksPage({ limit: 10 });
    if (!res.ok) throw new Error("expected ok");
    expect(res.data.items.length).toBe(10);
    expect(res.data.hasMore).toBe(true);
    expect(res.data.nextCursor).toBe("id-9");
  });

  it("applies the soft-delete filter on the project relation — L-P0-14", async () => {
    db.task.findMany.mockResolvedValue([]);
    await getTasksPage();
    // .at(-1): getScopedProjectIds also calls db.task.findMany (F-03).
    expect(db.task.findMany.mock.calls.at(-1)![0].where.project).toEqual({ deletedAt: null });
  });

  it("applies the search filter on title + description", async () => {
    db.task.findMany.mockResolvedValue([]);
    await getTasksPage({ search: "login" });
    const call = db.task.findMany.mock.calls.at(-1)![0];
    // MEMBER is signed in, so the scope condition lands in AND[0] and the
    // search condition in AND[1] (deep-dive review F-03).
    expect(call.where.AND[1].OR).toEqual([
      { title: { contains: "login", mode: "insensitive" } },
      { description: { contains: "login", mode: "insensitive" } },
    ]);
  });

  it("scopes tasks to the caller's projects for MEMBER/MANAGER (F-03)", async () => {
    db.project.findMany.mockImplementation(({ where }: { where?: { ownerUserId?: string } }) =>
      Promise.resolve(where?.ownerUserId ? [{ id: "p-owned" }] : []));
    db.task.findMany.mockResolvedValue([]);
    await getTasksPage();
    const call = db.task.findMany.mock.calls.at(-1)![0];
    expect(call.where.AND[0].OR).toEqual([
      { projectId: { in: ["p-owned"] } },
      { assignee: { userId: MEMBER_AUTH.userId } },
    ]);
  });

  it("does NOT scope tasks for ADMIN (F-03)", async () => {
    getSessionMock.mockResolvedValue(ADMIN_AUTH);
    db.task.findMany.mockResolvedValue([]);
    await getTasksPage({ search: "login" });
    const call = db.task.findMany.mock.calls.at(-1)![0];
    // Unscoped: no project-scope condition — only the search condition,
    // which lands as a single AND entry (equivalent to a top-level OR).
    expect(call.where.AND).toHaveLength(1);
    expect(call.where.AND[0].OR).toEqual([
      { title: { contains: "login", mode: "insensitive" } },
      { description: { contains: "login", mode: "insensitive" } },
    ]);
  });

  it("passes projectId and status filters through to the where clause", async () => {
    db.task.findMany.mockResolvedValue([]);
    await getTasksPage({ projectId: "p-1", status: "DONE" });
    const call = db.task.findMany.mock.calls.at(-1)![0];
    expect(call.where.projectId).toBe("p-1");
    expect(call.where.status).toBe("DONE");
  });

  it("requires a signed-in session", async () => {
    getSessionMock.mockResolvedValue(null);
    const res = await getTasksPage();
    expect(res.ok).toBe(false);
  });
});

describe("L-P0-9 getProjectsPage (cursor pagination + search)", () => {
  it("returns a paginated page", async () => {
    db.project.findMany.mockResolvedValue(mockRows(11, {
      name: "P", status: "RUNNING", priority: "MEDIUM", dueDate: null,
      progress: 0, color: "forest", ownerName: "O",
    }));
    const res = await getProjectsPage({ limit: 10 });
    if (!res.ok) throw new Error("expected ok");
    expect(res.data.items.length).toBe(10);
    expect(res.data.hasMore).toBe(true);
  });

  it("applies the soft-delete filter (deletedAt: null)", async () => {
    db.project.findMany.mockResolvedValue([]);
    await getProjectsPage();
    expect(db.project.findMany.mock.calls[0][0].where.deletedAt).toBeNull();
  });

  it("applies the search filter on name + description", async () => {
    db.project.findMany.mockResolvedValue([]);
    await getProjectsPage({ search: "Apollo" });
    const call = db.project.findMany.mock.calls[0][0];
    expect(call.where.OR).toEqual([
      { name: { contains: "apollo", mode: "insensitive" } },
      { description: { contains: "apollo", mode: "insensitive" } },
    ]);
  });

  it("scopes projects to the caller's own set for MEMBER/MANAGER (F-03)", async () => {
    getSessionMock.mockResolvedValue(MEMBER_AUTH);
    db.project.findMany.mockImplementation(({ where }: { where?: { ownerUserId?: string } }) =>
      Promise.resolve(where?.ownerUserId ? [{ id: "p-owned" }] : []));
    await getProjectsPage();
    const call = db.project.findMany.mock.calls.at(-1)![0];
    expect(call.where.id).toEqual({ in: ["p-owned"] });
  });

  it("passes the status filter through", async () => {
    db.project.findMany.mockResolvedValue([]);
    await getProjectsPage({ status: "ENDED" });
    expect(db.project.findMany.mock.calls[0][0].where.status).toBe("ENDED");
  });
});

describe("L-P0-9 getTimeEntriesPage (cursor pagination + search + filters)", () => {
  it("returns a paginated page", async () => {
    db.timeEntry.findMany.mockResolvedValue(mockRows(11, {
      projectId: "p-1", memberId: "m-1", date: new Date("2026-01-01"),
      hours: 4, description: "work", project: { name: "P1" }, member: { name: "M1" },
    }));
    const res = await getTimeEntriesPage({ limit: 10 });
    if (!res.ok) throw new Error("expected ok");
    expect(res.data.items.length).toBe(10);
    expect(res.data.hasMore).toBe(true);
  });

  it("applies the soft-delete filter on the project relation — L-P0-14", async () => {
    db.timeEntry.findMany.mockResolvedValue([]);
    await getTimeEntriesPage();
    expect(db.timeEntry.findMany.mock.calls[0][0].where.project).toEqual({ deletedAt: null });
  });

  it("applies the search filter on description", async () => {
    db.timeEntry.findMany.mockResolvedValue([]);
    await getTimeEntriesPage({ search: "deploy" });
    expect(db.timeEntry.findMany.mock.calls[0][0].where.description).toEqual({ contains: "deploy", mode: "insensitive" });
  });

  it("passes projectId and memberId filters through (ADMIN — no scope)", async () => {
    // ADMIN is unscoped, so the caller's memberId filter is honoured directly.
    db.timeEntry.findMany.mockResolvedValue([]);
    await getTimeEntriesPage({ projectId: "p-1", memberId: "m-1" });
    const call = db.timeEntry.findMany.mock.calls[0][0];
    expect(call.where.projectId).toBe("p-1");
    expect(call.where.memberId).toBe("m-1");
  });

  // PR-53 — getTimeEntriesPage now mirrors the dashboard's member-visibility
  // rule (scoped users see entries only for members they can already see),
  // not the old project-centric rule. This closes a leak where a non-visible
  // member's entry on a visible project was returned with that member's name.
  it("scopes time entries to visible members for MEMBER/MANAGER (PR-53)", async () => {
    getSessionMock.mockResolvedValue(MEMBER_AUTH);
    // getScopedProjectIds: MEMBER owns "p-owned".
    db.project.findMany.mockImplementation(({ where }: { where?: { ownerUserId?: string } }) =>
      Promise.resolve(where?.ownerUserId ? [{ id: "p-owned" }] : []));
    // getVisibleMemberIds: the viewer's own TeamMember row is visible
    // (always included via { userId: auth.userId }). A second member "m-x"
    // is also visible (e.g. staffed on the same project). A third "m-hidden"
    // is NOT returned by the mock → not in the visible set.
    db.teamMember.findMany.mockResolvedValue([{ id: "m-mem" }, { id: "m-x" }]);
    db.timeEntry.findMany.mockResolvedValue([]);
    await getTimeEntriesPage();
    const call = db.timeEntry.findMany.mock.calls[0][0];
    // Member-visibility scope: memberId IN the visible set, NOT the old
    // project-centric OR clause.
    expect(call.where.memberId).toEqual({ in: ["m-mem", "m-x"] });
    expect(call.where).not.toHaveProperty("OR");
  });

  it("does NOT scope time entries for ADMIN (PR-53)", async () => {
    // ADMIN is unscoped — no memberId filter unless the caller provides one.
    db.timeEntry.findMany.mockResolvedValue([]);
    await getTimeEntriesPage();
    const call = db.timeEntry.findMany.mock.calls[0][0];
    expect(call.where).not.toHaveProperty("memberId");
    expect(call.where).not.toHaveProperty("OR");
  });

  it("scoped user requesting a NON-visible memberId → empty page (PR-53 leak fix)", async () => {
    // The old code let any signed-in MEMBER pass memberId: "m-x" and read
    // that member's entries — the caller filter overwrote the scope. Now
    // the filter is intersected with the visible set: a memberId outside
    // the set yields an empty page, not a leak.
    getSessionMock.mockResolvedValue(MEMBER_AUTH);
    db.project.findMany.mockImplementation(({ where }: { where?: { ownerUserId?: string } }) =>
      Promise.resolve(where?.ownerUserId ? [{ id: "p-owned" }] : []));
    db.teamMember.findMany.mockResolvedValue([{ id: "m-mem" }]); // only self visible
    db.timeEntry.findMany.mockResolvedValue([{ id: "leaked", memberId: "m-hidden" }]);
    const res = await getTimeEntriesPage({ memberId: "m-hidden" });
    if (!res.ok) throw new Error("expected ok");
    expect(res.data.items).toEqual([]);
    expect(res.data.hasMore).toBe(false);
    // Crucially, the DB was never queried with the leaked memberId.
    expect(db.timeEntry.findMany).not.toHaveBeenCalled();
  });

  it("scoped user requesting their OWN memberId → filtered to just them (PR-53)", async () => {
    getSessionMock.mockResolvedValue(MEMBER_AUTH);
    db.project.findMany.mockImplementation(({ where }: { where?: { ownerUserId?: string } }) =>
      Promise.resolve(where?.ownerUserId ? [{ id: "p-owned" }] : []));
    db.teamMember.findMany.mockResolvedValue([{ id: "m-mem" }, { id: "m-x" }]);
    db.timeEntry.findMany.mockResolvedValue([]);
    await getTimeEntriesPage({ memberId: "m-mem" });
    const call = db.timeEntry.findMany.mock.calls[0][0];
    // Visible + requested → honoured as a scalar (not an IN clause).
    expect(call.where.memberId).toBe("m-mem");
  });

  it("scoped user requesting a visible-but-not-self memberId → honoured (PR-53)", async () => {
    // A MEMBER can legitimately filter to a teammate they can see (e.g. to
    // review a colleague's logged time on a shared project).
    getSessionMock.mockResolvedValue(MEMBER_AUTH);
    db.project.findMany.mockImplementation(({ where }: { where?: { ownerUserId?: string } }) =>
      Promise.resolve(where?.ownerUserId ? [{ id: "p-owned" }] : []));
    db.teamMember.findMany.mockResolvedValue([{ id: "m-mem" }, { id: "m-x" }]);
    db.timeEntry.findMany.mockResolvedValue([]);
    await getTimeEntriesPage({ memberId: "m-x" });
    const call = db.timeEntry.findMany.mock.calls[0][0];
    expect(call.where.memberId).toBe("m-x");
  });

  it("scoped user with no projects → only own member row visible (PR-53)", async () => {
    // Edge case: a MEMBER with no project associations. getScopedProjectIds
    // returns an empty Set; getVisibleMemberIds falls back to the viewer's
    // own TeamMember row only.
    getSessionMock.mockResolvedValue(MEMBER_AUTH);
    db.project.findMany.mockResolvedValue([]); // owns nothing
    db.teamMember.findUnique.mockResolvedValue({ id: "m-mem" });
    db.timeEntry.findMany.mockResolvedValue([]);
    await getTimeEntriesPage();
    const call = db.timeEntry.findMany.mock.calls[0][0];
    expect(call.where.memberId).toEqual({ in: ["m-mem"] });
  });
});
