import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// PR-63 — getAnalyticsData authorization matrix + payload shape.
//
//   • MEMBER / HR — forced to "self" whatever they ask for.
//   • MANAGER — self / own team / subtree individuals allowed; "everyone"
//     and other managers' teams rejected.
//   • ADMIN — every scope; "everyone" = whole roster.
//
// The payload carries only in-scope rows (members, their time entries, the
// projects those entries reference) plus the filter options the caller is
// allowed to pick.
// ---------------------------------------------------------------------------

const { db, getBetterSession } = vi.hoisted(() => {
  const getBetterSession = vi.fn();
  const models = ["user", "teamMember", "timeEntry", "project"];
  const methods = ["findMany", "findUnique", "findFirst", "create", "update", "delete", "count"];
  const db: Record<string, Record<string, ReturnType<typeof vi.fn>>> = {};
  for (const m of models) {
    db[m] = {};
    for (const meth of methods) db[m][meth] = vi.fn();
  }
  return { db, getBetterSession };
});

vi.mock("@/lib/auth/auth-better", () => ({ getBetterSession, revokeUserSessions: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/infra/db", () => ({ db }));

import { getAnalyticsData } from "@/server-actions/data";
import type { ActionResult } from "@/lib/action-result";

const ADMIN = { userId: "u-ada", name: "Ada", email: "ada@fernly.dev", role: "ADMIN" as string };
const MANAGER = { userId: "u-max", name: "Max", email: "max@fernly.dev", role: "MANAGER" as string };
const MEMBER = { userId: "u-mia", name: "Mia", email: "mia@fernly.dev", role: "MEMBER" as string };
const HR = { userId: "u-hana", name: "Hana", email: "hana@fernly.dev", role: "HR" as string };

function signIn(user: { userId: string; name: string; email: string; role: string } | null) {
  getBetterSession.mockResolvedValue(
    user ? { userId: user.userId, name: user.name, email: user.email, role: user.role } : null,
  );
}

function expectErr(r: ActionResult<unknown>, matcher?: RegExp) {
  expect(r.ok).toBe(false);
  if (!r.ok && matcher) expect(r.error).toMatch(matcher);
}

/** teamMember rows keyed by userId (the roster). */
const ROSTER = [
  { id: "m-ada", name: "Ada", role: "ADMIN", department: "ENGINEERING", email: "ada@fernly.dev", avatarColor: "forest", online: true, openTasks: 0, completedTasks: 9, workload: 10, userId: "u-ada", createdAt: new Date(), updatedAt: new Date() },
  { id: "m-max", name: "Max", role: "MANAGER", department: "ENGINEERING", email: "max@fernly.dev", avatarColor: "ocean", online: true, openTasks: 1, completedTasks: 7, workload: 30, userId: "u-max", createdAt: new Date(), updatedAt: new Date() },
  { id: "m-rex", name: "Rex", role: "MEMBER", department: "DESIGN", email: "rex@fernly.dev", avatarColor: "ember", online: false, openTasks: 2, completedTasks: 5, workload: 50, userId: "u-report", createdAt: new Date(), updatedAt: new Date() },
  { id: "m-mia", name: "Mia", role: "MEMBER", department: "ENGINEERING", email: "mia@fernly.dev", avatarColor: "plum", online: false, openTasks: 3, completedTasks: 4, workload: 60, userId: "u-mia", createdAt: new Date(), updatedAt: new Date() },
];

const ALL_USERS = [
  { id: "u-ada", name: "Ada", role: "ADMIN", deletedAt: null },
  { id: "u-max", name: "Max", role: "MANAGER", deletedAt: null },
  { id: "u-report", name: "Rex", role: "MEMBER", deletedAt: null },
  { id: "u-mia", name: "Mia", role: "MEMBER", deletedAt: null },
];

const NOW = new Date("2026-11-01T10:00:00Z");

beforeEach(() => {
  vi.clearAllMocks();
  signIn(ADMIN);
  // Roster lookups: dispatch on where.userId?.in / where.deletedAt.
  db.teamMember.findMany.mockImplementation(
    async ({ where }: { where?: { userId?: { in: string[] }; deletedAt?: null } }) => {
      const ids = where?.userId?.in;
      return Promise.resolve(ids ? ROSTER.filter((m) => ids.includes(m.userId!)) : ROSTER);
    },
  );
  // Time entries per member id.
  db.timeEntry.findMany.mockImplementation(
    async ({ where }: { where?: { memberId?: { in: string[] } } }) => {
      const ids = where?.memberId?.in ?? [];
      const rows = [
        { id: "e1", projectId: "p-1", memberId: "m-rex", taskId: null, date: NOW, hours: 3, description: "" },
        { id: "e2", projectId: "p-1", memberId: "m-mia", taskId: null, date: NOW, hours: 2, description: "" },
        { id: "e3", projectId: "p-2", memberId: "m-ada", taskId: null, date: NOW, hours: 1, description: "" },
      ];
      return Promise.resolve(rows.filter((r) => ids.includes(r.memberId)));
    },
  );
  db.project.findMany.mockImplementation(
    async ({ where }: { where?: { id?: { in: string[] } } }) => {
      const all = [
        { id: "p-1", name: "Apollo", color: "forest" },
        { id: "p-2", name: "Borealis", color: "ocean" },
      ];
      const ids = where?.id?.in;
      return Promise.resolve(ids ? all.filter((p) => ids.includes(p.id)) : all);
    },
  );
  // Users: filter options (admin: all; manager: subtree minus self) and the
  // hierarchy BFS (getSubtreeUserIds) both land here — dispatch on intent.
  db.user.findMany.mockImplementation(
    async ({ where }: { where?: { managerId?: string; id?: { in: string[] }; deletedAt?: null } }) => {
      if (where?.managerId) {
        // Hierarchy BFS — u-max manages u-report (and nobody else manages).
        return Promise.resolve(where.managerId === "u-max" ? [{ id: "u-report" }] : []);
      }
      const ids = where?.id?.in;
      return Promise.resolve(
        ALL_USERS.filter((u) => u.deletedAt === null && (!ids || ids.includes(u.id)))
          .map(({ id, name, role }) => ({ id, name, role })),
      );
    },
  );
});

describe("getAnalyticsData: authorization matrix", () => {
  it("MEMBER is forced to self even when asking for someone else / everyone", async () => {
    signIn(MEMBER);
    const r = await getAnalyticsData({ kind: "everyone" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.scope).toEqual({ kind: "self" });
      expect(r.data.members.map((m) => m.name)).toEqual(["Mia"]);
    }
    // Same for an explicit other-person scope.
    const r2 = await getAnalyticsData({ kind: "user", userId: "u-report" });
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.data.scope).toEqual({ kind: "self" });
  });

  it("HR is forced to self too (no team powers)", async () => {
    signIn(HR);
    const r = await getAnalyticsData({ kind: "team", managerId: "u-max" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.scope).toEqual({ kind: "self" });
  });

  it("MANAGER defaults to self; may view their own team", async () => {
    signIn(MANAGER);
    const r = await getAnalyticsData({ kind: "team", managerId: "u-max" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.scope).toEqual({ kind: "team", managerId: "u-max" });
      // Subtree = u-max + u-report.
      expect(r.data.members.map((m) => m.name).sort()).toEqual(["Max", "Rex"]);
    }
  });

  it("MANAGER may view an individual inside their subtree", async () => {
    signIn(MANAGER);
    const r = await getAnalyticsData({ kind: "user", userId: "u-report" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.scope).toEqual({ kind: "user", userId: "u-report" });
      expect(r.data.members.map((m) => m.name)).toEqual(["Rex"]);
    }
  });

  it("MANAGER is rejected for 'everyone', another manager's team, and outsiders", async () => {
    signIn(MANAGER);
    expectErr(await getAnalyticsData({ kind: "everyone" }), /Only admins/i);
    expectErr(await getAnalyticsData({ kind: "team", managerId: "u-other" }), /own team/i);
    expectErr(await getAnalyticsData({ kind: "user", userId: "u-mia" }), /yourself and your team/i);
  });

  it("ADMIN may view everyone, any manager's team, and any individual", async () => {
    signIn(ADMIN);
    const everyone = await getAnalyticsData({ kind: "everyone" });
    expect(everyone.ok).toBe(true);
    if (everyone.ok) {
      expect(everyone.data.members).toHaveLength(ROSTER.length);
      expect(everyone.data.timeEntries).toHaveLength(3);
    }
    const team = await getAnalyticsData({ kind: "team", managerId: "u-max" });
    expect(team.ok).toBe(true);
    const person = await getAnalyticsData({ kind: "user", userId: "u-mia" });
    expect(person.ok).toBe(true);
    if (person.ok) expect(person.data.members.map((m) => m.name)).toEqual(["Mia"]);
  });

  it("anonymous callers are rejected", async () => {
    signIn(null);
    expectErr(await getAnalyticsData(), /signed in/i);
  });
});

describe("getAnalyticsData: payload shape", () => {
  it("returns only the entries of in-scope members + the projects they reference", async () => {
    signIn(MANAGER);
    const r = await getAnalyticsData({ kind: "team", managerId: "u-max" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      // Max has no entries; Rex logged 3h on p-1.
      expect(r.data.timeEntries).toHaveLength(1);
      expect(r.data.timeEntries[0].hours).toBe(3);
      expect(r.data.timeEntries[0].date).toBe(NOW.toISOString());
      expect(r.data.projects.map((p) => p.name)).toEqual(["Apollo"]);
    }
  });

  it("ADMIN filter options: everyone + managers as teams + all people", async () => {
    signIn(ADMIN);
    const r = await getAnalyticsData({ kind: "self" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.filter.showEveryone).toBe(true);
      expect(r.data.filter.teams).toEqual([{ managerId: "u-max", name: "Max" }]);
      expect(r.data.filter.people.map((p) => p.name)).toEqual(["Ada", "Max", "Rex", "Mia"]);
    }
  });

  it("MANAGER filter options: subtree people minus self, no Everyone, no teams", async () => {
    signIn(MANAGER);
    const r = await getAnalyticsData({ kind: "team", managerId: "u-max" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.filter.showEveryone).toBe(false);
      expect(r.data.filter.teams).toEqual([]);
      expect(r.data.filter.people).toEqual([{ userId: "u-report", name: "Rex", role: "MEMBER" }]);
    }
  });

  it("MEMBER filter options: empty (scope is fixed)", async () => {
    signIn(MEMBER);
    const r = await getAnalyticsData();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.filter).toEqual({ showEveryone: false, people: [], teams: [] });
    }
  });

  it("an empty roster yields empty data without entry/project queries", async () => {
    signIn(MEMBER);
    db.teamMember.findMany.mockResolvedValue([]);
    const r = await getAnalyticsData();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.members).toEqual([]);
      expect(r.data.timeEntries).toEqual([]);
      expect(r.data.projects).toEqual([]);
    }
    expect(db.timeEntry.findMany).not.toHaveBeenCalled();
  });
});
