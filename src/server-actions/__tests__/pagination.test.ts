import { describe, it, expect, vi, beforeEach } from "vitest";

// L-P0-9 — paginated list actions.

const db = vi.hoisted(() => {
  const models = ["user", "task", "project", "timeEntry"];
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
    await getUsersPage({ cursor: "id-99", limit: 10 });
    const call = db.user.findMany.mock.calls[0][0];
    expect(call.cursor).toEqual({ id: "id-99" });
    expect(call.skip).toBe(1);
    expect(call.take).toBe(11);
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
    expect(db.task.findMany.mock.calls[0][0].where.project).toEqual({ deletedAt: null });
  });

  it("applies the search filter on title + description", async () => {
    db.task.findMany.mockResolvedValue([]);
    await getTasksPage({ search: "login" });
    const call = db.task.findMany.mock.calls[0][0];
    expect(call.where.OR).toEqual([
      { title: { contains: "login", mode: "insensitive" } },
      { description: { contains: "login", mode: "insensitive" } },
    ]);
  });

  it("passes projectId and status filters through to the where clause", async () => {
    db.task.findMany.mockResolvedValue([]);
    await getTasksPage({ projectId: "p-1", status: "DONE" });
    const call = db.task.findMany.mock.calls[0][0];
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

  it("passes projectId and memberId filters through", async () => {
    db.timeEntry.findMany.mockResolvedValue([]);
    await getTimeEntriesPage({ projectId: "p-1", memberId: "m-1" });
    const call = db.timeEntry.findMany.mock.calls[0][0];
    expect(call.where.projectId).toBe("p-1");
    expect(call.where.memberId).toBe("m-1");
  });
});
